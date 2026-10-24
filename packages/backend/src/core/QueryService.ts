/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Brackets, DataSource, In, ObjectLiteral } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { MiUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import type { UserProfilesRepository, FollowingsRepository, ChannelFollowingsRepository, BlockingsRepository, NoteThreadMutingsRepository, MutingsRepository, RenoteMutingsRepository, NotesRepository, NoteRelationsRepository, MiMeta } from '@/models/_.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { PartitionMigrationStateService } from '@/core/PartitionMigrationStateService.js';
import { groupByPrefix, nextPrefix, ordinalToPrefix, prefixesAscending, prefixesDescending, prefixOf, prefixToOrdinal } from '@/misc/partition.js';
import type { SelectQueryBuilder } from 'typeorm';

@Injectable()
export class QueryService {
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		@Inject(DI.channelFollowingsRepository)
		private channelFollowingsRepository: ChannelFollowingsRepository,

		@Inject(DI.blockingsRepository)
		private blockingsRepository: BlockingsRepository,

		@Inject(DI.noteThreadMutingsRepository)
		private noteThreadMutingsRepository: NoteThreadMutingsRepository,

		@Inject(DI.mutingsRepository)
		private mutingsRepository: MutingsRepository,

		@Inject(DI.renoteMutingsRepository)
		private renoteMutingsRepository: RenoteMutingsRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteRelationsRepository)
		private noteRelationsRepository: NoteRelationsRepository,

		@Inject(DI.meta)
		private meta: MiMeta,

		private idService: IdService,
		private partitionMigrationStateService: PartitionMigrationStateService,
	) {
	}

	public makePaginationQuery<T extends ObjectLiteral>(
		q: SelectQueryBuilder<T>,
		sinceId?: string | null,
		untilId?: string | null,
		sinceDate?: number | null,
		untilDate?: number | null,
		targetColumn = 'id',
		separator = '.',
	): SelectQueryBuilder<T> {
		if (sinceId && untilId) {
			q.andWhere(`${q.alias}${separator}${targetColumn} > :sinceId`, { sinceId: sinceId });
			q.andWhere(`${q.alias}${separator}${targetColumn} < :untilId`, { untilId: untilId });
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'DESC');
		} else if (sinceId) {
			q.andWhere(`${q.alias}${separator}${targetColumn} > :sinceId`, { sinceId: sinceId });
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'ASC');
		} else if (untilId) {
			q.andWhere(`${q.alias}${separator}${targetColumn} < :untilId`, { untilId: untilId });
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'DESC');
		} else if (sinceDate && untilDate) {
			q.andWhere(`${q.alias}${separator}${targetColumn} > :sinceId`, { sinceId: this.idService.gen(sinceDate, true) });
			q.andWhere(`${q.alias}${separator}${targetColumn} < :untilId`, { untilId: this.idService.gen(untilDate, true) });
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'DESC');
		} else if (sinceDate) {
			q.andWhere(`${q.alias}${separator}${targetColumn} > :sinceId`, { sinceId: this.idService.gen(sinceDate, true) });
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'ASC');
		} else if (untilDate) {
			q.andWhere(`${q.alias}${separator}${targetColumn} < :untilId`, { untilId: this.idService.gen(untilDate, true) });
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'DESC');
		} else {
			q.orderBy(`${q.alias}${separator}${targetColumn}`, 'DESC');
		}
		return q;
	}

	@bindThis
	public async noteFloorOf(user: MiUser['id'] | { id: MiUser['id']; host: MiUser['host'] }): Promise<string | undefined> {
		if (typeof user !== 'string') {
			if (user.host == null) return user.id;
			if (!await this.partitionMigrationStateService.isPhaseFinished('userNoteIdFloorBackfill')) return undefined;
		}
		const [row]: { host: string | null; floor: string }[] = await this.db.query(
			'SELECT "host", COALESCE("noteIdFloor", "id") AS "floor" FROM "user" WHERE "id" = $1',
			[typeof user === 'string' ? user : user.id],
		);
		if (row == null) return undefined;
		if (row.host == null) return row.floor;
		return await this.partitionMigrationStateService.isPhaseFinished('userNoteIdFloorBackfill') ? row.floor : undefined;
	}

	@bindThis
	private async globalNoteFloor(): Promise<string | undefined> {
		if (!await this.partitionMigrationStateService.isPhaseFinished('userNoteIdFloorBackfill')) return undefined;
		const [{ floor }]: { floor: string | null }[] = await this.db.query('SELECT LEAST((SELECT min("id") FROM "user"), (SELECT min("noteIdFloor") FROM "user")) AS "floor"');
		return floor ?? undefined;
	}

	@bindThis
	public isAlwaysEmpty<T extends ObjectLiteral>(q: SelectQueryBuilder<T>): boolean {
		return q.expressionMap.wheres.every(where => where.type !== 'or') && q.expressionMap.wheres.some(where => where.condition === '1=0');
	}

	@bindThis
	public async fetchPaginationQueryAcrossPartitions<T extends ObjectLiteral>(
		q: SelectQueryBuilder<T>,
		ps: { sinceId?: string | null; untilId?: string | null; sinceDate?: number | null; untilDate?: number | null },
		limit: number,
		opts: { floorKey?: string } = {},
	): Promise<T[]> {
		if (this.isAlwaysEmpty(q)) return [];

		const ascending = (Boolean(ps.sinceId) && !ps.untilId) ||
			(!ps.sinceId && !ps.untilId && Boolean(ps.sinceDate) && !ps.untilDate);
		const sinceId = ps.sinceId ?? (ps.sinceDate ? this.idService.gen(ps.sinceDate, true) : undefined);
		const untilId = ps.untilId ?? (ps.untilDate ? this.idService.gen(ps.untilDate, true) : undefined);

		const nowPrefix = prefixOf(this.idService.gen(Date.now(), true));
		const ceilingPrefix = nextPrefix(nowPrefix) ?? nowPrefix;
		const floorKey = opts.floorKey ?? await this.globalNoteFloor();
		const floorPrefix = floorKey != null ? prefixOf(floorKey) : ordinalToPrefix(0);

		const lowerOf = (a: string, b: string): string => prefixToOrdinal(a) <= prefixToOrdinal(b) ? a : b;
		const higherOf = (a: string, b: string): string => prefixToOrdinal(a) >= prefixToOrdinal(b) ? a : b;

		const prefixes = ascending
			? prefixesAscending(
				higherOf(sinceId != null ? prefixOf(sinceId) : floorPrefix, floorPrefix),
				lowerOf(untilId != null ? prefixOf(untilId) : ceilingPrefix, ceilingPrefix),
			)
			: prefixesDescending(
				lowerOf(untilId != null ? prefixOf(untilId) : ceilingPrefix, ceilingPrefix),
				higherOf(sinceId != null ? prefixOf(sinceId) : floorPrefix, floorPrefix),
			);

		const acc: T[] = [];
		for (const prefix of prefixes) {
			if (acc.length >= limit) break;
			const upper = nextPrefix(prefix);
			const page = q.clone()
				.andWhere(`${q.alias}.id >= :partitionLower`, { partitionLower: prefix })
				.limit(limit - acc.length);
			if (upper != null) page.andWhere(`${q.alias}.id < :partitionUpper`, { partitionUpper: upper });
			acc.push(...await page.getMany());
		}
		return acc.slice(0, limit);
	}

	@bindThis
	public async countAcrossPartitions<T extends ObjectLiteral>(
		q: SelectQueryBuilder<T>,
		opts: { floorKey?: string } = {},
	): Promise<number> {
		const nowPrefix = prefixOf(this.idService.gen(Date.now(), true));
		const ceilingPrefix = nextPrefix(nowPrefix) ?? nowPrefix;
		const floorKey = opts.floorKey ?? await this.globalNoteFloor();
		const floorPrefix = floorKey != null ? prefixOf(floorKey) : ordinalToPrefix(0);

		let total = 0;
		for (const prefix of prefixesAscending(floorPrefix, ceilingPrefix)) {
			const upper = nextPrefix(prefix);
			const page = q.clone()
				.andWhere(`${q.alias}.id >= :partitionLower`, { partitionLower: prefix });
			if (upper != null) page.andWhere(`${q.alias}.id < :partitionUpper`, { partitionUpper: upper });
			total += await page.getCount();
		}
		return total;
	}

	@bindThis
	public async attachReplyAndRenote(notes: MiNote[]): Promise<void> {
		const ids = new Set<MiNote['id']>();
		for (const note of notes) {
			if (note.replyId != null && note.reply === undefined) ids.add(note.replyId);
			if (note.renoteId != null && note.renote === undefined) ids.add(note.renoteId);
		}
		if (ids.size === 0) return;

		const related = new Map<MiNote['id'], MiNote>();
		for (const group of groupByPrefix(ids).values()) {
			const rows = await this.notesRepository.createQueryBuilder('note')
				.where({ id: In(group) })
				.innerJoinAndSelect('note.user', 'user')
				.getMany();
			for (const row of rows) related.set(row.id, row);
		}

		for (const note of notes) {
			if (note.replyId != null && note.reply === undefined) note.reply = related.get(note.replyId) ?? null;
			if (note.renoteId != null && note.renote === undefined) note.renote = related.get(note.renoteId) ?? null;
		}
	}

	@bindThis
	public async fetchNotesByIdPages(
		fetchIds: (range: { sinceId?: string; untilId?: string; ascending: boolean; limit: number }) => Promise<MiNote['id'][]>,
		ps: { sinceId?: string | null; untilId?: string | null; sinceDate?: number | null; untilDate?: number | null; limit: number },
		filter: (query: SelectQueryBuilder<MiNote>) => void,
	): Promise<MiNote[]> {
		const visible = this.notesRepository.createQueryBuilder('note');
		filter(visible);
		if (this.isAlwaysEmpty(visible)) return [];

		const ascending = (ps.sinceId != null && ps.untilId == null) ||
			(ps.sinceId == null && ps.untilId == null && ps.sinceDate != null && ps.untilDate == null);
		let sinceId = ps.sinceId ?? (ps.sinceDate != null ? this.idService.gen(ps.sinceDate, true) : undefined);
		let untilId = ps.untilId ?? (ps.untilDate != null ? this.idService.gen(ps.untilDate, true) : undefined);

		const notes: MiNote[] = [];
		let batch = ps.limit;

		for (;;) {
			const ids = await fetchIds({ sinceId, untilId, ascending, limit: batch });
			if (ids.length === 0) break;

			const cursor = ids[ids.length - 1];
			if (ascending) {
				sinceId = cursor;
			} else {
				untilId = cursor;
			}

			const page: MiNote[] = [];
			for (const group of groupByPrefix(ids).values()) {
				const query = this.notesRepository.createQueryBuilder('note')
					.where({ id: In(group) })
					.innerJoinAndSelect('note.user', 'user');
				filter(query);
				page.push(...await query.getMany());
			}
			page.sort((a, b) => (a.id < b.id) === ascending ? -1 : 1);
			notes.push(...page);

			if (notes.length >= ps.limit || ids.length < batch) break;
			batch = Math.max(batch, Math.min(batch * 2, 1000));
		}

		return notes.slice(0, ps.limit);
	}

	@bindThis
	public async fetchNotesByRelation(
		parentId: MiNote['id'],
		kinds: number[],
		ps: { sinceId?: string | null; untilId?: string | null; sinceDate?: number | null; untilDate?: number | null; limit: number },
		me: { id: MiUser['id'] } | null,
	): Promise<MiNote[]> {
		return await this.fetchNotesByIdPages(async ({ sinceId, untilId, ascending, limit }) => {
			const relationsQuery = this.noteRelationsRepository.createQueryBuilder('relation')
				.andWhere('relation.parentId = :parentId', { parentId })
				.andWhere('relation.kind IN (:...kinds)', { kinds })
				.orderBy('relation.childId', ascending ? 'ASC' : 'DESC');
			if (sinceId != null) relationsQuery.andWhere('relation.childId > :sinceId', { sinceId });
			if (untilId != null) relationsQuery.andWhere('relation.childId < :untilId', { untilId });

			return (await relationsQuery.limit(limit).getMany()).map(relation => relation.childId);
		}, ps, query => {
			this.generateVisibilityQuery(query, me);
			this.generateBaseNoteFilteringQuery(query, me);
		});
	}

	/**
	 * ミュートやブロックのようにすべてのタイムラインで共通に使用するフィルターを定義します。
	 *
	 * 特別な事情がない限り、各タイムラインはこの関数を呼び出してフィルターを適用してください。
	 *
	 * Notes for future maintainers:
	 * 1) この関数で生成するクエリと同等の処理が FanoutTimelineEndpointService にあります。
	 *    この関数を変更した場合、FanoutTimelineEndpointService の方も変更する必要があります。
	 * 2) 以下のエンドポイントでは特別な事情があるため queryService のそれぞれの関数を呼び出しています。
	 *    この関数を変更した場合、以下のエンドポイントの方も変更する必要があることがあります。
	 *    - packages/backend/src/server/api/endpoints/clips/notes.ts
	 */
	@bindThis
	public generateBaseNoteFilteringQuery(
		query: SelectQueryBuilder<any>,
		me: { id: MiUser['id'] } | null,
		{
			excludeUserFromMute,
			excludeAuthor,
		}: {
			excludeUserFromMute?: MiUser['id'],
			excludeAuthor?: boolean,
		} = {},
	): void {
		this.generateBlockedHostQueryForNote(query, excludeAuthor);
		this.generateSuspendedUserQueryForNote(query, excludeAuthor);
		if (me) {
			this.generateMutedUserQueryForNotes(query, me, { excludeUserFromMute });
			this.generateBlockedUserQueryForNotes(query, me);
			this.generateMutedUserQueryForRenoteTarget(query, me, { excludeUserFromMute });
			this.generateBlockedUserQueryForRenoteTarget(query, me);
		}
	}

	@bindThis
	public generateUgcVisibilityQueryForVisitor(q: SelectQueryBuilder<any>): void {
		if (this.meta.ugcVisibilityForVisitor === 'none') {
			q.andWhere('1=0');
		} else if (this.meta.ugcVisibilityForVisitor === 'local') {
			q.andWhere(`${q.alias}.userHost IS NULL`);
		}
	}

	@bindThis
	private joinRenoteTargetRelation(q: SelectQueryBuilder<any>): void {
		if (q.expressionMap.joinAttributes.some(join => join.alias.name === 'renoteTargetRelation')) return;
		q.leftJoin('note_relation', 'renoteTargetRelation', '"renoteTargetRelation"."childId" = note.id AND "renoteTargetRelation"."kind" IN (1, 2)');
	}

	// ここでいうBlockedは被Blockedの意
	@bindThis
	public generateBlockedUserQueryForNotes(
		q: SelectQueryBuilder<any>,
		me: { id: MiUser['id'] },
	): void {
		const blockingQuery = this.blockingsRepository.createQueryBuilder('blocking')
			.select('blocking.blockerId')
			.where('blocking.blockeeId = :blockeeId', { blockeeId: me.id });

		// 投稿の作者にブロックされていない かつ
		// 投稿の返信先の作者にブロックされていない かつ
		// 投稿の引用元の作者にブロックされていない
		q
			.andWhere(new Brackets(qb => {
				qb
					.where('note.userId IS NULL')
					.orWhere(`note.userId NOT IN (${ blockingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('note.replyUserId IS NULL')
					.orWhere(`note.replyUserId NOT IN (${ blockingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('note.renoteUserId IS NULL')
					.orWhere(`note.renoteUserId NOT IN (${ blockingQuery.getQuery() })`);
			}));

		q.setParameters(blockingQuery.getParameters());
	}

	@bindThis
	public generateBlockedUserQueryForRenoteTarget(
		q: SelectQueryBuilder<any>,
		me: { id: MiUser['id'] },
	): void {
		const blockingQuery = this.blockingsRepository.createQueryBuilder('blocking')
			.select('blocking.blockerId')
			.where('blocking.blockeeId = :blockeeId', { blockeeId: me.id });

		this.joinRenoteTargetRelation(q);

		q
			.andWhere(new Brackets(qb => {
				qb
					.where('"renoteTargetRelation"."parentReplyUserId" IS NULL')
					.orWhere(`"renoteTargetRelation"."parentReplyUserId" NOT IN (${ blockingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('"renoteTargetRelation"."parentRenoteUserId" IS NULL')
					.orWhere(`"renoteTargetRelation"."parentRenoteUserId" NOT IN (${ blockingQuery.getQuery() })`);
			}));

		q.setParameters(blockingQuery.getParameters());
	}

	@bindThis
	public generateBlockQueryForUsers(q: SelectQueryBuilder<any>, me: { id: MiUser['id'] }): void {
		const blockingQuery = this.blockingsRepository.createQueryBuilder('blocking')
			.select('blocking.blockeeId')
			.where('blocking.blockerId = :blockerId', { blockerId: me.id });

		const blockedQuery = this.blockingsRepository.createQueryBuilder('blocking')
			.select('blocking.blockerId')
			.where('blocking.blockeeId = :blockeeId', { blockeeId: me.id });

		q.andWhere(`user.id NOT IN (${ blockingQuery.getQuery() })`);
		q.setParameters(blockingQuery.getParameters());

		q.andWhere(`user.id NOT IN (${ blockedQuery.getQuery() })`);
		q.setParameters(blockedQuery.getParameters());
	}

	@bindThis
	public generateMutedNoteThreadQuery(q: SelectQueryBuilder<any>, me: { id: MiUser['id'] }): void {
		const mutedQuery = this.noteThreadMutingsRepository.createQueryBuilder('threadMuted')
			.select('threadMuted.threadId')
			.where('threadMuted.userId = :userId', { userId: me.id });

		q.andWhere(`note.id NOT IN (${ mutedQuery.getQuery() })`);
		q.andWhere(new Brackets(qb => {
			qb
				.where('note.threadId IS NULL')
				.orWhere(`note.threadId NOT IN (${ mutedQuery.getQuery() })`);
		}));

		q.setParameters(mutedQuery.getParameters());
	}

	@bindThis
	public generateMutedUserQueryForNotes(
		q: SelectQueryBuilder<any>,
		me: { id: MiUser['id'] },
		{
			excludeUserFromMute,
		}: {
			excludeUserFromMute?: MiUser['id'],
		} = {},
	): void {
		const mutingQuery = this.mutingsRepository.createQueryBuilder('muting')
			.select('muting.muteeId')
			.where('muting.muterId = :muterId', { muterId: me.id });

		if (excludeUserFromMute) {
			mutingQuery.andWhere('muting.muteeId != :excludeId', { excludeId: excludeUserFromMute });
		}

		const mutingInstanceQuery = this.userProfilesRepository.createQueryBuilder('user_profile')
			.select('user_profile.mutedInstances')
			.where('user_profile.userId = :muterId', { muterId: me.id });

		// 投稿の作者をミュートしていない かつ
		// 投稿の返信先の作者をミュートしていない かつ
		// 投稿の引用元の作者をミュートしていない
		q
			.andWhere(new Brackets(qb => {
				qb
					.where('note.userId IS NULL')
					.orWhere(`note.userId NOT IN (${ mutingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('note.replyUserId IS NULL')
					.orWhere(`note.replyUserId NOT IN (${ mutingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('note.renoteUserId IS NULL')
					.orWhere(`note.renoteUserId NOT IN (${ mutingQuery.getQuery() })`);
			}))
			// mute instances
			.andWhere(new Brackets(qb => {
				qb
					.andWhere('note.userHost IS NULL')
					.orWhere(`NOT ((${ mutingInstanceQuery.getQuery() })::jsonb ? note.userHost)`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('note.replyUserHost IS NULL')
					.orWhere(`NOT ((${ mutingInstanceQuery.getQuery() })::jsonb ? note.replyUserHost)`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('note.renoteUserHost IS NULL')
					.orWhere(`NOT ((${ mutingInstanceQuery.getQuery() })::jsonb ? note.renoteUserHost)`);
			}));

		q.setParameters(mutingQuery.getParameters());
		q.setParameters(mutingInstanceQuery.getParameters());
	}

	@bindThis
	public generateMutedUserQueryForRenoteTarget(
		q: SelectQueryBuilder<any>,
		me: { id: MiUser['id'] },
		{
			excludeUserFromMute,
		}: {
			excludeUserFromMute?: MiUser['id'],
		} = {},
	): void {
		const mutingQuery = this.mutingsRepository.createQueryBuilder('muting')
			.select('muting.muteeId')
			.where('muting.muterId = :muterId', { muterId: me.id });

		if (excludeUserFromMute) {
			mutingQuery.andWhere('muting.muteeId != :excludeId', { excludeId: excludeUserFromMute });
		}

		const mutingInstanceQuery = this.userProfilesRepository.createQueryBuilder('user_profile')
			.select('user_profile.mutedInstances')
			.where('user_profile.userId = :muterId', { muterId: me.id });

		this.joinRenoteTargetRelation(q);

		q
			.andWhere(new Brackets(qb => {
				qb
					.where('"renoteTargetRelation"."parentReplyUserId" IS NULL')
					.orWhere(`"renoteTargetRelation"."parentReplyUserId" NOT IN (${ mutingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('"renoteTargetRelation"."parentRenoteUserId" IS NULL')
					.orWhere(`"renoteTargetRelation"."parentRenoteUserId" NOT IN (${ mutingQuery.getQuery() })`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('"renoteTargetRelation"."parentReplyUserHost" IS NULL')
					.orWhere(`NOT ((${ mutingInstanceQuery.getQuery() })::jsonb ? "renoteTargetRelation"."parentReplyUserHost")`);
			}))
			.andWhere(new Brackets(qb => {
				qb
					.where('"renoteTargetRelation"."parentRenoteUserHost" IS NULL')
					.orWhere(`NOT ((${ mutingInstanceQuery.getQuery() })::jsonb ? "renoteTargetRelation"."parentRenoteUserHost")`);
			}));

		q.setParameters(mutingQuery.getParameters());
		q.setParameters(mutingInstanceQuery.getParameters());
	}

	@bindThis
	public generateMutedUserQueryForUsers(q: SelectQueryBuilder<any>, me: { id: MiUser['id'] }): void {
		const mutingQuery = this.mutingsRepository.createQueryBuilder('muting')
			.select('muting.muteeId')
			.where('muting.muterId = :muterId', { muterId: me.id });

		q.andWhere(`user.id NOT IN (${ mutingQuery.getQuery() })`);

		q.setParameters(mutingQuery.getParameters());
	}

	@bindThis
	public generateVisibilityQuery(q: SelectQueryBuilder<any>, me?: { id: MiUser['id'] } | null): void {
		// This code must always be synchronized with the checks in NoteEntityService.isVisibleForMe and Stream abstract class Channel.isNoteVisibleForMe.
		if (me == null) {
			// TODO: ugcVisibilityForVisitor が local の場合の扱い (付随するリモートのノートを隠して表示するか) を検討する
			if (this.meta.ugcVisibilityForVisitor === 'none') q.andWhere('1=0');

			q.andWhere(new Brackets(qb => {
				qb
					.where('note.visibility = \'public\'')
					.orWhere('note.visibility = \'home\'');
			}));
		} else {
			const followingQuery = this.followingsRepository.createQueryBuilder('following')
				.select('following.followeeId')
				.where('following.followerId = :meId');

			q.andWhere(new Brackets(qb => {
				qb
				// 公開投稿である
					.where(new Brackets(qb => {
						qb
							.where('note.visibility = \'public\'')
							.orWhere('note.visibility = \'home\'');
					}))
				// または 自分自身
					.orWhere('note.userId = :meId')
				// または 自分宛て
					.orWhere(':meIdAsList <@ note.visibleUserIds')
					.orWhere(':meIdAsList <@ note.mentions')
					.orWhere(new Brackets(qb => {
						qb
						// または フォロワー宛ての投稿であり、
							.where('note.visibility = \'followers\'')
							.andWhere(new Brackets(qb => {
								qb
								// 自分がフォロワーである
									.where(`note.userId IN (${ followingQuery.getQuery() })`)
								// または 自分の投稿へのリプライ
									.orWhere('note.replyUserId = :meId');
							}));
					}));
			}));

			q.setParameters({ meId: me.id, meIdAsList: [me.id] });
		}
	}

	@bindThis
	public generateMutedUserRenotesQueryForNotes(q: SelectQueryBuilder<any>, me: { id: MiUser['id'] }): void {
		const mutingQuery = this.renoteMutingsRepository.createQueryBuilder('renote_muting')
			.select('renote_muting.muteeId')
			.where('renote_muting.muterId = :muterId', { muterId: me.id });

		q.andWhere(new Brackets(qb => {
			qb
				.where(new Brackets(qb => {
					qb.where('note.renoteId IS NOT NULL');
					qb.andWhere('note.text IS NULL');
					qb.andWhere(`note.userId NOT IN (${ mutingQuery.getQuery() })`);
				}))
				.orWhere('note.renoteId IS NULL')
				.orWhere('note.text IS NOT NULL');
		}));

		q.setParameters(mutingQuery.getParameters());
	}

	@bindThis
	public generateBlockedHostQueryForNote(q: SelectQueryBuilder<any>, excludeAuthor?: boolean): void {
		let nonBlockedHostQuery: (part: string) => string;
		if (this.meta.blockedHosts.length === 0) {
			nonBlockedHostQuery = () => '1=1';
		} else {
			nonBlockedHostQuery = (match: string) => `${match} NOT ILIKE ALL(ARRAY[:...blocked])`;
			q.setParameters({ blocked: this.meta.blockedHosts.flatMap(x => [x, `%.${x}`]) });
		}

		if (excludeAuthor) {
			const instanceSuspension = (user: string) => new Brackets(qb => qb
				.where(`note.${user}Id IS NULL`) // no corresponding user
				.orWhere(`note.userId = note.${user}Id`)
				.orWhere(`note.${user}Host IS NULL`) // local
				.orWhere(nonBlockedHostQuery(`note.${user}Host`)));

			q
				.andWhere(instanceSuspension('replyUser'))
				.andWhere(instanceSuspension('renoteUser'));
		} else {
			const instanceSuspension = (user: string) => new Brackets(qb => qb
				.where(`note.${user}Id IS NULL`) // no corresponding user
				.orWhere(`note.${user}Host IS NULL`) // local
				.orWhere(nonBlockedHostQuery(`note.${user}Host`)));

			q
				.andWhere(instanceSuspension('user'))
				.andWhere(instanceSuspension('replyUser'))
				.andWhere(instanceSuspension('renoteUser'));
		}
	}

	@bindThis
	public generateSuspendedUserQueryForNote(q: SelectQueryBuilder<any>, excludeAuthor?: boolean): void {
		const brakets = (column: string) => new Brackets(qb => {
			qb.where(`note.${column} IS NULL`);
			if (excludeAuthor) qb.orWhere(`note.${column} = note.userId`);
			qb.orWhere(`NOT EXISTS (SELECT 1 FROM "user" "suspended_user" WHERE "suspended_user"."id" = note.${column} AND "suspended_user"."isSuspended")`);
		});

		if (!excludeAuthor) q.andWhere('user.isSuspended = FALSE');
		q
			.andWhere(brakets('replyUserId'))
			.andWhere(brakets('renoteUserId'));
	}

	/**
	 * フォロー関係 (following テーブルの行) を、一覧の持ち主の公開範囲設定に従って閲覧者に開示してよいものだけに絞り込む。
	 * - `followers`: フォロイーのフォロワー一覧として扱い、フォロイーの followersVisibility で判定する (users/followers と同一基準)
	 * - `following`: フォロワーのフォロー一覧として扱い、フォロワーの followingVisibility で判定する (users/following と同一基準)
	 * モデレーターによる例外は呼び出し元で扱う。
	 */
	@bindThis
	public generateFollowingRelationVisibilityQuery(q: SelectQueryBuilder<any>, list: 'followers' | 'following', me?: { id: MiUser['id'] } | null): void {
		const alias = q.alias;
		const ownerColumn = list === 'followers' ? `${alias}.followeeId` : `${alias}.followerId`;
		const visibilityColumn = list === 'followers' ? 'ownerProfile.followersVisibility' : 'ownerProfile.followingVisibility';

		q.innerJoin(this.userProfilesRepository.metadata.targetName, 'ownerProfile', `ownerProfile.userId = ${ownerColumn}`);

		if (me == null) {
			q.andWhere(`${visibilityColumn} = 'public'`);
			return;
		}

		const meFollowingQuery = this.followingsRepository.createQueryBuilder('meFollowing')
			.select('meFollowing.followeeId')
			.where('meFollowing.followerId = :meId');

		q.andWhere(new Brackets(qb => {
			qb
				// 公開されている
				.where(`${visibilityColumn} = 'public'`)
				// または 自分自身の一覧
				.orWhere(`${ownerColumn} = :meId`)
				// または フォロワー限定で、自分が持ち主をフォローしている
				.orWhere(new Brackets(qb => {
					qb
						.where(`${visibilityColumn} = 'followers'`)
						.andWhere(`${ownerColumn} IN (${ meFollowingQuery.getQuery() })`);
				}));
		}));

		q.setParameters({ meId: me.id });
	}
}
