/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { IdService } from '@/core/IdService.js';
import { SearchService } from '@/core/SearchService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: false,

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Note',
		},
	},

	errors: {
		unavailable: {
			message: 'Search of notes unavailable.',
			code: 'UNAVAILABLE',
			id: '0b44998d-77aa-4427-80d0-d2c9b8523011',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		query: { type: 'string' },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		offset: { type: 'integer', default: 0 },
		host: {
			type: 'string',
			description: 'The local host is represented with `.`.',
		},
		userId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
		channelId: { type: 'string', format: 'misskey:id', nullable: true, default: null },
		onlyFollows: { type: 'boolean', default: false },
		onlyMentioned: { type: 'boolean', default: false },
		onlySpecified: { type: 'boolean', default: false },
		minRenoteCount: { type: 'integer', minimum: 0, nullable: true, default: null },
		maxRenoteCount: { type: 'integer', minimum: 0, nullable: true, default: null },
		minRepliesCount: { type: 'integer', minimum: 0, nullable: true, default: null },
		maxRepliesCount: { type: 'integer', minimum: 0, nullable: true, default: null },
		minReactionsCount: { type: 'integer', minimum: 0, nullable: true, default: null },
		maxReactionsCount: { type: 'integer', minimum: 0, nullable: true, default: null },
	},
	required: ['query'],
} as const;

// TODO: ロジックをサービスに切り出す

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private idService: IdService,
		private noteEntityService: NoteEntityService,
		private searchService: SearchService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const policies = await this.roleService.getUserPolicies(me ? me.id : null);
			if (!policies.canSearchNotes) {
				throw new ApiError(meta.errors.unavailable);
			}

			const untilId = ps.untilId ?? (ps.untilDate != null ? this.idService.gen(ps.untilDate) : undefined);
			const sinceId = ps.sinceId ?? (ps.sinceDate != null ? this.idService.gen(ps.sinceDate) : undefined);

			const notes = await this.searchService.searchNote(ps.query, me, {
				userId: ps.userId,
				channelId: ps.channelId,
				host: ps.host,
				onlyFollows: ps.onlyFollows,
				onlyMentioned: ps.onlyMentioned,
				onlySpecified: ps.onlySpecified,
				minRenoteCount: ps.minRenoteCount,
				maxRenoteCount: ps.maxRenoteCount,
				minRepliesCount: ps.minRepliesCount,
				maxRepliesCount: ps.maxRepliesCount,
				minReactionsCount: ps.minReactionsCount,
				maxReactionsCount: ps.maxReactionsCount,
			}, {
				untilId,
				sinceId,
				limit: ps.limit,
			});

			return await this.noteEntityService.packMany(notes, me);
		});
	}
}
