/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource, SelectQueryBuilder } from 'typeorm';
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
import postgresqlParser from '../../node_modules/node-sql-parser/build/postgresql.js';
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

function stringifySearch(q: string, opts: SearchOpts): string {
	return Buffer.from(JSON.stringify([
		q,
		opts.userId,
		opts.channelId,
		opts.host,
		opts.onlyFollows,
		opts.onlyMentioned,
		opts.onlySpecified,
		opts.minRenoteCount,
		opts.maxRenoteCount,
		opts.minRepliesCount,
		opts.maxRepliesCount,
		opts.minReactionsCount,
		opts.maxReactionsCount,
	])).toString('base64url');
}

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

const parser = new postgresqlParser.Parser();

@Injectable()
export class SearchService {
	private readonly meilisearchIndexScope: 'local' | 'global' | string[] = 'local';
	private readonly meilisearchNoteIndex: Index | null = null;
	private readonly provider: FulltextSearchProvider;
	private pgroongaAvailabilityCache: boolean | null = null;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

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
		const meilisearchConfig = config.meilisearch;

		if (meilisearch && meilisearchConfig) {
			this.meilisearchNoteIndex = meilisearch.index(`${meilisearchConfig.index}---notes`);
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
		if ((opts.onlyFollows || opts.onlyMentioned || opts.onlySpecified) && me == null) {
			return [];
		}

		const cacheKey = `search:${me?.id ?? '_'}:${stringifySearch(q, opts)}`;
		const cachedIds = await this.redisClient.lrange(cacheKey, 0, -1);
		if (cachedIds.length > 0) {
			const filteredIds = cachedIds.filter((id) =>
				(pagination.sinceId == null || id > pagination.sinceId)
				&& (pagination.untilId == null || id < pagination.untilId),
			);

			if (filteredIds.length === 0) {
				return [];
			}

			const sortedIds = filteredIds.sort((a, b) =>
				pagination.sinceId && !pagination.untilId
					? (a < b ? -1 : 1)
					: (a > b ? -1 : 1),
			).slice(0, pagination.limit);

			const query = this.notesRepository.createQueryBuilder('note')
				.innerJoinAndSelect('note.user', 'user')
				.leftJoinAndSelect('note.reply', 'reply')
				.leftJoinAndSelect('note.renote', 'renote')
				.leftJoinAndSelect('reply.user', 'replyUser')
				.leftJoinAndSelect('renote.user', 'renoteUser')
				.where('note.id IN (:...noteIds)', { noteIds: sortedIds });

			const notes = await query.getMany();
			const order = new Map(sortedIds.map((id, index) => [id, index]));
			return notes.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
		}

		switch (this.provider) {
			case 'auto': {
				return this.searchNoteAuto(q, me, opts, pagination, cacheKey);
			}
			case 'sqlLike':
				return this.searchNoteByLike(q, me, opts, pagination, false, cacheKey);
			case 'sqlPgroonga': {
				return this.searchNoteByPgroonga(q, me, opts, pagination, false, cacheKey);
			}
			case 'meilisearch': {
				if (this.hasDetailedSqlFilters(opts)) {
					return this.searchNoteByLike(q, me, opts, pagination);
				}

				if (opts.onlyFollows || opts.onlyMentioned || opts.onlySpecified) {
					return this.searchNoteByLike(q, me, opts, pagination);
				}

				return this.searchNoteByMeiliSearch(q, me, opts, pagination);
			}
			default: {
				const _: never = this.provider;
				return [];
			}
		}
	}

	@bindThis
	private hasDetailedSqlFilters(opts: SearchOpts): boolean {
		return opts.minRenoteCount != null
			|| opts.maxRenoteCount != null
			|| opts.minRepliesCount != null
			|| opts.maxRepliesCount != null
			|| opts.minReactionsCount != null
			|| opts.maxReactionsCount != null;
	}

