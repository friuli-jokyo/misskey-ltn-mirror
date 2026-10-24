/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import type { Config } from '@/config.js';
import { allowanceOf, statementShape, threadEventOf } from '../lib/explain.js';
import type { ModuleMetadata, Provider } from '@nestjs/common';
import type { TestingModule } from '@nestjs/testing';
import type * as Redis from 'ioredis';
import type { DataSource } from 'typeorm';
import type { ChildExpectation } from '../lib/children.js';
import type { CaptureFile, CapturedShape, CapturedStatement } from '../lib/explain.js';

type CapturingClient = { processID?: number; connectionParameters?: { statement_timeout?: unknown } };

let captureTag: string | null = null;

const activity = { inFlight: 0, lastAt: 0 };

export function emit(event: Record<string, unknown>): void {
	process.stdout.write(`${JSON.stringify(event)}\n`);
}

export function tagCapture(tag: string | null): void {
	captureTag = tag;
}

export function captureNow(): number {
	return Math.round(performance.timeOrigin + performance.now());
}

function portable(value: unknown): unknown {
	if (value instanceof Date) return value.toISOString();
	if (Buffer.isBuffer(value)) return `\\x${value.toString('hex')}`;
	if (Array.isArray(value)) return value.map(portable);
	return value;
}

async function installCapture(everything: boolean): Promise<() => void> {
	const { default: pg } = await import('pg');
	const name = (process.env.PGAPPNAME ?? 'mk-e2e-unknown').replace(/^mk-e2e-/, '');
	const runDir = process.env.MK_E2E_RUN_DIR;
	if (runDir == null) throw new Error('MK_E2E_RUN_DIR is not set');
	const dir = join(runDir, 'capture');
	mkdirSync(dir, { recursive: true });
	mkdirSync(join(runDir, 'threads'), { recursive: true });
	const threadsPath = join(runDir, 'threads', `${name}.jsonl`);
	const now = captureNow;
	const startedAt = now();
	const shapes = new Map<string, CapturedShape>();
	const widths = new Map<string, number>();
	const statements: CapturedStatement[] = [];
	const original = pg.Client.prototype.query;
	pg.Client.prototype.query = function (this: CapturingClient, config: unknown, values?: unknown, callback?: unknown) {
		const text = typeof config === 'string' ? config : (config as { text?: unknown } | null)?.text;
		if (typeof text !== 'string') return Reflect.apply(original, this, [config, values, callback]);
		const parameters = Array.isArray(values) ? values : (config as { values?: unknown } | null)?.values;
		const timeout = this.connectionParameters?.statement_timeout;
		const statement: CapturedStatement = { t: now(), tag: captureTag, text, values: Array.isArray(parameters) ? parameters.map(portable) : [], processId: this.processID ?? null, statementTimeout: timeout ? Number(timeout) : null };
		const key = statementShape(text);
		const shape = shapes.get(key) ?? { shape: key, count: 0, statementTimeouts: {}, samples: [], widest: null };
		shape.count++;
		shape.statementTimeouts[String(statement.statementTimeout ?? 'unset')] = (shape.statementTimeouts[String(statement.statementTimeout ?? 'unset')] ?? 0) + 1;
		if (shape.samples.length < 3) shape.samples.push(statement);
		const width = allowanceOf(statement.values).allowance;
		if (width > (widths.get(key) ?? 0)) {
			widths.set(key, width);
			shape.widest = statement;
		}
		shapes.set(key, shape);
		if (everything) statements.push(statement);
		const event = threadEventOf(text, statement.values);
		activity.inFlight++;
		activity.lastAt = statement.t;
		const settle = (rows: number | null, failed: boolean) => {
			activity.inFlight--;
			activity.lastAt = now();
			if (event != null) appendFileSync(threadsPath, `${JSON.stringify({ ...event, pid: statement.processId, start: statement.t, end: activity.lastAt, rows, failed })}\n`);
		};
		const result: unknown = Reflect.apply(original, this, [config, values, callback]);
		if (typeof (result as Promise<unknown> | null)?.then === 'function') {
			(result as Promise<{ rows?: unknown[] } | null>).then(value => settle(Array.isArray(value?.rows) ? value.rows.length : null, false), () => settle(null, true));
		} else {
			settle(null, false);
		}
		return result;
	} as typeof original;
	const flush = () => {
		const file: CaptureFile = { name, startedAt, flushedAt: now(), shapes: [...shapes.values()], statements: everything ? statements : null };
		writeFileSync(join(dir, `${name}.json`), JSON.stringify(file));
	};
	setInterval(flush, 2000).unref();
	process.on('exit', flush);
	return flush;
}

