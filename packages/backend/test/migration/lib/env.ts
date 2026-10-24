/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { setTimeout } from 'node:timers/promises';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const backendDir = fileURLToPath(new URL('../../../', import.meta.url));

export const repoDir = resolve(backendDir, '../..');

export type HarnessEnv = {
	dir: string;
	pgBin: string;
	pgVersion: string;
	pgPort: number;
	redisServer: string;
	redisVersion: string;
	redisPort: number;
	seed: number;
	scale: number;
	keep: boolean;
	queue: boolean;
	branch: boolean;
};

type Marker = {
	runId: string;
	pgPort: number;
	redisPort: number;
	owner?: { pid: number; started: string };
	pgPid?: number;
	redisPid?: number;
};

export type Run = {
	id: string;
	dir: string;
	marker: Marker;
	path: (...parts: string[]) => string;
	saveMarker: () => void;
};

const markerName = 'misskey-migration-e2e.json';

const preconditions = 'Preconditions: Node 26 (nvm use 26.12.1), the workspace built once, PostgreSQL 18 binaries (MISSKEY_MIGRATION_E2E_PG_BIN), redis-server (MISSKEY_MIGRATION_E2E_REDIS_SERVER) and about 6 GB of free disk in MISSKEY_MIGRATION_E2E_DIR.';

function refuse(message: string): never {
	throw new Error(`${message} ${preconditions}`);
}

function onPath(command: string): string | null {
	for (const dir of (process.env.PATH ?? '').split(delimiter)) {
		if (dir !== '' && existsSync(join(dir, command))) return join(dir, command);
	}
	return null;
}

function integer(name: string, fallback: number): number {
	const value = process.env[name];
	if (value == null || value === '') return fallback;
	if (!/^\d+$/.test(value)) refuse(`${name}=${value} is not a non-negative integer.`);
	return Number(value);
}

async function listening(host: string, port: number): Promise<boolean> {
	return await new Promise(resolvePromise => {
		const socket = new Socket();
		const done = (result: boolean) => {
			socket.destroy();
			resolvePromise(result);
		};
		socket.setTimeout(1000);
		socket.once('connect', () => done(true));
		socket.once('timeout', () => done(true));
		socket.once('error', (e: NodeJS.ErrnoException) => done(!['ECONNREFUSED', 'EADDRNOTAVAIL', 'EAFNOSUPPORT', 'ENETUNREACH', 'EHOSTUNREACH'].includes(e.code ?? '')));
		socket.connect(port, host);
	});
}

async function assertFree(name: string, port: number): Promise<void> {
	for (const host of ['127.0.0.1', '::1']) {
		if (await listening(host, port)) refuse(`Something listens on ${host}:${port} (${name}); choose another port.`);
	}
}

export async function loadEnv(): Promise<HarnessEnv> {
	const requested = resolve(process.env.MISSKEY_MIGRATION_E2E_DIR ?? join(tmpdir(), 'misskey-migration-e2e'));
	mkdirSync(requested, { recursive: true });
	const dir = realpathSync(requested);

	const pgCtl = process.env.MISSKEY_MIGRATION_E2E_PG_BIN != null ? join(process.env.MISSKEY_MIGRATION_E2E_PG_BIN, 'pg_ctl') : onPath('pg_ctl');
	if (pgCtl == null) refuse('pg_ctl is not on PATH and MISSKEY_MIGRATION_E2E_PG_BIN is not set.');
	const pgBin = dirname(pgCtl);
	for (const binary of ['initdb', 'pg_ctl', 'postgres']) {
		if (!existsSync(join(pgBin, binary))) refuse(`${join(pgBin, binary)} does not exist.`);
	}
	const pgVersion = execFileSync(join(pgBin, 'postgres'), ['--version'], { encoding: 'utf-8' }).trim();
	if (!/ 18\.\d+/.test(pgVersion)) refuse(`${pgVersion} is not PostgreSQL 18.`);

	const redisServer = process.env.MISSKEY_MIGRATION_E2E_REDIS_SERVER ?? onPath('redis-server');
	if (redisServer == null || !existsSync(redisServer)) refuse('redis-server is not on PATH and MISSKEY_MIGRATION_E2E_REDIS_SERVER is not set.');
	const redisVersion = execFileSync(redisServer, ['--version'], { encoding: 'utf-8' }).trim();

	const pgPort = integer('MISSKEY_MIGRATION_E2E_PG_PORT', 55437);
	const redisPort = integer('MISSKEY_MIGRATION_E2E_REDIS_PORT', 56437);
	if (pgPort === 5432 || pgPort === 55434) refuse(`MISSKEY_MIGRATION_E2E_PG_PORT=${pgPort} belongs to another database.`);
	if (redisPort === 6379) refuse('MISSKEY_MIGRATION_E2E_REDIS_PORT=6379 belongs to another Redis.');
	if (pgPort === redisPort) refuse('MISSKEY_MIGRATION_E2E_PG_PORT and MISSKEY_MIGRATION_E2E_REDIS_PORT are the same.');

	await stopStaleRuns(dir, pgBin);
	await assertFree('MISSKEY_MIGRATION_E2E_PG_PORT', pgPort);
	await assertFree('MISSKEY_MIGRATION_E2E_REDIS_PORT', redisPort);

	return {
		dir,
		pgBin,
		pgVersion,
		pgPort,
		redisServer,
		redisVersion,
		redisPort,
		seed: integer('MISSKEY_MIGRATION_E2E_SEED', randomBytes(4).readUInt32LE()),
		scale: Math.max(1, integer('MISSKEY_MIGRATION_E2E_SCALE', 1)),
		keep: process.env.MISSKEY_MIGRATION_E2E_KEEP === '1',
		queue: integer('MISSKEY_MIGRATION_E2E_QUEUE', 1) !== 0,
		branch: integer('MISSKEY_MIGRATION_E2E_BRANCH', 1) !== 0,
	};
}