	@bindThis
	private async isPgroongaAvailable(): Promise<boolean> {
		if (this.pgroongaAvailabilityCache != null) {
			return this.pgroongaAvailabilityCache;
		}

		this.pgroongaAvailabilityCache = (await this.db.query('SELECT 0 FROM pg_extension WHERE extname = \'pgroonga\' LIMIT 1')).length > 0;
		return this.pgroongaAvailabilityCache;
	}

	@bindThis
	private async isCommonTerm(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		usePgroonga: boolean,
	): Promise<boolean> {
		const threshold = this.config.fulltextSearch?.commonTermThreshold;
		if (typeof threshold !== 'number' || !Number.isSafeInteger(threshold) || threshold < 0) {
			return false;
		}
		const commonTermThreshold: number = threshold;

		const sampling = this.queryNoteBySql(q, me, opts, usePgroonga);
		const tableSample = this.config.fulltextSearch?.tableSample;

		if (tableSample) {
			const { ast } = parser.parse(`SELECT * FROM _ TABLESAMPLE ${tableSample}`);

			// eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
			if (Array.isArray(ast)
				|| ast.type !== 'select'
				|| ast.where
				|| ast.groupby
				|| ast.having
				|| ast.orderby
				|| ast.window
				|| ast.limit?.value.length
				|| [ast.from].flat().length !== 1
			) {
				throw new Error('malformed tableSample detected');
			}
		}

		const attributes: PropertyDescriptor = Object.create(null);
		attributes.value = function createSelectExpression(this: SelectQueryBuilder<MiNote>) {
			let expression = `SELECT COUNT(*) > ${commonTermThreshold} AS "isCommonTerm" FROM note note`;
			if (tableSample) {
				expression += ` TABLESAMPLE ${tableSample}`;
			}
			return expression;
		};
		Object.defineProperty(sampling, 'createSelectExpression', attributes);

		const result = await sampling.getRawOne<{ isCommonTerm: boolean }>();
		return result?.isCommonTerm ?? false;
	}

	@bindThis
	private async searchNoteAuto(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
		cacheKey: string,
	): Promise<MiNote[]> {
		const usePgroonga = await this.isPgroongaAvailable();
		const softLimit = this.meilisearch != null;

		if (this.meilisearch && !this.hasDetailedSqlFilters(opts) && !opts.onlyFollows && !opts.onlyMentioned && !opts.onlySpecified) {
			if (await this.isCommonTerm(q, me, opts, usePgroonga)) {
				return this.searchNoteByMeiliSearch(q, me, opts, pagination);
			}
		}

		return usePgroonga
			? this.searchNoteByPgroonga(q, me, opts, pagination, softLimit, cacheKey)
			: this.searchNoteByLike(q, me, opts, pagination, softLimit, cacheKey);
	}

	@bindThis
	private async searchNoteByLike(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
		softLimit = false,
		cacheKey?: string,
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
			'id',
			'_',
		);
		query.expressionMap.selects = cte.expressionMap.selects;

		const attributes: PropertyDescriptor = Object.create(null);
		attributes.value = function createSelectExpression(this: SelectQueryBuilder<MiNote>) {
			return 'SELECT * FROM note note';
		};
		Object.defineProperty(query, 'createSelectExpression', attributes);

		if (!softLimit) {
			query.limit(pagination.limit);
		}

		const notes = await query.getMany();

		if (cacheKey && notes.length > 0) {
			await this.redisClient.multi()
				.del(cacheKey)
				.rpush(cacheKey, ...notes.map((note) => note.id))
				.expire(cacheKey, 300)
				.exec();
		}

