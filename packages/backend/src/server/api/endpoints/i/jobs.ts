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
				progress: {
					type: 'number',
					nullable: true,
				},
				timestamp: {
					type: 'number',
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
		super(meta, paramDef, async (ps, me) => {
			const jobs = await dbQueue.getJobs();
			return jobs.filter((job) => job.data.user.id === me.id).map((job) => ({
				id: job.id,
				name: job.name,
				progress: typeof job.progress === 'number' ? job.progress : null,
				timestamp: job.timestamp,
			}));
		});
	}
}
