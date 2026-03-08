/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DbQueue } from '@/core/QueueModule.js';

export const meta = {
	secure: true,
	requireCredential: true,
	res: {
		type: 'array',
		items: {
			type: 'object',
			properties: {
				id: {
					type: 'string',
				},
				name: {
					type: 'string',
				},
				state: {
					type: 'string',
					enum: ['completed', 'failed', 'delayed', 'active', 'waiting', 'waiting-children', 'prioritized', 'unknown'],
				},
				progress: {
					type: 'number',
					nullable: true,
				},
				timestamp: {
					type: 'number',
				},
				completedAt: {
					type: 'number',
					nullable: true,
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject('queue:db')
		public dbQueue: DbQueue,
	) {
		super(meta, paramDef, async (_ps, me) => {
			const jobs = await dbQueue.getJobs();
			const userJobs = jobs.filter((job) => job.data.user.id === me.id);

			const jobsWithState = await Promise.all(
				userJobs.map(async (job) => ({
					id: job.id ?? '',
					name: job.name,
					state: await job.getState(),
					progress: typeof job.progress === 'number' ? job.progress : null,
					timestamp: job.timestamp,
					completedAt: job.finishedOn ?? null,
				})),
			);

			return jobsWithState;
		});
	}
}
