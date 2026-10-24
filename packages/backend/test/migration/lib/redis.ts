/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { setTimeout } from 'node:timers/promises';
import * as Redis from 'ioredis';
import type { HarnessEnv, Run } from './env.js';

export type RedisLoss = { killedAt: number; readyAt: number; downMs: number; runId: string };

export class RedisServer {
	public runId: string | null = null;
	public readonly losses: RedisLoss[] = [];
	public up: Promise<void> = Promise.resolve();
	private process: ChildProcess | null = null;
	private exited: Promise<void> | null = null;
	private readonly dir: string;

	constructor(private env: HarnessEnv, private run: Run) {
		this.dir = run.path('redis');
	}

	public get port(): number {
		return this.env.redisPort;
	}

	public async info(): Promise<Record<string, string>> {
		const client = new Redis.Redis({ host: '127.0.0.1', port: this.port, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
		client.on('error', () => {});
		try {
			await client.connect();
			const text = await client.info('server');
			return Object.fromEntries(text.split(/\r?\n/).filter(line => line.includes(':')).map(line => [line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]));
		} finally {
			client.disconnect();
		}
	}

	public async flushAll(): Promise<void> {
		const client = new Redis.Redis({ host: '127.0.0.1', port: this.port, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
		client.on('error', () => {});
		try {
			await client.connect();
			await client.flushall();
		} finally {
			client.disconnect();
		}
	}

	public async keys(pattern: string): Promise<string[]> {
		const client = new Redis.Redis({ host: '127.0.0.1', port: this.port, lazyConnect: true, maxRetriesPerRequest: 0, enableOfflineQueue: false, retryStrategy: () => null });
		client.on('error', () => {});
		try {
			await client.connect();
			return (await client.keys(pattern)).sort();
		} finally {
			client.disconnect();
		}
	}

	public async start(): Promise<void> {
		mkdirSync(this.dir, { recursive: true });
		const child = spawn(this.env.redisServer, ['--port', String(this.port), '--bind', '127.0.0.1', '--save', '', '--appendonly', 'no', '--dir', this.dir, '--protected-mode', 'yes', '--logfile', `${this.dir}/redis.log`], { stdio: 'ignore' });
		this.process = child;
		this.exited = new Promise(resolve => child.once('exit', () => resolve()));
		this.run.marker.redisPid = child.pid;
		this.run.saveMarker();
		for (let i = 0; ; i++) {
			try {
				const info = await this.info();
				if (info.process_id !== String(child.pid)) throw new Error(`redis on port ${this.port} is process ${info.process_id}, not ${child.pid}`);
				this.runId = info.run_id;
				return;
			} catch (e) {
				if (i >= 100 || child.exitCode != null) throw e;
				await setTimeout(100);
			}
		}
	}

	public async kill(signal: NodeJS.Signals): Promise<void> {
		if (this.process == null) return;
		this.process.kill(signal);
		await this.exited;
		this.process = null;
		this.runId = null;
		delete this.run.marker.redisPid;
		this.run.saveMarker();
	}

	public async stop(): Promise<void> {
		await this.kill('SIGTERM');
	}

	public async lose(downMs: number): Promise<RedisLoss> {
		let restored = () => {};
		this.up = new Promise(resolve => { restored = resolve; });
		const killedAt = Date.now();
		try {
			await this.kill('SIGKILL');
			await setTimeout(downMs);
			await this.start();
		} finally {
			restored();
		}
		const loss = { killedAt, readyAt: Date.now(), downMs, runId: this.runId! };
		this.losses.push(loss);
		return loss;
	}
}
