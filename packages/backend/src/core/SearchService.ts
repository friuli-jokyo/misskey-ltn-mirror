/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In, SelectQueryBuilder } from 'typeorm';
import { DI } from '@/di-symbols.js';
import { type Config, FulltextSearchProvider } from '@/config.js';
import { bindThis } from '@/decorators.js';
import { MiNote } from '@/models/Note.js';
import type { FollowingsRepository, NotesRepository } from '@/models/_.js';
import { MiUser } from '@/models/_.js';
import { sqlLikeEscape } from '@/misc/sql-like-escape.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { CacheService } from '@/core/CacheService.js';
import { QueryService } from '@/core/QueryService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import type { Index, MeiliSearch } from 'meilisearch';

type K = string;
type V = string | number | boolean;
type Q =
	{ op: '=', k: K, v: V } |
	{ op: '!=', k: K, v: V } |
	{ op: '>', k: K, v: number } |
	{ op: '<', k: K, v: number } |
	{ op: '>=', k: K, v: number } |
	{ op: '<=', k: K, v: number } |
	{ op: 'is null', k: K } |
	{ op: 'is not null', k: K } |
	{ op: 'and', qs: Q[] } |
	{ op: 'or', qs: Q[] } |
	{ op: 'not', q: Q };

export type SearchOpts = {
	userId?: MiNote['userId'] | null;
	channelId?: MiNote['channelId'] | null;
	host?: string | null;
	onlyFollows?: boolean;
	onlyMentioned?: boolean;
	onlySpecified?: boolean;
	minRenoteCount?: number | null;
	maxRenoteCount?: number | null;
	minRepliesCount?: number | null;
	maxRepliesCount?: number | null;
	minReactionsCount?: number | null;
	maxReactionsCount?: number | null;
};

export type SearchPagination = {
	untilId?: MiNote['id'];
	sinceId?: MiNote['id'];
	limit: number;
};

function compileValue(value: V): string {
	if (typeof value === 'string') {
		return `'${value}'`; // TODO: escape
	} else if (typeof value === 'number') {
		return value.toString();
	} else if (typeof value === 'boolean') {
		return value.toString();
	}
	throw new Error('unrecognized value');
}

function compileQuery(q: Q): string {
	switch (q.op) {
		case '=': return `(${q.k} = ${compileValue(q.v)})`;
		case '!=': return `(${q.k} != ${compileValue(q.v)})`;
		case '>': return `(${q.k} > ${compileValue(q.v)})`;
		case '<': return `(${q.k} < ${compileValue(q.v)})`;
		case '>=': return `(${q.k} >= ${compileValue(q.v)})`;
		case '<=': return `(${q.k} <= ${compileValue(q.v)})`;
		case 'and': return q.qs.length === 0 ? '' : `(${ q.qs.map(_q => compileQuery(_q)).join(' AND ') })`;
		case 'or': return q.qs.length === 0 ? '' : `(${ q.qs.map(_q => compileQuery(_q)).join(' OR ') })`;
		case 'is null': return `(${q.k} IS NULL)`;
		case 'is not null': return `(${q.k} IS NOT NULL)`;
		case 'not': return `(NOT ${compileQuery(q.q)})`;
		default: throw new Error('unrecognized query operator');
	}
}

