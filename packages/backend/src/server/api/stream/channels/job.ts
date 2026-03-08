/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable, Scope } from '@nestjs/common';
import { bindThis } from '@/decorators.js';
import type { JsonObject } from '@/misc/json-value.js';
import Channel, { type ChannelRequest } from '../channel.js';
import { REQUEST } from '@nestjs/core';
import type { DbQueue } from '@/core/QueueModule.js';

type JobPayload = {
	id: string;
	name: string;
	state: 'completed' | 'failed' | 'delayed' | 'active' | 'waiting' | 'waiting-children' | 'prioritized' | 'unknown';
	progress: number | null;
	timestamp: number;
	completedAt: number | null;
};

@Injectable({ scope: Scope.TRANSIENT })
export class JobChannel extends Channel {
	public readonly chName = 'job';
	public static shouldShare = false;
	public static requireCredential = true as const;
	public static kind = 'read:account';

	private jobTracking: Map<string, JobPayload> = new Map();

	constructor(
		@Inject(REQUEST)
		request: ChannelRequest,

		@Inject('queue:db')
		private dbQueue: DbQueue,
	) {
		super(request);
	}

	@bindThis
	public async init(params: JsonObject) {
		// Send initial job list
		const jobs = await this.dbQueue.getJobs();
		const userJobs = jobs.filter((job) => job.data.user?.id === this.user!.id);

		const jobsWithState = await Promise.all(
			userJobs
				.filter((job) => job.id !== undefined)
				.map(async (job) => ({
					id: job.id!,
					name: job.name,
					state: await job.getState(),
					progress: typeof job.progress === 'number' ? job.progress : null,
					timestamp: job.timestamp,
					completedAt: job.finishedOn ?? null,
				})),
		);

		for (const job of jobsWithState) {
			this.jobTracking.set(job.id, job);
			this.send('jobProgress', job);
		}

		// Subscribe to job events
		this.subscriber.on(`jobStream:${this.user!.id}`, (data) => {
			if (!data.body) return;

			switch (data.type) {
				case 'jobProgress': {
					this.jobTracking.set(data.body.id, data.body);
					this.send('jobProgress', data.body);
					break;
				}
				case 'jobCompleted': {
					this.jobTracking.delete(data.body.id);
					this.send('jobCompleted', data.body);
					break;
				}
				case 'jobFailed': {
					this.jobTracking.delete(data.body.id);
					this.send('jobFailed', data.body);
					break;
				}
			}
		});
	}
}