export async function settled(quietMs: number, timeoutMs: number): Promise<{ settledMs: number; inFlight: number }> {
	const begin = captureNow();
	while (activity.inFlight > 0 || captureNow() - activity.lastAt < quietMs) {
		if (captureNow() - begin > timeoutMs) break;
		await setTimeout(50);
	}
	return { settledMs: captureNow() - begin, inFlight: activity.inFlight };
}

export function installHandlers(): void {
	process.on('unhandledRejection', reason => {
		console.dir(reason);
		emit({ type: 'process-error', kind: 'unhandledRejection', message: String(reason), stack: reason instanceof Error ? reason.stack : null });
	});
	process.on('uncaughtException', err => {
		console.trace(err);
		emit({ type: 'process-error', kind: 'uncaughtException', message: String(err), stack: err.stack ?? null });
	});
	process.stdin.on('end', () => process.exit(1));
	process.stdin.resume();
}

export function expectation(): ChildExpectation {
	if (process.env.MK_E2E_EXPECT == null) throw new Error('MK_E2E_EXPECT is not set');
	return JSON.parse(process.env.MK_E2E_EXPECT) as ChildExpectation;
}

export async function loadGuardedConfig(): Promise<Config> {
	const expected = expectation();
	if (process.env.NODE_ENV !== 'production') throw new Error('NODE_ENV must be production');
	const { compiledConfigFilePath, loadConfig } = await import('@/config.js');
	if (compiledConfigFilePath !== join(expected.root, 'built', '.config.json')) throw new Error(`config root is ${compiledConfigFilePath}`);
	const config = loadConfig();
	if (config.db.host !== '127.0.0.1' || config.db.port !== expected.pgPort || !config.db.db.startsWith('misskey_migration_e2e') || config.db.db !== expected.database) {
		throw new Error(`the database of the config is ${config.db.host}:${config.db.port}/${config.db.db}`);
	}
	for (const redis of [config.redis, config.redisForPubsub, config.redisForJobQueue, config.redisForTimelines, config.redisForReactions]) {
		if (redis.host !== '127.0.0.1' || redis.port !== expected.redisPort) throw new Error(`a redis of the config is ${redis.host}:${redis.port}`);
	}
	if (config.meilisearch != null) throw new Error('the config has meilisearch');
	return config;
}

export async function assertDataSource(dataSource: DataSource): Promise<void> {
	const expected = expectation();
	const [row]: { cluster: string; database: string; port: number }[] = await dataSource.query('SELECT current_setting(\'cluster_name\') AS "cluster", current_database() AS "database", inet_server_port() AS "port"');
	if (row.cluster !== expected.clusterName || row.database !== expected.database || row.port !== expected.pgPort) throw new Error(`connected to ${JSON.stringify(row)}`);
	if (dataSource.options.synchronize || dataSource.options.dropSchema) throw new Error('the data source synchronizes or drops the schema');
}

export async function bootstrap(imports: NonNullable<ModuleMetadata['imports']>, providers: Provider[] = [], everything = false): Promise<TestingModule> {
	const { init } = await import('slacc');
	init(1);
	await loadGuardedConfig();
	await installCapture(everything);
	const { Test } = await import('@nestjs/testing');
	const { DI } = await import('@/di-symbols.js');
	const app = await Test.createTestingModule({ imports, providers }).compile();
	await app.init();
	for (const dataSource of [app.get<DataSource>(DI.db), app.get<DataSource>(DI.dbLong)]) await assertDataSource(dataSource);
	const info = await app.get<Redis.Redis>(DI.redis).info('server');
	const runId = /^run_id:(\w+)/m.exec(info)?.[1];
	if (runId == null || runId !== expectation().redisRunId) throw new Error(`redis run_id is ${runId}, not ${expectation().redisRunId}`);
	return app;
}