@Injectable()
export class SearchService {
	private readonly meilisearchIndexScope: 'local' | 'global' | string[] = 'local';
	private readonly meilisearchNoteIndex: Index | null = null;
	private readonly provider: FulltextSearchProvider;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.meilisearch)
		private meilisearch: MeiliSearch | null,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private cacheService: CacheService,
		private queryService: QueryService,
		private idService: IdService,
		private loggerService: LoggerService,
	) {
		if (meilisearch) {
			this.meilisearchNoteIndex = meilisearch.index(`${config.meilisearch!.index}---notes`);
			this.meilisearchNoteIndex.updateSettings({
				searchableAttributes: [
					'text',
					'cw',
				],
				sortableAttributes: [
					'createdAt',
				],
				filterableAttributes: [
					'createdAt',
					'userId',
					'userHost',
					'channelId',
					'tags',
				],
				typoTolerance: {
					enabled: false,
				},
				pagination: {
					maxTotalHits: 10000,
				},
			});
		}

		if (config.meilisearch?.scope) {
			this.meilisearchIndexScope = config.meilisearch.scope;
		}

		this.provider = config.fulltextSearch?.provider ?? 'auto';
		this.loggerService.getLogger('SearchService').info(`-- Provider: ${this.provider}`);
	}

	@bindThis
	public async indexNote(note: MiNote): Promise<void> {
		if (!this.meilisearch) return;
		if (note.text == null && note.cw == null) return;
		if (!['home', 'public'].includes(note.visibility)) return;
		if (note.anonymouslySendToUserId || note.anonymousChannelUsername) return;

		switch (this.meilisearchIndexScope) {
			case 'global':
				break;

			case 'local':
				if (note.userHost == null) break;
				return;

			default: {
				if (note.userHost == null) break;
				if (this.meilisearchIndexScope.includes(note.userHost)) break;
				return;
			}
		}

		await this.meilisearchNoteIndex?.addDocuments([{
			id: note.id,
			createdAt: this.idService.parse(note.id).date.getTime(),
			userId: note.userId,
			userHost: note.userHost,
			channelId: note.channelId,
			cw: note.cw,
			text: note.text,
			tags: note.tags,
		}], {
			primaryKey: 'id',
		});
	}

	@bindThis
	public async unindexNote(note: MiNote): Promise<void> {
		if (!this.meilisearch) return;
		if (!['home', 'public'].includes(note.visibility)) return;

		await this.meilisearchNoteIndex?.deleteDocument(note.id);
	}

	@bindThis
	public async searchNote(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		switch (this.provider) {
			case 'auto': {
				return this.searchNoteAuto(q, me, opts, pagination);
			}
			case 'sqlLike': {
				return this.searchNoteByLike(q, me, opts, pagination);
			}
			case 'sqlPgroonga': {
				return this.searchNoteByPgroonga(q, me, opts, pagination);
			}
			case 'meilisearch': {
				return this.searchNoteByMeiliSearch(q, me, opts, pagination);
			}
			default: {
				// eslint-disable-next-line @typescript-eslint/no-unused-vars
				const typeCheck: never = this.provider;
				return [];
			}
		}
	}

	@bindThis
	private async searchNoteAuto(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		const isPgroongaAvailable = (await this.db.query('SELECT 0 FROM pg_extension WHERE extname = \'pgroonga\'')).length > 0;
		if (this.meilisearch) {
			const commonTermThreshold = this.config.fulltextSearch?.commonTermThreshold;
			if (Number.isSafeInteger(commonTermThreshold)) {
				const sampling = this.queryNoteBySql(q, me, opts, isPgroongaAvailable);
				const attributes: PropertyDescriptor = Object.create(null);
				const tableSample = this.config.fulltextSearch?.tableSample;
				if (tableSample?.includes(';')) {
					throw new Error(`Invalid tableSample: ${tableSample}`);
				}
				attributes.value = function createSelectExpression(this: SelectQueryBuilder<MiNote>) {
					let expression = `SELECT COUNT(*) > ${commonTermThreshold} AS "isCommonTerm" FROM note note`;
					if (tableSample) {
						expression += ` TABLESAMPLE ${tableSample}`;
					}
					return expression;
				};
				Object.defineProperty(sampling, 'createSelectExpression', attributes);
				const { isCommonTerm } = (await sampling.getRawOne<{ isCommonTerm: boolean }>())!;
				if (isCommonTerm) {
					return this.searchNoteByMeiliSearch(q, me, opts, pagination);
				}
			}
		}
		if (isPgroongaAvailable) {
			return this.searchNoteByPgroonga(q, me, opts, pagination, !!this.meilisearch);
		} else {
			return this.searchNoteByLike(q, me, opts, pagination, !!this.meilisearch);
		}
	}

	@bindThis
	private async searchNoteByLike(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
		softLimit = false,
	): Promise<MiNote[]> {
		const cte = this.queryNoteBySql(q, me, opts, false);
		const query = this.queryService.makePaginationQuery(
			this.notesRepository.createQueryBuilder('note')
				.addCommonTableExpression(cte.getQuery(), 'note')
				.setParameters(cte.expressionMap.parameters),
			pagination.sinceId,
			pagination.untilId,
			undefined,
			undefined,
			'_',
		);
		if (!softLimit) {
			query.limit(pagination.limit);
		}
		query.expressionMap.selects = cte.expressionMap.selects;
		const attributes: PropertyDescriptor = Object.create(null);
		attributes.value = function createSelectExpression(this: SelectQueryBuilder<MiNote>) {
			return 'SELECT * FROM note note'; // NOTE: selected columns in the cte are already transformed so just pass-through here
		};
		Object.defineProperty(query, 'createSelectExpression', attributes);
		const result = await query.getMany();
		if (softLimit) {
			return result.slice(0, pagination.limit);
		} else {
			return result;
		}
	}

	@bindThis
	private async searchNoteByPgroonga(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
		softLimit = false,
	): Promise<MiNote[]> {
		const cte = this.queryNoteBySql(q, me, opts, true);
		const query = this.queryService.makePaginationQuery(
			this.notesRepository.createQueryBuilder('note')
				.addCommonTableExpression(cte.getQuery(), 'note')
				.setParameters(cte.expressionMap.parameters),
			pagination.sinceId,
			pagination.untilId,
			undefined,
			undefined,
			'_',
		);
		if (!softLimit) {
			query.limit(pagination.limit);
		}
		query.expressionMap.selects = cte.expressionMap.selects;
		const attributes: PropertyDescriptor = Object.create(null);
		attributes.value = function createSelectExpression(this: SelectQueryBuilder<MiNote>) {
			return 'SELECT * FROM note note'; // NOTE: selected columns in the cte are already transformed so just pass-through here
		};
		Object.defineProperty(query, 'createSelectExpression', attributes);
		const result = await query.getMany();
		if (softLimit) {
			return result.slice(0, pagination.limit);
		} else {
			return result;
		}
	}

	@bindThis
	private queryNoteBySql(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		usePgroonga: boolean,
	): SelectQueryBuilder<MiNote> {
		const query = this.notesRepository.createQueryBuilder('note');

		if (opts.userId) {
			query.andWhere('note.userId = :userId', { userId: opts.userId });
		} else if (opts.channelId) {
			query.andWhere('note.channelId = :channelId', { channelId: opts.channelId });
		}

		query
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		if (usePgroonga) {
			query.andWhere('concat_ws_unsafe_immutable(\' \', note.cw, note.text) &@~ :q', { q });
		} else {
			query.andWhere('lower(concat_ws_unsafe_immutable(\' \', note.cw, note.text)) LIKE :q', { q: `%${sqlLikeEscape(q.toLowerCase())}%` });
		}

		query
			.andWhere('note.anonymouslySendToUserId IS NULL')
			.andWhere('note.anonymousChannelUsername IS NULL');

		if (opts.host) {
			if (opts.host === '.') {
				query.andWhere('user.host IS NULL');
			} else {
				query.andWhere('user.host = :host', { host: opts.host });
			}
		}

		if (opts.onlyFollows) {
			query.andWhere(`note.userId IN (${this.followingsRepository.createQueryBuilder('following').select('following.followeeId').where('following.followerId = :followerId').getQuery()})`, { followerId: me?.id });
		}

		if (opts.onlyMentioned) {
			query.andWhere(':mentions <@ note.mentions', { mentions: [me?.id] });
		}

		if (opts.onlySpecified) {
			query.andWhere(':visibleUserIds <@ note.visibleUserIds', { visibleUserIds: [me?.id] });
		}

		if (opts.minRenoteCount != null) {
			query.andWhere('note.renoteCount >= :minRenoteCount', { minRenoteCount: opts.minRenoteCount });
		}

		if (opts.maxRenoteCount != null) {
			query.andWhere('note.renoteCount <= :maxRenoteCount', { maxRenoteCount: opts.maxRenoteCount });
		}

		if (opts.minRepliesCount != null) {
			query.andWhere('note.repliesCount >= :minRepliesCount', { minRepliesCount: opts.minRepliesCount });
		}

		if (opts.maxRepliesCount != null) {
			query.andWhere('note.repliesCount <= :maxRepliesCount', { maxRepliesCount: opts.maxRepliesCount });
		}

		if (opts.minReactionsCount != null) {
			query.andWhere('COALESCE((SELECT sum(reaction::INTEGER) FROM LATERAL jsonb_array_elements(jsonb_path_query_array(note.reactions, \'$.*\')) reaction), 0) >= :minReactionsCount', { minReactionsCount: opts.minReactionsCount });
		}

		if (opts.maxReactionsCount != null) {
			query.andWhere('COALESCE((SELECT sum(reaction::INTEGER) FROM LATERAL jsonb_array_elements(jsonb_path_query_array(note.reactions, \'$.*\')) reaction), 0) <= :maxReactionsCount', { maxReactionsCount: opts.maxReactionsCount });
		}

		this.queryService.generateVisibilityQuery(query, me);
		if (me) this.queryService.generateMutedUserQuery(query, me);
		if (me) this.queryService.generateBlockedUserQuery(query, me);

		return query;
	}

	@bindThis
	private async searchNoteByMeiliSearch(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
	): Promise<MiNote[]> {
		if (!this.meilisearch || !this.meilisearchNoteIndex) {
			throw new Error('MeiliSearch is not available');
		}

		const filter: Q = {
			op: 'and',
			qs: [],
		};
		if (pagination.untilId) filter.qs.push({
			op: '<',
			k: 'createdAt',
			v: this.idService.parse(pagination.untilId).date.getTime(),
		});
		if (pagination.sinceId) filter.qs.push({
			op: '>',
			k: 'createdAt',
			v: this.idService.parse(pagination.sinceId).date.getTime(),
		});
		if (opts.userId) filter.qs.push({ op: '=', k: 'userId', v: opts.userId });
		if (opts.channelId) filter.qs.push({ op: '=', k: 'channelId', v: opts.channelId });
		if (opts.host) {
			if (opts.host === '.') {
				filter.qs.push({ op: 'is null', k: 'userHost' });
			} else {
				filter.qs.push({ op: '=', k: 'userHost', v: opts.host });
			}
		}

		const res = await this.meilisearchNoteIndex.search(q, {
			sort: ['createdAt:desc'],
			matchingStrategy: 'all',
			attributesToRetrieve: ['id', 'createdAt'],
			filter: compileQuery(filter),
			limit: pagination.limit,
		});
		if (res.hits.length === 0) {
			return [];
		}

		const [
			userIdsWhoMeMuting,
			userIdsWhoBlockingMe,
		] = me
			? await Promise.all([
				this.cacheService.userMutingsCache.fetch(me.id),
				this.cacheService.userBlockedCache.fetch(me.id),
			])
			: [new Set<string>(), new Set<string>()];
		const notes = (await this.notesRepository.findBy({
			id: In(res.hits.map(x => x.id)),
		})).filter(note => {
			if (me && isUserRelated(note, userIdsWhoBlockingMe)) return false;
			if (me && isUserRelated(note, userIdsWhoMeMuting)) return false;
			return true;
		});

		return notes.sort((a, b) => a.id > b.id ? -1 : 1);
	}
}
