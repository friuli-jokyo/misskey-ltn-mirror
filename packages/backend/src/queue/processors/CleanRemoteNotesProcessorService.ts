/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import { DataSource, EntityManager, In, QueryFailedError } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { MiMeta, MiNote, NoteReactionsRepository, NotesRepository, NoteRelationsRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { IdService } from '@/core/IdService.js';
import { PartitionMigrationStateService } from '@/core/PartitionMigrationStateService.js';
import { chunk, unique } from '@/misc/prelude/array.js';
import { PARTITION_PREFIX_LENGTH, groupByPrefix, nextPrefix, prefixOf, prefixesAscending } from '@/misc/partition.js';
import { deleteNotesWithDependents } from '@/misc/note-dependents.js';
import { deleteAfterRekey } from '@/misc/join-pending-children.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

// 走査位置はジョブを跨いで引き継ぐ
// Redisが飛んだ場合は先頭からやり直すだけで、データ不整合は起きない
const CURSOR_REDIS_KEY = 'cleanRemoteNotes:cursor';
const CURSOR_ORIGIN = '0';

// The condition for removing the notes.
// The note must be:
// - old enough (older than the newestLimit)
// - a remote note (userHost is not null).
// - not have clipped
// - not have pinned on the user profile
// - not has been favorite by any user
const removalCriteria = [
	'note."id" < :newestLimit',
	'note."clippedCount" = 0',
	'note."pageCount" = 0',
	'note."userHost" IS NOT NULL',
	'NOT EXISTS (SELECT 1 FROM clip_note WHERE "noteId" = note."id")',
	'NOT EXISTS (SELECT 1 FROM user_note_pining WHERE "noteId" = note."id")',
	'NOT EXISTS (SELECT 1 FROM note_favorite WHERE "noteId" = note."id")',
].join(' AND ');

const removalCriteriaLight = [
	'note."id" < :newestLimit',
	'note."userHost" IS NOT NULL',
].join(' AND ');

const protectionCriteria = [
	'note."clippedCount" <> 0',
	'note."pageCount" <> 0',
	'EXISTS (SELECT 1 FROM clip_note WHERE "noteId" = note."id")',
	'EXISTS (SELECT 1 FROM user_note_pining WHERE "noteId" = note."id")',
	'EXISTS (SELECT 1 FROM note_favorite WHERE "noteId" = note."id")',
].join(' OR ');

const parentIdsOf = (note: Pick<MiNote, 'replyId' | 'renoteId'>): MiNote['id'][] => [note.replyId, note.renoteId].filter((id): id is MiNote['id'] => id != null && id !== UNREFERENCEABLE_NOTE_ID);

const inClauseLimit = 500;

const maxVisitedPerBatch = 20000;

const maxPartitionsPerBatch = 64;

type WalkBudget = { visitedCount: number; overflowed: boolean };

type WalkGroup = { noteIds: MiNote['id'][]; boundaryIds: Set<MiNote['id']>; budget: WalkBudget };

@Injectable()
export class CleanRemoteNotesProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteRelationsRepository)
		private noteRelationsRepository: NoteRelationsRepository,

		@Inject(DI.noteReactionsRepository)
		private noteReactionsRepository: NoteReactionsRepository,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		private idService: IdService,
		private partitionMigrationStateService: PartitionMigrationStateService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('clean-remote-notes');
	}

	@bindThis
	private computeProgress(minId: string, maxId: string, cursorLeft: string) {
		const minTs = this.idService.parse(minId).date.getTime();
		const maxTs = this.idService.parse(maxId).date.getTime();
		const cursorTs = this.idService.parse(cursorLeft).date.getTime();

		return ((cursorTs - minTs) / (maxTs - minTs)) * 100;
	}

	@bindThis
	private async collectLocallyReactedNoteIds(em: EntityManager, noteIds: MiNote['id'][]): Promise<Set<MiNote['id']>> {
		const locallyReactedIds = new Set<MiNote['id']>();
		for (const group of groupByPrefix(noteIds).values()) {
			for (const ids of chunk(group, inClauseLimit)) {
				const rows = await this.noteReactionsRepository.createQueryBuilder('reaction', em.queryRunner)
					.select('reaction."noteId"', 'noteId')
					.distinct()
					.innerJoin('reaction.user', 'user')
					.where({ noteId: In(ids) })
					.andWhere('"user"."host" IS NULL')
					.getRawMany<{ noteId: MiNote['id'] }>();
				for (const row of rows) {
					locallyReactedIds.add(row.noteId);
				}
			}
		}
		return locallyReactedIds;
	}

	@bindThis
	private async collectExistingNoteIds(em: EntityManager, noteIds: MiNote['id'][]): Promise<Set<MiNote['id']>> {
		const existingIds = new Set<MiNote['id']>();
		for (const group of groupByPrefix(noteIds).values()) {
			for (const ids of chunk(group, inClauseLimit)) {
				const rows: { id: MiNote['id'] }[] = await em.query(
					`SELECT "id" FROM "note" WHERE "id" IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
					ids,
				);
				for (const row of rows) {
					existingIds.add(row.id);
				}
			}
		}
		return existingIds;
	}

	@bindThis
	private async hasProtectedNotes(em: EntityManager, noteIds: MiNote['id'][]): Promise<boolean> {
		for (const group of groupByPrefix(noteIds).values()) {
			for (const ids of chunk(group, inClauseLimit)) {
				const rows: unknown[] = await em.query(
					`SELECT 1 FROM "note" WHERE "id" IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) AND (${protectionCriteria}) LIMIT 1`,
					ids,
				);
				if (rows.length > 0) return true;
			}
		}
		return (await this.collectLocallyReactedNoteIds(em, noteIds)).size > 0;
	}

	@bindThis
	private async findAnchoredGroups(em: EntityManager, groups: WalkGroup[], from: 'childId' | 'parentId'): Promise<boolean[]> {
		const to = from === 'childId' ? 'parentId' : 'childId';
		const anchored = groups.map(() => false);
		const seenIds = groups.map(group => new Set(group.noteIds));
		let frontiers = groups.map(group => group.noteIds);
		while (frontiers.some(frontier => frontier.length > 0)) {
			const edges: { childId: MiNote['id']; parentId: MiNote['id'] }[] = await em.query(`SELECT "childId", "parentId" FROM "note_relation" WHERE "${from}" = ANY($1)`, [unique(frontiers.flat())]);
			const targetIdsOf = new Map<MiNote['id'], MiNote['id'][]>();
			for (const edge of edges) {
				const targetIds = targetIdsOf.get(edge[from]);
				if (targetIds != null) {
					targetIds.push(edge[to]);
				} else {
					targetIdsOf.set(edge[from], [edge[to]]);
				}
			}
			const nextIdsOf = frontiers.map((frontier, i) => {
				const nextIds = unique(frontier.flatMap(id => targetIdsOf.get(id) ?? []).filter(id => !seenIds[i].has(id) && !groups[i].boundaryIds.has(id)));
				for (const id of nextIds) seenIds[i].add(id);
				groups[i].budget.visitedCount += nextIds.length;
				if (nextIds.length > 0 && groups[i].budget.visitedCount > maxVisitedPerBatch) {
					groups[i].budget.overflowed = true;
					anchored[i] = true;
					return [];
				}
				return nextIds;
			});
			const existingIds = await this.collectExistingNoteIds(em, unique(nextIdsOf.flat()));
			frontiers = nextIdsOf.map((nextIds, i) => {
				if (nextIds.some(id => existingIds.has(id))) anchored[i] = true;
				return anchored[i] ? [] : nextIds;
			});
		}
		return anchored;
	}

	@bindThis
	private async collectChangedTrees(em: EntityManager, trees: { noteIds: MiNote['id'][]; formerIds: MiNote['id'][] }[], rootIds: MiNote['id'][], lockedIds: MiNote['id'][]): Promise<{ changed: boolean[]; overflowed: boolean }> {
		const lockedIdSet = new Set(lockedIds);
		const treeIdsOf = trees.map(tree => new Set([...tree.noteIds, ...tree.formerIds]));
		const treeOf = new Map<MiNote['id'], number>();
		treeIdsOf.forEach((ids, i) => {
			for (const id of ids) treeOf.set(id, i);
		});
		const outsideParentIdsOf = trees.map((): MiNote['id'][] => []);
		for (const group of groupByPrefix(rootIds.filter(id => lockedIdSet.has(id))).values()) {
			for (const ids of chunk(group, inClauseLimit)) {
				const roots: Pick<MiNote, 'id' | 'replyId' | 'renoteId'>[] = await em.query(
					`SELECT "id", "replyId", "renoteId" FROM "note" WHERE "id" IN (${ids.map((_, i) => `$${i + 1}`).join(', ')})`,
					ids,
				);
				for (const root of roots) {
					const i = treeOf.get(root.id);
					if (i != null) outsideParentIdsOf[i].push(...parentIdsOf(root).filter(id => !treeIdsOf[i].has(id)));
				}
			}
		}
		const formerRootIdsOf = trees.map((): MiNote['id'][] => []);
		for (const id of rootIds) {
			const i = treeOf.get(id);
			if (i != null && !lockedIdSet.has(id)) formerRootIdsOf[i].push(id);
		}
		const existingIds = await this.collectExistingNoteIds(em, unique(outsideParentIdsOf.flat()));
		const changed = outsideParentIdsOf.map(ids => ids.some(id => existingIds.has(id)));
		const budgets = trees.map((): WalkBudget => ({ visitedCount: 0, overflowed: false }));
		const walk = async (from: 'childId' | 'parentId', startIdsOf: (i: number) => MiNote['id'][]): Promise<void> => {
			const indexes = trees.flatMap((_, i) => changed[i] ? [] : [i]);
			const anchored = await this.findAnchoredGroups(em, indexes.map(i => ({ noteIds: startIdsOf(i), boundaryIds: treeIdsOf[i], budget: budgets[i] })), from);
			indexes.forEach((i, k) => {
				if (anchored[k]) changed[i] = true;
			});
		};
		await walk('childId', i => [...outsideParentIdsOf[i], ...formerRootIdsOf[i]]);
		await walk('parentId', i => [...treeIdsOf[i]]);
		return { changed, overflowed: budgets.some(budget => budget.overflowed) };
	}

	@bindThis
	private async collectRemovableTrees(rootIds: MiNote['id'][], newestLimit: string): Promise<{
		trees: { noteIds: MiNote['id'][]; formerIds: MiNote['id'][] }[];
		visitedCount: number;
		unfinishedRootId: MiNote['id'] | null;
	}> {
		const unionParent = new Map<string, string>();
		const find = (id: string): string => {
			let root = id;
			for (;;) {
				const parent = unionParent.get(root);
				if (parent == null || parent === root) return root;
				root = parent;
			}
		};
		const trees = new Map<string, { isRemovable: boolean; noteIds: MiNote['id'][]; formerIds: MiNote['id'][] }>();
		const merge = (a: string, b: string): void => {
			const rootA = find(a);
			const rootB = find(b);
			if (rootA === rootB) return;
			const treeA = trees.get(rootA)!;
			const treeB = trees.get(rootB)!;
			treeA.isRemovable = treeA.isRemovable && treeB.isRemovable;
			treeA.noteIds.push(...treeB.noteIds);
			treeA.formerIds.push(...treeB.formerIds);
			trees.delete(rootB);
			unionParent.set(rootB, rootA);
		};

		for (const rootId of rootIds) {
			unionParent.set(rootId, rootId);
			trees.set(rootId, { isRemovable: true, noteIds: [rootId], formerIds: [] });
		}

		let visitedCount = rootIds.length;
		let frontier = rootIds;

		while (frontier.length > 0 && visitedCount <= maxVisitedPerBatch) {
			const expandable = frontier.filter(id => trees.get(find(id))!.isRemovable);
			if (expandable.length === 0) break;

			const edges = [];
			for (const parentIds of chunk(expandable, inClauseLimit)) {
				edges.push(...await this.noteRelationsRepository.findBy({ parentId: In(parentIds) }));
			}

			const unseenChildIds = unique(edges.map(edge => edge.childId).filter(id => !unionParent.has(id)));
			const childRemovability = new Map<string, boolean>();
			for (const group of groupByPrefix(unseenChildIds).values()) {
				for (const childIds of chunk(group, inClauseLimit)) {
					const rows = await this.notesRepository.createQueryBuilder('note')
						.select('note."id"', 'id')
						.addSelect(removalCriteria, 'isRemovable')
						.where({ id: In(childIds) })
						.setParameters({ newestLimit })
						.getRawMany<{ id: MiNote['id'], isRemovable: boolean }>();
					const locallyReactedIds = await this.collectLocallyReactedNoteIds(this.db.manager, rows.filter(row => row.isRemovable).map(row => row.id));
					for (const row of rows) {
						childRemovability.set(row.id, row.isRemovable && !locallyReactedIds.has(row.id));
					}
				}
			}

			const nextFrontier: string[] = [];
			for (const edge of edges) {
				if (unionParent.has(edge.childId)) {
					merge(edge.parentId, edge.childId);
					continue;
				}
				const root = find(edge.parentId);
				unionParent.set(edge.childId, root);
				visitedCount++;
				const tree = trees.get(root)!;
				const isRemovable = childRemovability.get(edge.childId);
				if (isRemovable == null) {
					tree.formerIds.push(edge.childId);
					nextFrontier.push(edge.childId);
				} else if (isRemovable) {
					tree.noteIds.push(edge.childId);
					nextFrontier.push(edge.childId);
				} else {
					tree.isRemovable = false;
				}
			}

			frontier = nextFrontier;
		}

		const unfinished = new Set(frontier.map(find).filter(root => trees.get(root)!.isRemovable));
		return {
			trees: [...trees].filter(([root, tree]) => tree.isRemovable && !unfinished.has(root)).map(([, tree]) => tree),
			visitedCount,
			unfinishedRootId: rootIds.find(id => unfinished.has(find(id))) ?? null,
		};
	}

	@bindThis
	private logToJob(job: Bull.Job, msg: string): void {
		job.log(msg).catch(() => {});
	}

	@bindThis
	public async process(job: Bull.Job<Record<string, unknown>>): Promise<{
		deletedCount: number;
		oldest: number | null;
		newest: number | null;
		cursor: string | null;
		skipped: boolean;
		transientErrors: number;
	}> {
		const getConfig = () => {
			return {
				enabled: this.meta.enableRemoteNotesCleaning,
				maxDuration: this.meta.remoteNotesCleaningMaxProcessingDurationInMinutes * 60 * 1000, // Convert minutes to milliseconds
				// The date limit for the newest note to be considered for deletion.
				// All notes newer than this limit will always be retained.
				newestLimit: this.idService.gen(Date.now() - (1000 * 60 * 60 * 24 * this.meta.remoteNotesCleaningExpiryDaysForEachNotes), true),
			};
		};

		const storedCursor = await this.redisClient.get(CURSOR_REDIS_KEY);

		const initialConfig = getConfig();
		if (!this.meta.enableRemoteNotesCleaning) {
			this.logger.info('Remote notes cleaning is disabled, skipping...');
			return {
				deletedCount: 0,
				oldest: null,
				newest: null,
				cursor: storedCursor,
				skipped: true,
				transientErrors: 0,
			};
		}

		if (!await this.partitionMigrationStateService.isPhaseFinished('noteRelationBackfill')) {
			this.logger.info('Note relations are not backfilled yet, skipping...');
			return {
				deletedCount: 0,
				oldest: null,
				newest: null,
				cursor: storedCursor,
				skipped: true,
				transientErrors: 0,
			};
		}

		this.logger.info('cleaning remote notes...');

		const startAt = Date.now();

		let minId: MiNote['id'] | undefined;
		for (const prefix of prefixesAscending(undefined, prefixOf(initialConfig.newestLimit))) {
			const upper = nextPrefix(prefix);
			const query = this.notesRepository.createQueryBuilder('note')
				.select('MIN(note.id)', 'minId')
				.where('note."id" >= :lower', { lower: prefix })
				.andWhere(removalCriteriaLight)
				.setParameters({ newestLimit: initialConfig.newestLimit });
			if (upper != null) query.andWhere('note."id" < :upper', { upper });
			minId = (await query.getRawOne<{ minId?: MiNote['id'] }>())?.minId ?? undefined;
			if (minId != null) break;
		}

		if (!minId) {
			this.logger.info('No notes can possibly be deleted, skipping...');
			await this.redisClient.del(CURSOR_REDIS_KEY);
			return {
				deletedCount: 0,
				oldest: null,
				newest: null,
				cursor: null,
				skipped: false,
				transientErrors: 0,
			};
		}

		const oldestId = minId;

		// start with a conservative limit and adjust it based on the query duration
		const minimumLimit = 10;
		let currentLimit = 100;

		let cursorLeft = (storedCursor !== null && storedCursor < initialConfig.newestLimit) ? storedCursor : CURSOR_ORIGIN;
		if (cursorLeft !== CURSOR_ORIGIN) {
			job.log(`Resuming from the cursor left by a previous run: ${cursorLeft}`);
		}

		// 末尾まで到達したら保存済みカーソルを捨て、次回の実行を先頭から始める
		// クリップ解除やお気に入り解除で後から削除可能になったノートを拾い直すために必要
		const restartFromBeginningNextTime = async () => {
			await this.redisClient.del(CURSOR_REDIS_KEY);
			cursorLeft = CURSOR_ORIGIN;
		};

		// tree walk down all root notes, short-circuit when the first unremovable note is found
		const collectRootIds = async (cursorLeft: string, newestLimit: string, limit: number, light: boolean, budget: WalkBudget): Promise<{
			rootIds: MiNote['id'][];
			scannedTo: string;
			exhausted: boolean;
		}> => {
			const fromPrefix = cursorLeft.length >= PARTITION_PREFIX_LENGTH ? prefixOf(cursorLeft) : prefixOf(oldestId);
			const rootIds: MiNote['id'][] = [];
			let scannedTo = cursorLeft;
			let exhausted = true;
			let scanned = 0;
			let pageSize = limit;
			for (const prefix of prefixesAscending(fromPrefix, prefixOf(newestLimit))) {
				if (scanned >= maxPartitionsPerBatch) {
					exhausted = false;
					break;
				}
				scanned++;
				const upper = nextPrefix(prefix);
				let after = cursorLeft;
				for (;;) {
					const query = this.notesRepository.createQueryBuilder('note')
						.select('note."id"', 'id')
						.addSelect('note."replyId"', 'replyId')
						.addSelect('note."renoteId"', 'renoteId')
						.where('note."id" > :cursorLeft', { cursorLeft: after })
						.andWhere('note."id" >= :lower', { lower: prefix })
						.andWhere(light ? removalCriteriaLight : removalCriteria)
						.orderBy('note.id', 'ASC')
						.limit(pageSize)
						.setParameters({ newestLimit });
					if (upper != null) query.andWhere('note."id" < :upper', { upper });
					const rows = await query.getRawMany<{ id: MiNote['id'], replyId: MiNote['replyId'], renoteId: MiNote['renoteId'] }>();
					const existingIds = await this.collectExistingNoteIds(this.db.manager, unique(rows.flatMap(parentIdsOf)));
					const orphans = rows.filter(row => parentIdsOf(row).every(id => !existingIds.has(id)));
					const locallyReactedIds = light ? new Set<MiNote['id']>() : await this.collectLocallyReactedNoteIds(this.db.manager, orphans.map(row => row.id));
					const candidateIds = new Set(orphans.filter(row => !locallyReactedIds.has(row.id)).map(row => row.id));
					for (const row of rows) {
						if (candidateIds.has(row.id)) {
							const walkBudget: WalkBudget = { visitedCount: budget.visitedCount, overflowed: false };
							const [anchored] = await this.findAnchoredGroups(this.db.manager, [{ noteIds: parentIdsOf(row), boundaryIds: new Set(), budget: walkBudget }], 'childId');
							if (walkBudget.overflowed) {
								if (budget.visitedCount > 0) return { rootIds, scannedTo, exhausted: false };
								budget.overflowed = true;
							} else {
								budget.visitedCount = walkBudget.visitedCount;
								if (!anchored) rootIds.push(row.id);
							}
						}
						scannedTo = row.id;
						if (rootIds.length >= limit) return { rootIds, scannedTo, exhausted: false };
					}
					if (rows.length < pageSize) break;
					after = rows[rows.length - 1].id;
					pageSize = Math.min(pageSize * 2, Math.max(limit, inClauseLimit));
				}
				scannedTo = upper ?? newestLimit;
			}
			return { rootIds, scannedTo, exhausted };
		};

		const stats = {
			deletedCount: 0,
			oldest: null as number | null,
			newest: null as number | null,
		};

		let lowThroughputWarned = false;
		let transientErrors = 0;
		let aloneRootId: MiNote['id'] | null = null;
		for (;;) {
			const { enabled, maxDuration, newestLimit } = getConfig();
			if (!enabled) {
				this.logger.info('Remote notes cleaning is disabled, processing stopped...');
				break;
			}
			//#region check time
			const batchBeginAt = Date.now();

			const elapsed = batchBeginAt - startAt;

			const progress = this.computeProgress(minId, newestLimit, cursorLeft > minId ? cursorLeft : minId);

			if (elapsed >= maxDuration) {
				job.log(`Reached maximum duration of ${maxDuration}ms, stopping... (last cursor: ${cursorLeft}, final progress ${progress}%)`);
				job.updateProgress(100);
				break;
			}

			const wallClockUsage = elapsed / maxDuration;
			if (wallClockUsage > 0.5 && progress < 50 && !lowThroughputWarned) {
				const msg = `Not projected to finish in time! (wall clock usage ${wallClockUsage * 100}% at ${progress}%, current limit ${currentLimit})`;
				this.logger.warn(msg);
				job.log(msg);
				lowThroughputWarned = true;
			}
			job.updateProgress(progress);
			//#endregion

			const queryBegin = performance.now();
			const budget: WalkBudget = { visitedCount: 0, overflowed: false };
			let rootWindow = null;
			let collected = null;

			try {
				rootWindow = aloneRootId != null
					? { rootIds: [aloneRootId], scannedTo: aloneRootId, exhausted: false }
					: await collectRootIds(cursorLeft, newestLimit, currentLimit, false, budget);

				if (rootWindow.rootIds.length === 0) {
					if (budget.overflowed) {
						this.logToJob(job, `Note tree walk overflowed ${maxVisitedPerBatch} notes, unfinished trees are skipped... (last cursor: ${cursorLeft})`);
					}
					if (rootWindow.exhausted) {
						job.log('No more notes to clean. The next run will start from the beginning.');
						await restartFromBeginningNextTime();
						break;
					}
					cursorLeft = rootWindow.scannedTo;
					await this.redisClient.set(CURSOR_REDIS_KEY, cursorLeft);
					continue;
				}

				collected = await this.collectRemovableTrees(rootWindow.rootIds, newestLimit);
			} catch (e) {
				if (e instanceof QueryFailedError && e.driverError?.code === '57014') {
					// Statement timeout (maybe suddenly hit a large note tree), if possible, reduce the limit and try again
					// if not possible, skip the current batch of notes and find the next root note
					if (currentLimit <= minimumLimit) {
						aloneRootId = null;
						job.log('Local note tree complexity is too high, finding next root note...');

						const idWindowBudget: WalkBudget = { visitedCount: 0, overflowed: false };
						const idWindow = await collectRootIds(cursorLeft, newestLimit, minimumLimit + 1, true, idWindowBudget);

						if (budget.overflowed || idWindowBudget.overflowed) {
							this.logToJob(job, `Note tree walk overflowed ${maxVisitedPerBatch} notes, unfinished trees are skipped... (last cursor: ${cursorLeft})`);
						}

						job.log(`Skipped note IDs: ${idWindow.rootIds.slice(0, minimumLimit).join(', ')}`);

						const lastId = idWindow.rootIds.at(minimumLimit);

						if (!lastId) {
							if (idWindow.exhausted) {
								job.log('No more notes to clean. The next run will start from the beginning.');
								await restartFromBeginningNextTime();
								break;
							}
							cursorLeft = idWindow.scannedTo;
							await this.redisClient.set(CURSOR_REDIS_KEY, cursorLeft);
							continue;
						}

						cursorLeft = lastId;

						// 毎バッチtimeoutし続ける場合、ここを保存しないと一晩ぶんの前進が失われる
						await this.redisClient.set(CURSOR_REDIS_KEY, cursorLeft);
						continue;
					}
					currentLimit = Math.max(minimumLimit, Math.floor(currentLimit * 0.25));
					continue;
				}
				throw e;
			}

			const queryDuration = performance.now() - queryBegin;
			// try to adjust such that each query takes about 1~5 seconds and reasonable NodeJS heap so the task stays responsive
			// this should not oscillate..
			if (queryDuration > 5000 || collected.visitedCount > 5000) {
				currentLimit = Math.floor(currentLimit * 0.5);
			} else if (queryDuration < 1000 && collected.visitedCount < 1000) {
				currentLimit = Math.floor(currentLimit * 1.5);
			}
			// clamp to a sane range
			currentLimit = Math.min(Math.max(currentLimit, minimumLimit), 5000);

			const { trees, unfinishedRootId } = collected;
			const deletableNoteIds = trees.flatMap(tree => tree.noteIds);
			if (deletableNoteIds.length > 0) {
				const rootIds = rootWindow.rootIds;
				try {
					const evicted = await deleteAfterRekey(this.db, this.idService, deletableNoteIds, async (transactionalEntityManager, lockedIds) => {
						if (await this.hasProtectedNotes(transactionalEntityManager, lockedIds)) return null;
						const changes = await this.collectChangedTrees(transactionalEntityManager, trees, rootIds, lockedIds);
						if (changes.overflowed) budget.overflowed = true;
						const evictableTrees = trees.filter((_, i) => !changes.changed[i]);
						if (evictableTrees.length === 0) return null;
						const deleted = await deleteNotesWithDependents(transactionalEntityManager, evictableTrees.flatMap(tree => tree.noteIds), { record: false });
						const deletedIds = new Set(deleted);
						const evictedTrees = evictableTrees.filter(tree => tree.noteIds.some(id => deletedIds.has(id)));
						await transactionalEntityManager.query('DELETE FROM "note_uri" WHERE "noteId" = ANY($1)', [deleted]);
						await transactionalEntityManager.query(
							'DELETE FROM "note_relation" WHERE "childId" = ANY($1) OR "parentId" = ANY($1)',
							[evictedTrees.flatMap(tree => [...tree.noteIds, ...tree.formerIds])],
						);
						return { deletedNoteIds: deleted, changed: evictableTrees.length < trees.length };
					});

					if (evicted == null || evicted.changed) {
						transientErrors++;
						this.logToJob(job, 'Note trees changed while cleaning, skipped... (transient race condition?)');
					}
					if (evicted != null) {
						for (const id of evicted.deletedNoteIds) {
							const t = this.idService.parse(id).date.getTime();
							if (stats.oldest === null || t < stats.oldest) {
								stats.oldest = t;
							}
							if (stats.newest === null || t > stats.newest) {
								stats.newest = t;
							}
						}

						stats.deletedCount += evicted.deletedNoteIds.length;
					}
				} catch (e) {
					// check for integrity violation errors (class 23) that might have occurred between the check and the delete
					// we can safely continue to the next batch
					if (e instanceof QueryFailedError && e.driverError?.code?.startsWith('23')) {
						transientErrors++;
						job.log(`Error deleting notes: ${e} (transient race condition?)`);
					} else {
						throw e;
					}
				}
			}

			if (unfinishedRootId != null && rootWindow.rootIds.length === 1) {
				budget.overflowed = true;
			}

			if (budget.overflowed) {
				this.logToJob(job, `Note tree walk overflowed ${maxVisitedPerBatch} notes, unfinished trees are skipped... (last cursor: ${cursorLeft})`);
			}

			if (unfinishedRootId != null && rootWindow.rootIds.length > 1) {
				const i = rootWindow.rootIds.indexOf(unfinishedRootId);
				if (i > 0) cursorLeft = rootWindow.rootIds[i - 1];
				aloneRootId = unfinishedRootId;
			} else {
				cursorLeft = rootWindow.scannedTo;
				aloneRootId = null;
			}
			// 途中でジョブが落ちても進捗を失わないよう、バッチごとに保存する
			await this.redisClient.set(CURSOR_REDIS_KEY, cursorLeft);

			job.log(`Deleted ${collected.visitedCount} notes; ${Date.now() - batchBeginAt}ms`);

			if (process.env.NODE_ENV !== 'test') {
				await setTimeout(Math.min(1000 * 5, queryDuration)); // Wait a moment to avoid overwhelming the db
			}
		};

		if (transientErrors > 0) {
			const msg = `${transientErrors} transient errors occurred while cleaning remote notes. You may need a second pass to complete the cleaning.`;
			this.logger.warn(msg);
			job.log(msg);
		}
		this.logger.succ('cleaning of remote notes completed.');

		return {
			deletedCount: stats.deletedCount,
			oldest: stats.oldest,
			newest: stats.newest,
			cursor: cursorLeft === CURSOR_ORIGIN ? null : cursorLeft,
			skipped: false,
			transientErrors,
		};
	}
}
