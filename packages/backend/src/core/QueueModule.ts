/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Module, OnApplicationShutdown } from '@nestjs/common';
import * as Bull from 'bullmq';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { baseQueueOptions, QUEUE } from '@/queue/const.js';
import { allSettled } from '@/misc/promise-tracker.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import {
	DeliverJobData,
	EndedPollNotificationJobData,
	InboxJobData,
	DbJobData,
	DbJobMap,
	RelationshipJobData,
	UserWebhookDeliverJobData,
	SystemWebhookDeliverJobData,
	PostScheduledNoteJobData,
} from '../queue/types.js';
import type { Provider } from '@nestjs/common';

export type SystemQueue = Bull.Queue<Record<string, unknown>>;
export type EndedPollNotificationQueue = Bull.Queue<EndedPollNotificationJobData>;
export type PostScheduledNoteQueue = Bull.Queue<PostScheduledNoteJobData>;
export type DeliverQueue = Bull.Queue<DeliverJobData>;
export type InboxQueue = Bull.Queue<InboxJobData>;
export type DbQueue = Bull.Queue<DbJobData<keyof DbJobMap>>;
export type RelationshipQueue = Bull.Queue<RelationshipJobData>;
export type ObjectStorageQueue = Bull.Queue;
export type UserWebhookDeliverQueue = Bull.Queue<UserWebhookDeliverJobData>;
export type SystemWebhookDeliverQueue = Bull.Queue<SystemWebhookDeliverJobData>;

const $system: Provider = {
	provide: 'queue:system',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.SYSTEM, baseQueueOptions(config, QUEUE.SYSTEM)),
	inject: [DI.config],
};

const $endedPollNotification: Provider = {
	provide: 'queue:endedPollNotification',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.ENDED_POLL_NOTIFICATION, baseQueueOptions(config, QUEUE.ENDED_POLL_NOTIFICATION)),
	inject: [DI.config],
};

const $postScheduledNote: Provider = {
	provide: 'queue:postScheduledNote',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.POST_SCHEDULED_NOTE, baseQueueOptions(config, QUEUE.POST_SCHEDULED_NOTE)),
	inject: [DI.config],
};

const $deliver: Provider = {
	provide: 'queue:deliver',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.DELIVER, baseQueueOptions(config, QUEUE.DELIVER)),
	inject: [DI.config],
};

const $inbox: Provider = {
	provide: 'queue:inbox',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.INBOX, baseQueueOptions(config, QUEUE.INBOX)),
	inject: [DI.config],
};

const $db: Provider = {
	provide: 'queue:db',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.DB, baseQueueOptions(config, QUEUE.DB)),
	inject: [DI.config],
};

const $relationship: Provider = {
	provide: 'queue:relationship',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.RELATIONSHIP, baseQueueOptions(config, QUEUE.RELATIONSHIP)),
	inject: [DI.config],
};

const $objectStorage: Provider = {
	provide: 'queue:objectStorage',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.OBJECT_STORAGE, baseQueueOptions(config, QUEUE.OBJECT_STORAGE)),
	inject: [DI.config],
};

const $userWebhookDeliver: Provider = {
	provide: 'queue:userWebhookDeliver',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.USER_WEBHOOK_DELIVER, baseQueueOptions(config, QUEUE.USER_WEBHOOK_DELIVER)),
	inject: [DI.config],
};

const $systemWebhookDeliver: Provider = {
	provide: 'queue:systemWebhookDeliver',
	useFactory: (config: Config) => new Bull.Queue(QUEUE.SYSTEM_WEBHOOK_DELIVER, baseQueueOptions(config, QUEUE.SYSTEM_WEBHOOK_DELIVER)),
	inject: [DI.config],
};

@Module({
	imports: [
	],
	providers: [
		GlobalEventService,
		$system,
		$endedPollNotification,
		$postScheduledNote,
		$deliver,
		$inbox,
		$db,
		$relationship,
		$objectStorage,
		$userWebhookDeliver,
		$systemWebhookDeliver,
	],
	exports: [
		$system,
		$endedPollNotification,
		$postScheduledNote,
		$deliver,
		$inbox,
		$db,
		$relationship,
		$objectStorage,
		$userWebhookDeliver,
		$systemWebhookDeliver,
	],
})
export class QueueModule implements OnApplicationShutdown {
	private queueEventListeners: Bull.QueueEvents[] = [];
	private jobCache: Map<string, Bull.Job> = new Map();

	constructor(
		@Inject(DI.config)
		private config: Config,

		private globalEventService: GlobalEventService,

		@Inject('queue:system') public systemQueue: SystemQueue,
		@Inject('queue:endedPollNotification') public endedPollNotificationQueue: EndedPollNotificationQueue,
		@Inject('queue:postScheduledNote') public postScheduledNoteQueue: PostScheduledNoteQueue,
		@Inject('queue:deliver') public deliverQueue: DeliverQueue,
		@Inject('queue:inbox') public inboxQueue: InboxQueue,
		@Inject('queue:db') public dbQueue: DbQueue,
		@Inject('queue:relationship') public relationshipQueue: RelationshipQueue,
		@Inject('queue:objectStorage') public objectStorageQueue: ObjectStorageQueue,
		@Inject('queue:userWebhookDeliver') public userWebhookDeliverQueue: UserWebhookDeliverQueue,
		@Inject('queue:systemWebhookDeliver') public systemWebhookDeliverQueue: SystemWebhookDeliverQueue,
	) {
		this.initQueueEventListeners();
	}