		return softLimit ? notes.slice(0, pagination.limit) : notes;
	}

	@bindThis
	private async searchNoteByPgroonga(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		pagination: SearchPagination,
		softLimit = false,
		cacheKey?: string,
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
			'id',
			'_',
		);
		query.expressionMap.selects = cte.expressionMap.selects;

		const attributes: PropertyDescriptor = Object.create(null);
		attributes.value = function createSelectExpression(this: SelectQueryBuilder<MiNote>) {
			return 'SELECT * FROM note note';
		};
		Object.defineProperty(query, 'createSelectExpression', attributes);

		if (!softLimit) {
			query.limit(pagination.limit);
		}

		const notes = await query.getMany();

		if (cacheKey && notes.length > 0) {
			await this.redisClient.multi()
				.del(cacheKey)
				.rpush(cacheKey, ...notes.map((note) => note.id))
				.expire(cacheKey, 300)
				.exec();
		}

		return softLimit ? notes.slice(0, pagination.limit) : notes;
	}

	@bindThis
	private queryNoteBySql(
		q: string,
		me: MiUser | null,
		opts: SearchOpts,
		usePgroonga: boolean,
	) {
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
			query.andWhere('LOWER(concat_ws_unsafe_immutable(\' \', note.cw, note.text)) LIKE :q', { q: `%${ sqlLikeEscape(q.toLowerCase()) }%` });
		}

		query
			.andWhere('note.anonymouslySendToUserId IS NULL')
			.andWhere('note.anonymousChannelUsername IS NULL');

		if (opts.host) {
			if (opts.host === '.') {
				query.andWhere('note.userHost IS NULL');
			} else {
				query.andWhere('note.userHost = :host', { host: opts.host });
			}
		}

		if (opts.onlyFollows) {
			if (!me) {
				query.andWhere('1 = 0');
			} else {
				const followingQuery = this.followingsRepository.createQueryBuilder('following')
					.select('following.followeeId')
					.where('following.followerId = :followerId', { followerId: me.id });

				query.andWhere(`note.userId IN (${followingQuery.getQuery()})`);
				query.setParameters(followingQuery.getParameters());
			}
		}

		if (opts.onlyMentioned) {
			if (!me) {
				query.andWhere('1 = 0');
			} else {
				query.andWhere(':mentionedUserId = ANY(note.mentions)', { mentionedUserId: me.id });
			}
		}

		if (opts.onlySpecified) {
			if (!me) {
				query.andWhere('1 = 0');
			} else {
				query.andWhere(':visibleUserId = ANY(note.visibleUserIds)', { visibleUserId: me.id });
			}
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
			query.andWhere('COALESCE((SELECT SUM(value::INTEGER) FROM LATERAL jsonb_each(note.reactions)), 0) >= :minReactionsCount', { minReactionsCount: opts.minReactionsCount });
		}

		if (opts.maxReactionsCount != null) {
			query.andWhere('COALESCE((SELECT SUM(value::INTEGER) FROM LATERAL jsonb_each(note.reactions)), 0) <= :maxReactionsCount', { maxReactionsCount: opts.maxReactionsCount });
		}

		this.queryService.generateVisibilityQuery(query, me);
		this.queryService.generateBaseNoteFilteringQuery(query, me);

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

		const query = this.notesRepository.createQueryBuilder('note')
			.innerJoinAndSelect('note.user', 'user')
			.leftJoinAndSelect('note.reply', 'reply')
			.leftJoinAndSelect('note.renote', 'renote')
			.leftJoinAndSelect('reply.user', 'replyUser')
			.leftJoinAndSelect('renote.user', 'renoteUser');

		query.where('note.id IN (:...noteIds)', { noteIds: res.hits.map(x => x.id) });

		this.queryService.generateBlockedHostQueryForNote(query);
		this.queryService.generateSuspendedUserQueryForNote(query);

		const notes = (await query.getMany()).filter(note => {
			if (me && isUserRelated(note, userIdsWhoBlockingMe)) return false;
			if (me && isUserRelated(note, userIdsWhoMeMuting)) return false;
			return true;
		});

		return notes.sort((a, b) => a.id > b.id ? -1 : 1);
	}
}
