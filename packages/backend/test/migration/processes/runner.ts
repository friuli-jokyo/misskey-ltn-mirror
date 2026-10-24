/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { clockOffsetMs } from './clock.js';
import type * as Bull from 'bullmq';

const { setTimeout } = await import('node:timers/promises');
const { createInterface } = await import('node:readline');
const { bootstrap, emit, installHandlers } = await import('./common.js');

installHandlers();

try {
	const { QueueProcessorModule } = await import('@/queue/QueueProcessorModule.js');
	const { QueueProcessorService } = await import('@/queue/QueueProcessorService.js');
	const { PartitionMigrationProcessorService } = await import('@/queue/processors/PartitionMigrationProcessorService.js');
	const mode = process.env.MK_E2E_RUNNER_MODE === 'queue' || process.env.MK_E2E_RUNNER_MODE === 'clean' ? process.env.MK_E2E_RUNNER_MODE : 'direct';
	const app = await bootstrap([QueueProcessorModule]);
	if (mode === 'clean') {
		const { CleanProcessorService } = await import('@/queue/processors/CleanProcessorService.js');
		const begin = Date.now();
		await app.get(CleanProcessorService).process();
		emit({ type: 'result', ms: Date.now() - begin });
		await setTimeout(1000);
		process.exit(0);
	}
	const service = app.get(PartitionMigrationProcessorService);
	const started = new Promise<void>(resolve => createInterface({ input: process.stdin }).on('line', line => {
		if (line.trim() === 'start') resolve();
	}));
	emit({ type: 'ready', clockOffsetMs, mode });
	await started;
	emit({ type: 'started' });

	let runs = 0;
	const observed = async (job: Bull.Job, task: (job: Bull.Job) => Promise<void>, rethrow: boolean) => {
		const run = ++runs;
		const logs: string[] = [];
		const log = job.log.bind(job);
		job.log = (row: string) => {
			logs.push(row);
			emit({ type: 'job-log', run, row });
			return log(row);
		};
		emit({ type: 'run-start', run, jobId: job.id, attemptsStarted: job.attemptsStarted, stalledCounter: job.stalledCounter });
		try {
			await task(job);
		} catch (e) {
			emit({ type: 'run-error', run, message: String(e) });
			if (rethrow) throw e;
		} finally {
			emit({ type: 'run-end', run, logs: logs.length, holder: !logs.includes('another run is in progress') });
		}
	};

	if (mode === 'queue') {
		const original = service.process;
		service.process = async (job: Bull.Job) => await observed(job, original, true);
		void app.get(QueueProcessorService).start();
	} else {
		for (;;) {
			const job = { log: async () => 0 } as unknown as Bull.Job;
			await observed(job, service.process, false);
			await setTimeout(200 + Math.floor(Math.random() * 300));
		}
	}
} catch (e) {
	emit({ type: 'error', message: String(e), stack: e instanceof Error ? e.stack : undefined });
	process.exit(1);
}