	private getJobCacheKey(queueName: string, jobId: string): string {
		return `${queueName}:${jobId}`;
	}

	private async getJobFromCache(jobId: string, queue: Bull.Queue, queueName: string): Promise<Bull.Job | undefined> {
		const cacheKey = this.getJobCacheKey(queueName, jobId);
		// Check cache first
		let job = this.jobCache.get(cacheKey);
		if (!job) {
			// If not in cache, fetch from queue
			job = await queue.getJob(jobId);
			if (job) {
				this.jobCache.set(cacheKey, job);
			}
		}
		return job;
	}

	private setupQueueEvents(queueName: string, queue: Bull.Queue) {
		const queueEvents = new Bull.QueueEvents(queueName, baseQueueOptions(this.config, queueName));
		this.queueEventListeners.push(queueEvents);

		queueEvents.on('progress', async ({ jobId, data }) => {
			const job = await this.getJobFromCache(jobId, queue, queueName);
			if (job?.data?.user?.id && job.id) {
				const state = await job.getState();
				const progress = typeof data === 'number'
					? data
					: typeof job.progress === 'number'
						? job.progress
						: null;
				this.globalEventService.publishJobStream(job.data.user.id, 'jobProgress', {
					id: job.id,
					name: job.name,
					state,
					progress,
					timestamp: job.timestamp,
					completedAt: job.finishedOn ?? null,
				});
			}
		});

		queueEvents.on('completed', async ({ jobId }) => {
			const job = await this.getJobFromCache(jobId, queue, queueName);
			if (job?.data?.user?.id && job.id) {
				const state = await job.getState();
				this.globalEventService.publishJobStream(job.data.user.id, 'jobCompleted', {
					id: job.id,
					name: job.name,
					state,
					progress: typeof job.progress === 'number' ? job.progress : null,
					timestamp: job.timestamp,
					completedAt: job.finishedOn ?? null,
				});
			}
			// Remove from cache after completion
			this.jobCache.delete(this.getJobCacheKey(queueName, jobId));
		});

		queueEvents.on('failed', async ({ jobId }) => {
			const job = await this.getJobFromCache(jobId, queue, queueName);
			if (job?.data?.user?.id && job.id) {
				const state = await job.getState();
				this.globalEventService.publishJobStream(job.data.user.id, 'jobFailed', {
					id: job.id,
					name: job.name,
					state,
					progress: typeof job.progress === 'number' ? job.progress : null,
					timestamp: job.timestamp,
					completedAt: job.finishedOn ?? null,
				});
			}
			// Remove from cache after failure
			this.jobCache.delete(this.getJobCacheKey(queueName, jobId));
		});
	}

	private async initQueueEventListeners() {
		// Setup QueueEvents for all queues to listen to job events
		this.setupQueueEvents(QUEUE.SYSTEM, this.systemQueue);
		this.setupQueueEvents(QUEUE.ENDED_POLL_NOTIFICATION, this.endedPollNotificationQueue);
		this.setupQueueEvents(QUEUE.POST_SCHEDULED_NOTE, this.postScheduledNoteQueue);
		this.setupQueueEvents(QUEUE.DELIVER, this.deliverQueue);
		this.setupQueueEvents(QUEUE.INBOX, this.inboxQueue);
		this.setupQueueEvents(QUEUE.DB, this.dbQueue);
		this.setupQueueEvents(QUEUE.RELATIONSHIP, this.relationshipQueue);
		this.setupQueueEvents(QUEUE.OBJECT_STORAGE, this.objectStorageQueue);
		this.setupQueueEvents(QUEUE.USER_WEBHOOK_DELIVER, this.userWebhookDeliverQueue);
		this.setupQueueEvents(QUEUE.SYSTEM_WEBHOOK_DELIVER, this.systemWebhookDeliverQueue);
	}

	public async dispose(): Promise<void> {
		// Wait for all potential queue jobs
		await allSettled();
		// Clear job cache
		this.jobCache.clear();
		// Close all QueueEvents listeners
		await Promise.all(this.queueEventListeners.map(qe => qe.close()));
		// And then close all queues
		await Promise.all([
			this.systemQueue.close(),
			this.endedPollNotificationQueue.close(),
			this.postScheduledNoteQueue.close(),
			this.deliverQueue.close(),
			this.inboxQueue.close(),
			this.dbQueue.close(),
			this.relationshipQueue.close(),
			this.objectStorageQueue.close(),
			this.userWebhookDeliverQueue.close(),
			this.systemWebhookDeliverQueue.close(),
		]);
	}

	async onApplicationShutdown(signal: string): Promise<void> {
		await this.dispose();
	}
}
