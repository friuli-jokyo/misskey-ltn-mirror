/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import * as Bull from 'bullmq';
import { GlobalModule } from '@/GlobalModule.js';
import { LoggerService } from '@/core/LoggerService.js';
import { QueueModule } from '@/core/QueueModule.js';
import { QueueService } from '@/core/QueueService.js';
import { DI } from '@/di-symbols.js';
import { QUEUE, baseWorkerOptions } from '@/queue/const.js';
import type { Config } from '@/config.js';
import type { SystemQueue } from '@/core/QueueModule.js';

describe('QueueService', () => {
	const startupJobId = 'partitionMigration-startup';
	const interval = 5 * 60 * 1000;
	const services: QueueService[] = [];
	let app: TestingModule;
	let config: Config;
	let systemQueue: SystemQueue;

	function start(): QueueService {
		const service = new QueueService(
			config,
			systemQueue,
			app.get('queue:endedPollNotification'),
			app.get('queue:postScheduledNote'),
			app.get('queue:deliver'),
			app.get('queue:inbox'),
			app.get('queue:db'),
			app.get('queue:relationship'),
			app.get('queue:objectStorage'),
			app.get('queue:userWebhookDeliver'),
			app.get('queue:systemWebhookDeliver'),
			new LoggerService(),
		);
		services.push(service);
		return service;
	}

	function registrations(service: QueueService) {
		return vi.spyOn(service as unknown as { registerJobSchedulers: (onlyStopped: boolean) => Promise<void> }, 'registerJobSchedulers');
	}

	async function nextRuns(): Promise<{ key: string; pattern: string | undefined; next: number | undefined; state: string; timestamp: number | undefined }[]> {
		const runs = await Promise.all((await systemQueue.getJobSchedulers()).map(async scheduler => {
			const id = `repeat:${scheduler.key}:${scheduler.next}`;
			return { key: scheduler.key, pattern: scheduler.pattern, next: scheduler.next, state: await systemQueue.getJobState(id), timestamp: (await systemQueue.getJob(id))?.timestamp };
		}));
		return runs.sort((a, b) => a.key.localeCompare(b.key));
	}

	async function loseRedisData(): Promise<void> {
		const client = await systemQueue.getBackend().client;
		let cursor = '0';
		do {
			const [next, keys] = await client.scan(cursor, { MATCH: `${systemQueue.qualifiedName}:*`, COUNT: 1000 });
			if (keys.length > 0) await client.del(...keys);
			cursor = next;
		} while (cursor !== '0');
	}

	async function pendingRuns(): Promise<{ id: string | undefined; timestamp: number; delay: number }[]> {
		const jobs = await systemQueue.getJobs(['waiting', 'prioritized', 'active']);
		return jobs.filter(job => job.name === 'partitionMigration' && job.id?.startsWith('repeat:') !== true).map(job => ({ id: job.id, timestamp: job.timestamp, delay: job.delay }));
	}

	async function waitUntil(condition: () => Promise<boolean>): Promise<void> {
		for (let i = 0; i < 200; i++) {
			if (await condition()) return;
			await setTimeout(50);
		}
		throw new Error('timed out');
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, QueueModule],
		}).compile();
		app.enableShutdownHooks();

		config = app.get(DI.config);
		systemQueue = app.get('queue:system');
	});

	afterAll(async () => {
		for (const service of services) service.onApplicationShutdown();
		await systemQueue.remove(startupJobId);
		await app.close();
	});

	test('a start queues one immediate partition migration run under a fixed id, which simultaneous starts and a start while it is pending do not queue again', async () => {
		await systemQueue.remove(startupJobId);
		expect(await pendingRuns()).toEqual([]);
		const add = vi.spyOn(systemQueue, 'add');

		start();
		start();
		await Promise.all(add.mock.results.map(result => result.value));
		const queued = await pendingRuns();
		start();
		await add.mock.results[2].value;

		expect(add.mock.calls).toEqual(Array.from({ length: 3 }, () => ['partitionMigration', {}, { jobId: startupJobId, removeOnComplete: true, removeOnFail: true }]));
		expect(queued).toEqual([{ id: startupJobId, timestamp: expect.any(Number), delay: 0 }]);
		expect(await pendingRuns()).toEqual(queued);
		expect(await (await systemQueue.getJob(startupJobId))?.getState()).toBe('waiting');
	});

	test('the run leaves the queue when it completes and when it fails, so that the next start queues it again', async () => {
		await systemQueue.remove(startupJobId);
		start();
		await waitUntil(async () => await systemQueue.getJob(startupJobId) != null);
		const outcomes: string[] = [];
		let failing = false;
		const worker = new Bull.Worker(QUEUE.SYSTEM, async job => {
			if (job.id !== startupJobId) return;
			outcomes.push(failing ? 'failed' : 'completed');
			if (failing) throw new Error('the run failed');
		}, { ...baseWorkerOptions(config, QUEUE.SYSTEM), autorun: false });
		const running = worker.run();
		try {
			await waitUntil(async () => outcomes.length === 1 && await systemQueue.getJob(startupJobId) == null);
			failing = true;
			start();
			await waitUntil(async () => outcomes.length === 2 && await systemQueue.getJob(startupJobId) == null);
		} finally {
			await worker.close();
			await running;
		}

		expect(outcomes).toEqual(['completed', 'failed']);

		start();
		await waitUntil(async () => await systemQueue.getJob(startupJobId) != null);

		expect(await (await systemQueue.getJob(startupJobId))?.getState()).toBe('waiting');
	});

	test('the periodic registration restores the job schedulers that a Redis data loss removed, without the startup run, and registers one that failed on the next round after logging it', async () => {
		await loseRedisData();
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			let failing = false;
			const upsert = systemQueue.upsertJobScheduler.bind(systemQueue);
			const upserts = vi.spyOn(systemQueue, 'upsertJobScheduler').mockImplementation(async (...args) => {
				if (failing && args[0] === 'tickCharts') throw new Error('the registration failed');
				return await upsert(...args);
			});
			const service = start();
			await Promise.all(upserts.mock.results.map(result => result.value));
			const scheduled = (await nextRuns()).map(({ key, pattern, state }) => ({ key, pattern, state }));
			const errors = vi.spyOn(service['logger'], 'error').mockImplementation(() => {});
			const registration = registrations(service);
			const startup = upserts.mock.calls.length;

			await loseRedisData();
			const lost = await nextRuns();
			failing = true;
			vi.advanceTimersByTime(interval);
			await registration.mock.results[0]?.value;
			const restored = (await nextRuns()).map(({ key, pattern, state }) => ({ key, pattern, state }));
			const logged = [...errors.mock.calls];
			const first = upserts.mock.calls.slice(startup).map(([name]) => name);
			failing = false;
			vi.advanceTimersByTime(interval);
			await registration.mock.results[1]?.value;

			expect(scheduled.map(({ key }) => key)).toEqual(expect.arrayContaining(['partitionMigration', 'tickCharts']));
			expect(scheduled.map(({ state }) => state)).toEqual(scheduled.map(() => 'delayed'));
			expect(lost).toEqual([]);
			expect(registration.mock.calls).toEqual([[true], [true]]);
			expect(first.toSorted()).toEqual(scheduled.map(({ key }) => key).toSorted());
			expect(restored).toEqual(scheduled.filter(({ key }) => key !== 'tickCharts'));
			expect(logged).toEqual([['Failed to register the job scheduler tickCharts: Error: the registration failed']]);
			expect(upserts.mock.calls.slice(startup + first.length).map(([name]) => name)).toEqual(['tickCharts']);
			expect((await nextRuns()).map(({ key, pattern, state }) => ({ key, pattern, state }))).toEqual(scheduled);
			expect(await systemQueue.getJob(startupJobId)).toBeUndefined();
		} finally {
			vi.useRealTimers();
		}
	});

	test('the periodic registration also restores the job schedulers whose next runs an eviction removed while the schedulers survived, once the times of the lost runs have passed', async () => {
		await loseRedisData();
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		try {
			const upserts = vi.spyOn(systemQueue, 'upsertJobScheduler');
			const service = start();
			await Promise.all(upserts.mock.results.map(result => result.value));
			const before = await nextRuns();
			const errors = vi.spyOn(service['logger'], 'error').mockImplementation(() => {});
			const registration = registrations(service);

			await (await systemQueue.getBackend().client).del(`${systemQueue.qualifiedName}:delayed`);
			const evicted = await nextRuns();
			vi.setSystemTime(Math.max(...before.map(({ next }) => next ?? 0)) + 1000);
			vi.advanceTimersByTime(interval);
			await registration.mock.results[0]?.value;
			const after = await nextRuns();

			expect(before.map(({ state }) => state)).toEqual(before.map(() => 'delayed'));
			expect(evicted.map(({ key, state }) => ({ key, state }))).toEqual(before.map(({ key }) => ({ key, state: 'unknown' })));
			expect(errors).not.toHaveBeenCalled();
			expect(after.map(({ key, pattern, state }) => ({ key, pattern, state }))).toEqual(before.map(({ key, pattern, state }) => ({ key, pattern, state })));
			expect(after.filter(({ next }) => next == null || next <= Date.now())).toEqual([]);
		} finally {
			vi.useRealTimers();
		}
	});

	test('a periodic registration while the job schedulers are scheduled changes nothing, so that a run that is due but not taken by a worker yet, still delayed or already waiting, is not skipped', async () => {
		await loseRedisData();
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
		try {
			const upserts = vi.spyOn(systemQueue, 'upsertJobScheduler');
			const service = start();
			await Promise.all(upserts.mock.results.map(result => result.value));
			const before = await nextRuns();
			const due = before.find(({ key }) => key === 'partitionMigration')?.next ?? 0;
			vi.setSystemTime(due + 1000);
			await (await systemQueue.getJob(`repeat:partitionMigration:${due}`))?.promote();
			const promoted = await nextRuns();
			const registration = registrations(service);
			upserts.mockClear();
			vi.advanceTimersByTime(interval);
			await registration.mock.results[0]?.value;

			expect(before.map(({ state }) => state)).toEqual(before.map(() => 'delayed'));
			expect(due).toBeGreaterThan(0);
			expect(before.find(({ key }) => key === 'checkExpiredMutings')?.next).toBe(due);
			expect(promoted).toEqual(before.map(run => ({ ...run, state: run.key === 'partitionMigration' ? 'waiting' : 'delayed' })));
			expect(Date.now()).toBeGreaterThan(due + interval);
			expect(registration.mock.calls).toEqual([[true]]);
			expect(await nextRuns()).toEqual(promoted);
			expect(upserts).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	test('the periodic registration runs every 5 minutes on a timer that does not keep the process alive, and the application shutdown stops it', async () => {
		await loseRedisData();
		vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
		try {
			const intervals = vi.spyOn(globalThis, 'setInterval');
			const upserts = vi.spyOn(systemQueue, 'upsertJobScheduler');
			const service = start();
			const delays = intervals.mock.calls.map(([, delay]) => delay);
			const timer = intervals.mock.results[0]?.value;
			intervals.mockRestore();
			await Promise.all(upserts.mock.results.map(result => result.value));
			const registration = registrations(service);

			vi.advanceTimersByTime(interval - 1);
			const early = registration.mock.calls.length;
			vi.advanceTimersByTime(1);
			await registration.mock.results[0]?.value;
			service.onApplicationShutdown();
			const left = vi.getTimerCount();
			vi.advanceTimersByTime(12 * interval);

			expect(delays).toEqual([interval]);
			expect(timer?.hasRef()).toBe(false);
			expect(early).toBe(0);
			expect(registration.mock.calls).toEqual([[true]]);
			expect(left).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});
});