function alive(pid: number | undefined): pid is number {
	if (pid == null) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function command(pid: number): string {
	try {
		return execFileSync('ps', ['-o', 'command=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
	} catch {
		return '';
	}
}

function startedAt(pid: number): string {
	try {
		return execFileSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf-8' }).trim();
	} catch {
		return '';
	}
}

function readMarker(runDir: string): Marker | null {
	const path = join(runDir, markerName);
	if (!statSync(runDir).isDirectory() || !existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf-8')) as Marker;
}

function postgresOf(marker: Marker, runDir: string): number | null {
	return alive(marker.pgPid) && command(marker.pgPid).endsWith(`postgres -D ${join(runDir, 'pg')}`) ? marker.pgPid : null;
}

function redisOf(marker: Marker): number | null {
	return alive(marker.redisPid) && command(marker.redisPid).includes('redis-server') && command(marker.redisPid).includes(`:${marker.redisPort}`) ? marker.redisPid : null;
}

export function discardRun(runDir: string, everything: boolean): void {
	const marker = readMarker(runDir);
	const postgres = marker != null && postgresOf(marker, runDir) != null;
	const redis = marker != null && redisOf(marker) != null;
	if (everything && !postgres && !redis) {
		rmSync(runDir, { recursive: true, force: true });
		return;
	}
	if (!postgres && existsSync(join(runDir, 'pg', 'log')) && !existsSync(join(runDir, 'pglog'))) renameSync(join(runDir, 'pg', 'log'), join(runDir, 'pglog'));
	for (const [sub, running] of [['pg', postgres], ['redis', redis], ['root', false]] as const) {
		if (!running) rmSync(join(runDir, sub), { recursive: true, force: true });
	}
}

async function stopStaleRuns(dir: string, pgBin: string): Promise<void> {
	const runs = readdirSync(dir).flatMap(name => {
		const marker = readMarker(join(dir, name));
		return marker != null ? [{ runDir: join(dir, name), marker }] : [];
	});
	for (const { marker } of runs) {
		if (marker.owner != null && alive(marker.owner.pid) && startedAt(marker.owner.pid) === marker.owner.started) refuse(`Another run (${marker.runId}, process ${marker.owner.pid}) is still running in ${dir}; wait for it or set another MISSKEY_MIGRATION_E2E_DIR.`);
	}
	for (const { runDir, marker } of runs) {
		if (postgresOf(marker, runDir) != null) execFileSync(join(pgBin, 'pg_ctl'), ['-D', join(runDir, 'pg'), '-m', 'fast', '-w', 'stop'], { stdio: 'ignore' });
		const redis = redisOf(marker);
		if (redis != null) {
			process.kill(redis, 'SIGTERM');
			for (let i = 0; i < 100 && alive(redis); i++) await setTimeout(100);
		}
		discardRun(runDir, false);
		const { pgPid, redisPid, ...rest } = marker;
		if (pgPid != null || redisPid != null) writeFileSync(join(runDir, markerName), JSON.stringify(rest, null, '\t'));
	}
}

function timestamp(date: Date): string {
	return date.toISOString().replace(/[-:T]/g, '').slice(0, 14);
}

export function createRun(env: HarnessEnv): Run {
	const id = `${timestamp(new Date())}-${randomBytes(3).toString('hex')}`;
	const dir = join(env.dir, id);
	mkdirSync(dir, { recursive: true });
	const marker: Marker = { runId: id, pgPort: env.pgPort, redisPort: env.redisPort, owner: { pid: process.pid, started: startedAt(process.pid) } };
	const saveMarker = () => writeFileSync(join(dir, markerName), JSON.stringify(marker, null, '\t'));
	saveMarker();
	for (const sub of ['logs', 'artifacts', 'oplog']) mkdirSync(join(dir, sub), { recursive: true });
	return { id, dir, marker, path: (...parts) => join(dir, ...parts), saveMarker };
}
