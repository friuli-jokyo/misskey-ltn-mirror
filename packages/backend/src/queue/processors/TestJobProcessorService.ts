/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import type Logger from '@/logger.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { bindThis } from '@/decorators.js';
import type * as Bull from 'bullmq';

@Injectable()
export class TestJobProcessorService {
	private logger: Logger;

	constructor(
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('test-job');
	}

	@bindThis
	public async process(job: Bull.Job<{ user: { id: string }; duration: number }>): Promise<void> {
		this.logger.info(`Starting test job for user ${job.data.user.id} with duration ${job.data.duration}s...`);

		const duration = job.data.duration * 1000; // Convert to milliseconds
		const steps = 20; // Number of progress updates
		const stepDuration = duration / steps;

		for (let i = 0; i <= steps; i++) {
			const progress = (i / steps) * 100;
			await job.updateProgress(progress);
			
			this.logger.info(`Test job progress: ${progress.toFixed(1)}%`);

			if (i < steps) {
				await new Promise(resolve => setTimeout(resolve, stepDuration));
			}
		}

		this.logger.succ(`Test job completed for user ${job.data.user.id}`);
	}
}
