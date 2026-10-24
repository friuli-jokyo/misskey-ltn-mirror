/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { backendDir } from './env.js';
import type { Run } from './env.js';

export type ChildExpectation = {
	root: string;
	pgPort: number;
	database: string;
	clusterName: string;
	redisPort: number;
	redisRunId: string | null;
};

export type ChildEvent = { type: string; t: number } & Record<string, unknown>;

export type LogLine = { t: number; child: string; level: string | null; line: string };

type ChildOptions = {
	role: string;
	entry?: string;
	args?: string[];
	env?: Record<string, string>;
	expect: ChildExpectation;
};

const generations = new Map<string, number>();

const levels = ['ERR ', 'WARN', 'DONE', 'INFO', 'VERB'];

function parseEvent(line: string): ChildEvent | null {
	if (!line.startsWith('{')) return null;
	try {
		const value = JSON.parse(line) as unknown;
		if (value == null || typeof value !== 'object' || typeof (value as { type?: unknown }).type !== 'string') return null;
		return { ...(value as ChildEvent), t: Date.now() };
	} catch {
		return null;
	}
}

export class Child {
	public readonly name: string;
	public readonly role: string;
	public readonly logPath: string;
	public readonly events: ChildEvent[] = [];
	public readonly problems: LogLine[] = [];
	public readonly exited: Promise<number | null>;
	public readonly startedAt = Date.now();
	public exitedAt: number | null = null;
	public killedAt: number | null = null;
	private readonly process: ChildProcess;
	private readonly listeners = new Set<(event: ChildEvent) => void>();
	private readonly lineListeners = new Set<(line: LogLine) => void>();

	constructor(run: Run, bundleDir: string, options: ChildOptions) {
		const gen = (generations.get(options.role) ?? 0) + 1;
		generations.set(options.role, gen);
		this.role = options.role;
		this.name = `${options.role}-${gen}`;
		this.logPath = run.path('logs', `${this.name}.log`);
		const log = createWriteStream(this.logPath);
		this.process = spawn(process.execPath, ['--enable-source-maps', join(bundleDir, `${options.entry ?? options.role}.js`), ...(options.args ?? [])], {
			cwd: backendDir,
			env: {
				PATH: process.env.PATH ?? '',
				HOME: process.env.HOME ?? '',
				...(process.env.TMPDIR != null ? { TMPDIR: process.env.TMPDIR } : {}),
				NODE_ENV: 'production',
				FORCE_COLOR: '0',
				PGAPPNAME: `mk-e2e-${this.name}`,
				MK_E2E_EXPECT: JSON.stringify(options.expect),
				MK_E2E_RUN_DIR: run.dir,
				...options.env,
			},
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		this.process.stdin?.on('error', () => {});
		this.process.stderr?.on('data', (chunk: Buffer) => log.write(chunk));
		const lines = createInterface({ input: this.process.stdout! });
		lines.on('line', line => {
			const event = parseEvent(line);
			if (event == null) {
				const t = Date.now();
				log.write(`${new Date(t).toISOString()} ${line}\n`);
				const level = levels.find(label => line.startsWith(label)) ?? null;
				const logLine = { t, child: this.name, level, line };
				if (level === 'ERR ' || level === 'WARN') this.problems.push(logLine);
				for (const listener of this.lineListeners) listener(logLine);
				return;
			}
			this.events.push(event);
			for (const listener of this.listeners) listener(event);
		});
		this.exited = new Promise(resolve => {
			this.process.once('close', code => {
				this.exitedAt = Date.now();
				log.end();
				resolve(code);
			});
		});
	}

	public get pid(): number | undefined {
		return this.process.pid;
	}

	public get alive(): boolean {
		return this.exitedAt == null;
	}

	public get ready(): boolean {
		return this.alive && this.events.some(event => event.type === 'ready');
	}

	public kill(signal: NodeJS.Signals): void {
		if (!this.alive) return;
		this.killedAt ??= Date.now();
		this.process.kill(signal);
	}

	public send(line: string): void {
		if (this.alive) this.process.stdin?.write(`${line}\n`);
	}

	public onEvent(listener: (event: ChildEvent) => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	public onLine(listener: (line: LogLine) => void): () => void {
		this.lineListeners.add(listener);
		return () => this.lineListeners.delete(listener);
	}

	public async waitFor(predicate: (event: ChildEvent) => boolean, timeoutMs: number, after = 0): Promise<ChildEvent> {
		const found = this.events.find(event => event.t >= after && predicate(event));
		if (found != null) return found;
		return await new Promise((resolve, reject) => {
			const timer = setTimeout(() => finish(new Error(`${this.name}: timed out after ${timeoutMs} ms (see ${this.logPath})`)), timeoutMs);
			const listener = (event: ChildEvent) => {
				if (predicate(event)) finish(null, event);
			};
			const finish = (error: Error | null, event?: ChildEvent) => {
				clearTimeout(timer);
				this.listeners.delete(listener);
				if (error != null) reject(error);
				else resolve(event!);
			};
			this.listeners.add(listener);
			void this.exited.then(code => finish(new Error(`${this.name} exited with code ${code} (see ${this.logPath}): ${this.events.filter(event => event.type === 'error').map(event => String(event.message)).join('; ')}`)));
		});
	}
}
