/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import * as Redis from 'ioredis';
import { Brackets, In } from 'typeorm';
import { Inject, Injectable } from '@nestjs/common';
import type { MiMeta, NotesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import ActiveUsersChart from '@/core/chart/charts/active-users.js';
import { DI } from '@/di-symbols.js';
import { RoleService } from '@/core/RoleService.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { MiLocalUser } from '@/models/User.js';
import { FanoutTimelineEndpointService } from '@/core/FanoutTimelineEndpointService.js';
import { ChannelMutingService } from '@/core/ChannelMutingService.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['notes'],

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
		ltlDisabled: {
			message: 'Local timeline has been disabled.',
			code: 'LTL_DISABLED',
			id: '45a6eb02-7695-4393-b023-dd3be9aaaefd',
		},

		bothWithRepliesAndWithFiles: {
			message: 'Specifying both withReplies and withFiles is not supported',
			code: 'BOTH_WITH_REPLIES_AND_WITH_FILES',
			id: 'dd9c8400-1cb5-4eef-8a31-200c5f933793',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		withFiles: { type: 'boolean', default: false },
		withRenotes: { type: 'boolean', default: true },
		withReplies: { type: 'boolean', default: false },
		withPromotes: { type: 'boolean', default: false },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		allowPartial: { type: 'boolean', default: false }, // true is recommended but for compatibility false by default
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
	},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.meta)
		private serverSettings: MiMeta,

		@Inject(DI.redis)
		private redis: Redis.Redis,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private noteEntityService: NoteEntityService,
		private roleService: RoleService,
		private activeUsersChart: ActiveUsersChart,
		private idService: IdService,
		private fanoutTimelineEndpointService: FanoutTimelineEndpointService,
		private queryService: QueryService,
		private channelMutingService: ChannelMutingService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate!) : null);
			const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate!) : null);

			const policies = await this.roleService.getUserPolicies(me ? me.id : null);
			if (!policies.ltlAvailable) {
				throw new ApiError(meta.errors.ltlDisabled);
			}

			if (ps.withReplies && ps.withFiles) throw new ApiError(meta.errors.bothWithRepliesAndWithFiles);

			if (!this.serverSettings.enableFanoutTimeline) {
				const timeline = await this.getFromDb({
					untilId,
					sinceId,
					limit: ps.limit,
					withFiles: ps.withFiles,
					withReplies: ps.withReplies,
				}, me);

				process.nextTick(() => {
					if (me) {
						this.activeUsersChart.read(me);
					}
				});

				return await this.noteEntityService.packMany(timeline, me);
			}

			const timeline = await this.fanoutTimelineEndpointService.timeline({
				untilId,
				sinceId,
				limit: ps.limit,
				allowPartial: ps.allowPartial,
				me,
				useDbFallback: this.serverSettings.enableFanoutTimelineDbFallback,
				redisTimelines:
					ps.withFiles ? ['localTimelineWithFiles']
					: ps.withReplies ? ['localTimeline', 'localTimelineWithReplies']
					: me ? ['localTimeline', `localTimelineWithReplyTo:${me.id}`]
					: ['localTimeline'],
				alwaysIncludeMyNotes: true,
				excludePureRenotes: !ps.withRenotes,
				dbFallback: async (untilId, sinceId, limit) => await this.getFromDb({
					untilId,
					sinceId,
					limit,
					withFiles: ps.withFiles,
					withReplies: ps.withReplies,
				}, me),
			});

			if (ps.withPromotes && timeline.length) {
				const first = this.idService.parse(timeline[0].id).date.valueOf();
				const last = this.idService.parse(timeline[timeline.length - 1].id).date.valueOf();
				const isAscending = first < last;
				const until = untilId ? this.idService.parse(untilId).date.valueOf() : Date.now();
				const since = sinceId ? this.idService.parse(sinceId).date.valueOf() : isAscending ? first : last;
				const promoted = isAscending ?
					await this.redis.zrange('circulation:stream', since, until, 'BYSCORE', 'WITHSCORES') :
					await this.redis.zrange('circulation:stream', until, since, 'BYSCORE', 'REV', 'WITHSCORES');
				const mapped = promoted.flatMap((v, i, w) => i % 2 ? [[w[i - 1], this.idService.gen(parseInt(v, 10), true)]] as const : [] as const);
				const resolved = await this.notesRepository.findBy({ id: In(mapped.map(([id]) => id)) });
				const promotedNotes = await this.noteEntityService.packMany(resolved, me);
				const splicing: Parameters<typeof Array.prototype.splice>[] = [];
				if (mapped.length) {
					let index = 0;
					for (let i = 0; i < timeline.length; i++) {
						while (index < mapped.length && (isAscending ? mapped[index][1] < timeline[i].id : mapped[index][1] > timeline[i].id)) {
							const [id, promoted] = mapped[index++];
							const note = promotedNotes.find((n) => n.id === id);
							if (note) {
								(note as any).promoted = promoted;
								splicing.push([i, 0, note]);
							}
						}
					}
					while (index < mapped.length) {
						const [id, promoted] = mapped[index++];
						const note = promotedNotes.find((n) => n.id === id);
						if (note) {
							(note as any).promoted = promoted;
							splicing.push([timeline.length, 0, note]);
						}
					}
					for (let i = splicing.length - 1; i >= 0; i--) {
						timeline.splice(...splicing[i]);
					}
				}
			}

			process.nextTick(() => {
				if (me) {
					this.activeUsersChart.read(me);
				}
			});

			return timeline;
		});
	}

	private async getFromDb(ps: {
		sinceId: string | null,
		untilId: string | null,
		limit: number,
		withFiles: boolean,
		withReplies: boolean,
	}, me: MiLocalUser | null) {
		const query = this.queryService.makePaginationQuery(this.notesRepository.createQueryBuilder('note'),
			ps.sinceId, ps.untilId)
			.andWhere('(note.visibility = \'public\') AND (note.userHost IS NULL) AND (note.channelId IS NULL) AND (note.anonymouslySendToUserId IS NULL)')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		this.queryService.generateVisibilityQuery(query, me);
		this.queryService.generateBaseNoteFilteringQuery(query, me);
		if (me) {
			this.queryService.generateMutedUserRenotesQueryForNotes(query, me);

			const mutedChannelIds = await this.channelMutingService
				.list({ requestUserId: me.id }, { idOnly: true })
				.then(x => x.map(x => x.id));
			if (mutedChannelIds.length > 0) {
				query.andWhere(new Brackets(qb => {
					qb.orWhere('note.renoteChannelId IS NULL')
						.orWhere('note.renoteChannelId NOT IN (:...mutedChannelIds)', { mutedChannelIds });
				}));
			}
		}

		if (ps.withFiles) {
			query.andWhere('note.fileIds != \'{}\'');
		}

		if (!ps.withReplies) {
			query.andWhere(new Brackets(qb => {
				qb
					.where('note.replyId IS NULL') // 返信ではない
					.orWhere(new Brackets(qb => {
						qb // 返信だけど投稿者自身への返信
							.where('note.replyId IS NOT NULL')
							.andWhere('note.replyUserId = note.userId');
					}));
			}));
		}

		return await query.limit(ps.limit).getMany();
	}
}
