/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { DbQueue } from '@/core/QueueModule.js';

export const meta = {
	tags: ['admin'],

	secure: true,
	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:test-job',

	res: {
		type: 'object',
		properties: {
			jobId: {
				type: 'string',
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		duration: {
			type: 'integer',
			minimum: 1,
			maximum: 60,
			default: 10,
			description: 'Duration of the test job in seconds',
		},
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject('queue:db')
		private dbQueue: DbQueue,
	) {
		super(meta, paramDef, async (ps, me) => {
			const job = await this.dbQueue.add('testJob', {
				user: { id: me.id },
				duration: ps.duration,
			}, {
				removeOnComplete: true,
				removeOnFail: true,
			});

			return {
				jobId: job.id ?? 'unknown',
			};
		});
	}
}
