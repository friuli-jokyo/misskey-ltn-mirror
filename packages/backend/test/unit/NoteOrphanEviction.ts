/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { DataSource, In, QueryFailedError } from 'typeorm';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { sweepPendingParents } from '@/misc/join-pending-children.js';
import { prefixOf } from '@/misc/partition.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { CleanRemoteNotesProcessorService } from '@/queue/processors/CleanRemoteNotesProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import type { Config } from '@/config.js';
import type {
	ClipNotesRepository,
	ClipsRepository,
	MiMeta,
	MiNote,
	MiUser,
	NoteFavoritesRepository,
	NotePendingParentsRepository,
	NoteReactionsRepository,
	NoteRelationsRepository,
	NotesRepository,
	NoteUrisRepository,
	PollsRepository,
	PollVotesRepository,
	PromoNotesRepository,
	PromoReadsRepository,
	UserNotePiningsRepository,
	UserProfilesRepository,
	UsersRepository,
} from '@/models/_.js';
import type { EntitySubscriberInterface, QueryRunner } from 'typeorm';

const dependentTables = [
	['poll', 'noteId'],
	['poll_vote', 'noteId'],
	['note_favorite', 'noteId'],
	['clip_note', 'noteId'],
	['user_note_pining', 'noteId'],
	['promo_note', 'noteId'],
	['promo_read', 'noteId'],
	['note_reaction', 'noteId'],
	['note_pending_parent', 'childId'],
] as const;

type DependentTable = typeof dependentTables[number][0];

const day = 1000 * 60 * 60 * 24;

const gateKey = 7_340_918;

const overflowLog = /^Note tree walk overflowed /;

describe('Orphan note eviction', () => {
	let app: TestingModule;
	let fastify: FastifyInstance;
	let db: DataSource;
	let config: Config;
	let meta: MiMeta;
	let idService: IdService;
	let noteCreateService: NoteCreateService;
	let noteDeleteService: NoteDeleteService;
	let apDbResolverService: ApDbResolverService;
	let cleanRemoteNotesProcessorService: CleanRemoteNotesProcessorService;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let noteRelationsRepository: NoteRelationsRepository;
	let noteUrisRepository: NoteUrisRepository;
	let notePendingParentsRepository: NotePendingParentsRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let noteFavoritesRepository: NoteFavoritesRepository;
	let pollsRepository: PollsRepository;
	let pollVotesRepository: PollVotesRepository;
	let clipsRepository: ClipsRepository;
	let clipNotesRepository: ClipNotesRepository;
	let userNotePiningsRepository: UserNotePiningsRepository;
	let promoNotesRepository: PromoNotesRepository;
	let promoReadsRepository: PromoReadsRepository;
	let local: MiUser;
	let remote: MiUser;
	let reactor: MiUser;
	let old: number;

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createNote(user: MiUser, data: Partial<MiNote> = {}, time?: number): Promise<MiNote> {
		const id = idService.gen(time);
		const uri = user.host != null ? `https://${user.host}/notes/${id}` : null;
		await notesRepository.insert({ id, text: `note_${id}`, userId: user.id, userHost: user.host, uri, visibility: 'public', ...data });
		if (uri != null) {
			await noteUrisRepository.insert({ uri, noteId: id });
		}
		const note = await notesRepository.findOneByOrFail({ id });
		if (note.replyId != null && note.replyId !== UNREFERENCEABLE_NOTE_ID) {
			await noteRelationsRepository.insert({ childId: id, parentId: note.replyId, kind: 0 });
		}
		if (note.renoteId != null && note.renoteId !== UNREFERENCEABLE_NOTE_ID) {
			const isQuote = note.text != null || note.cw != null || note.replyId != null || note.hasPoll || note.fileIds.length > 0;
			await noteRelationsRepository.insert({ childId: id, parentId: note.renoteId, kind: isQuote ? 1 : 2 });
		}
		return note;
	}

	function uniqueUri(): string {
		return `https://remote.example.com/notes/${secureRndstr(16)}`;
	}

	async function attachDependents(note: MiNote, by: MiUser, except: DependentTable[] = []): Promise<void> {
		const tables = new Set<DependentTable>(dependentTables.map(([table]) => table).filter(table => !except.includes(table)));
		if (tables.has('poll')) {
			await pollsRepository.insert({ noteId: note.id, multiple: false, choices: ['a', 'b'], votes: [1, 0], expiresAt: null, noteVisibility: note.visibility, userId: note.userId, userHost: note.userHost, channelId: null });
		}
		if (tables.has('poll_vote')) {
			await pollVotesRepository.insert({ id: idService.gen(), userId: by.id, noteId: note.id, choice: 0 });
		}
		if (tables.has('note_favorite')) {
			await noteFavoritesRepository.insert({ id: idService.gen(), userId: by.id, noteId: note.id });
		}
		if (tables.has('clip_note')) {
			const clipId = idService.gen();
			await clipsRepository.insert({ id: clipId, userId: by.id, name: secureRndstr(8) });
			await clipNotesRepository.insert({ id: idService.gen(), noteId: note.id, clipId });
		}
		if (tables.has('user_note_pining')) {
			await userNotePiningsRepository.insert({ id: idService.gen(), userId: note.userId, noteId: note.id });
		}
		if (tables.has('promo_note')) {
			await promoNotesRepository.insert({ noteId: note.id, expiresAt: new Date(Date.now() + 1000 * 60 * 60), userId: note.userId });
		}
		if (tables.has('promo_read')) {
			await promoReadsRepository.insert({ id: idService.gen(), userId: by.id, noteId: note.id });
		}
		if (tables.has('note_reaction')) {
			await noteReactionsRepository.insert({ id: idService.gen(), userId: by.id, noteId: note.id, reaction: '👍' });
		}
		if (tables.has('note_pending_parent')) {
			await notePendingParentsRepository.insert({ parentUri: uniqueUri(), childId: note.id, kind: 1 });
		}
	}

	async function countDependents(noteId: MiNote['id']): Promise<Record<DependentTable, number>> {
		const counts = {} as Record<DependentTable, number>;
		for (const [table, column] of dependentTables) {
			const [{ count }]: { count: number }[] = await db.query(`SELECT count(*)::int AS "count" FROM "${table}" WHERE "${column}" = $1`, [noteId]);
			counts[table] = count;
		}
		return counts;
	}

	function dependentCounts(count: number): Record<DependentTable, number> {
		return Object.fromEntries(dependentTables.map(([table]) => [table, count])) as Record<DependentTable, number>;
	}

	async function clean() {
		return await cleanRemoteNotesProcessorService.process({ log: vi.fn().mockResolvedValue(0), updateProgress: vi.fn() } as never);
	}

	async function cleanLogged(): Promise<{ result: Awaited<ReturnType<typeof clean>>; logs: string[] }> {
		const log = vi.fn().mockResolvedValue(0);
		const result = await cleanRemoteNotesProcessorService.process({ log, updateProgress: vi.fn() } as never);
		return { result, logs: log.mock.calls.map(([message]) => message as string) };
	}

	async function backendPid(runner: QueryRunner): Promise<number> {
		const [{ pid }]: { pid: number }[] = await runner.query('SELECT pg_backend_pid() AS "pid"');
		return pid;
	}

	async function blockedPid(pid: number, statement: RegExp): Promise<number | undefined> {
		const rows: { pid: number; query: string }[] = await db.query('SELECT "pid", "query" FROM "pg_stat_activity" WHERE $1 = ANY(pg_blocking_pids("pid"))', [pid]);
		return rows.find(row => statement.test(row.query))?.pid;
	}

	async function blockedBy(pid: number, statement: RegExp): Promise<boolean> {
		return await blockedPid(pid, statement) != null;
	}

	async function waitUntil<T>(condition: () => Promise<T | false | undefined>): Promise<T> {
		for (let i = 0; i < 200; i++) {
			const result = await condition();
			if (result) return result;
			await setTimeout(25);
		}
		throw new Error('timed out');
	}

	async function afterFirstQuery<T>(pattern: RegExp, hook: (runner: QueryRunner) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
		let fired = false;
		const subscriber: EntitySubscriberInterface = {
			afterQuery: async event => {
				if (fired || !pattern.test(event.query)) return;
				fired = true;
				await hook(event.queryRunner);
			},
		};
		db.subscribers.push(subscriber);
		try {
			return await run();
		} finally {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			expect(fired).toBe(true);
		}
	}

	async function insertDeletedAncestors(depth: number, head = '00', fromDepth = 0): Promise<MiNote['id']> {
		await db.query(`
			INSERT INTO "note_relation" ("childId", "parentId", "kind")
			SELECT $1 || lpad((100000000 - n)::text, 8, '0'), $1 || lpad((100000000 - 2 * n - k)::text, 8, '0'), k
			FROM generate_series($2::int, $3::int) AS n, generate_series(0, 1) AS k
		`, [head, 2 ** fromDepth, 2 ** depth - 1]);
		return `${head}99999999`;
	}

	async function insertDeletedEdges(childIds: MiNote['id'][], parentIds: MiNote['id'][]): Promise<void> {
		await db.query('INSERT INTO "note_relation" ("childId", "parentId", "kind") SELECT "childId", "parentId", 0 FROM unnest($1::varchar[], $2::varchar[]) AS t("childId", "parentId")', [childIds, parentIds]);
	}

	async function insertDeletedReplies(parentId: MiNote['id'], count: number, time: number): Promise<void> {
		const ids = Array.from({ length: count }, (_, i) => idService.gen(time + i));
		await insertDeletedEdges(ids, ids.map(() => parentId));
	}

	async function insertDeletedThread(parentId: MiNote['id'], length: number, time: number): Promise<MiNote['id']> {
		const ids = Array.from({ length }, (_, i) => idService.gen(time + i));
		await insertDeletedEdges(ids, [parentId, ...ids.slice(0, -1)]);
		return ids[ids.length - 1];
	}

	function afterWalk(hook: () => Promise<unknown>): void {
		const service = cleanRemoteNotesProcessorService as unknown as { collectRemovableTrees: (...args: unknown[]) => Promise<unknown> };
		const walk = service.collectRemovableTrees;
		vi.spyOn(service, 'collectRemovableTrees').mockImplementationOnce(async (...args) => {
			const collected = await walk(...args);
			await hook();
			return collected;
		});
	}

	function recordRootWindows(): MiNote['id'][][] {
		const windows: MiNote['id'][][] = [];
		const service = cleanRemoteNotesProcessorService as unknown as { collectRemovableTrees: (rootIds: MiNote['id'][], ...args: unknown[]) => Promise<unknown> };
		const walk = service.collectRemovableTrees;
		vi.spyOn(service, 'collectRemovableTrees').mockImplementation(async (rootIds, ...args) => {
			windows.push([...rootIds]);
			return await walk(rootIds, ...args);
		});
		return windows;
	}

	async function beforeFirstQuery<T>(pattern: RegExp, hook: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
		let fired = false;
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: async event => {
				if (fired || !pattern.test(event.query)) return;
				fired = true;
				await hook();
			},
		};
		db.subscribers.push(subscriber);
		try {
			return await run();
		} finally {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			expect(fired).toBe(true);
		}
	}

	async function joinPendingChildren(parent: MiNote): Promise<void> {
		await (noteCreateService as unknown as { joinPendingChildren: (parent: MiNote) => Promise<void> }).joinPendingChildren(parent);
	}

	async function getNote(id: MiNote['id']) {
		return await fastify.inject({
			method: 'GET',
			url: `/notes/${id}`,
			headers: { accept: 'application/activity+json' },
		});
	}

	async function getActivity(id: MiNote['id']) {
		return await fastify.inject({
			method: 'GET',
			url: `/notes/${id}/activity`,
			headers: { accept: 'application/activity+json' },
		});
	}

	async function recordedIds(noteIds: MiNote['id'][]): Promise<MiNote['id'][]> {
		const rows: { id: MiNote['id'] }[] = await db.query('SELECT "id" FROM "deleted_note" WHERE "id" = ANY($1) ORDER BY "id"', [noteIds]);
		return rows.map(row => row.id);
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				CleanRemoteNotesProcessorService,
				ActivityPubServerService,
				{
					provide: QueueLoggerService,
					useFactory: () => ({
						logger: {
							createSubLogger: () => ({ info: vi.fn(), warn: vi.fn(), succ: vi.fn(), error: vi.fn() }),
						},
					}),
				},
			],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		config = app.get(DI.config);
		meta = app.get(DI.meta);
		idService = app.get(IdService);
		noteCreateService = app.get(NoteCreateService);
		noteDeleteService = app.get(NoteDeleteService);
		apDbResolverService = app.get(ApDbResolverService);
		cleanRemoteNotesProcessorService = app.get(CleanRemoteNotesProcessorService);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		noteRelationsRepository = app.get(DI.noteRelationsRepository);
		noteUrisRepository = app.get(DI.noteUrisRepository);
		notePendingParentsRepository = app.get(DI.notePendingParentsRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		noteFavoritesRepository = app.get(DI.noteFavoritesRepository);
		pollsRepository = app.get(DI.pollsRepository);
		pollVotesRepository = app.get(DI.pollVotesRepository);
		clipsRepository = app.get(DI.clipsRepository);
		clipNotesRepository = app.get(DI.clipNotesRepository);
		userNotePiningsRepository = app.get(DI.userNotePiningsRepository);
		promoNotesRepository = app.get(DI.promoNotesRepository);
		promoReadsRepository = app.get(DI.promoReadsRepository);

		await db.query(`
			DO $$
			DECLARE
				r record;
			BEGIN
				FOR r IN SELECT conname, conrelid::regclass::text AS tbl FROM pg_constraint
					WHERE contype = 'f' AND (confrelid IN ('note'::regclass, 'note_reaction'::regclass) OR conrelid IN ('note'::regclass, 'note_reaction'::regclass))
				LOOP
					EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
				END LOOP;
			END $$
		`);
		await db.query('INSERT INTO "partition_migration_state" ("name", "finishedAt") VALUES (\'noteRelationBackfill\', now())');

		meta.federation = 'all';

		local = await createUser();
		remote = await createUser({ host: 'remote.example.com' });
		reactor = await createUser({ host: 'reactor.example.com' });

		fastify = Fastify();
		await fastify.register(app.get(ActivityPubServerService).createServer);
		await fastify.ready();
	});

	beforeEach(() => {
		meta.enableRemoteNotesCleaning = true;
		meta.remoteNotesCleaningMaxProcessingDurationInMinutes = 0.3;
		meta.remoteNotesCleaningExpiryDaysForEachNotes = 30;
		old = Date.now() - day * 31;
	});

	afterEach(async () => {
		for (const table of ['note', 'note_relation', 'note_uri', 'deleted_note', 'note_unlinked_relation', ...dependentTables.map(([table]) => table)]) {
			await db.query(`DELETE FROM "${table}"`);
		}
	});

	afterAll(async () => {
		await fastify.close();
		await app.close();
	});

	test('evicts an orphan of a deleted remote parent together with its replies and their dependents', async () => {
		const parent = await createNote(remote, {}, old - 3000);
		const orphan = await createNote(remote, { replyId: parent.id }, old - 2000);
		const reply = await createNote(remote, { replyId: orphan.id }, old - 1000);
		const protectors: DependentTable[] = ['note_favorite', 'clip_note', 'user_note_pining'];
		await attachDependents(orphan, reactor, protectors);
		await attachDependents(reply, reactor, protectors);
		await noteDeleteService.delete(remote, parent, true);

		const result = await clean();

		expect(result.deletedCount).toBe(2);
		expect(await notesRepository.existsBy({ id: In([orphan.id, reply.id]) })).toBe(false);
		expect(await countDependents(orphan.id)).toEqual(dependentCounts(0));
		expect(await countDependents(reply.id)).toEqual(dependentCounts(0));
		expect(await noteUrisRepository.existsBy({ noteId: In([orphan.id, reply.id]) })).toBe(false);
		expect(await noteRelationsRepository.existsBy({ childId: In([orphan.id, reply.id]) })).toBe(false);
		expect(await noteUrisRepository.existsBy({ noteId: parent.id })).toBe(true);
	});

	test('evicts the orphans whose parents cannot be referenced', async () => {
		const reply = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 3000);
		const quote = await createNote(remote, { renoteId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		const child = await createNote(remote, { replyId: reply.id }, old - 1000);
		await notePendingParentsRepository.insert([
			{ parentUri: uniqueUri(), childId: reply.id, kind: 0 },
			{ parentUri: uniqueUri(), childId: quote.id, kind: 1 },
		]);

		const result = await clean();

		expect(result.deletedCount).toBe(3);
		expect(await notesRepository.existsBy({ id: In([reply.id, quote.id, child.id]) })).toBe(false);
		expect(await notePendingParentsRepository.existsBy({ childId: In([reply.id, quote.id]) })).toBe(false);
		expect(await noteUrisRepository.existsBy({ noteId: In([reply.id, quote.id, child.id]) })).toBe(false);
		expect(await noteRelationsRepository.existsBy({ parentId: reply.id })).toBe(false);
	});

	test('takes a note as a root when the top of its tree is gone through deleted notes', async () => {
		const top = await createNote(remote, {}, old - 9000);
		const middle = await createNote(remote, { replyId: top.id }, old - 8000);
		const orphan = await createNote(remote, { replyId: middle.id }, old - 7000);
		const orphanReply = await createNote(remote, { replyId: orphan.id }, old - 6000);
		const waiting = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 5000);
		const quoteOfWaiting = await createNote(remote, { renoteId: waiting.id }, old - 4000);
		const localTop = await createNote(local, {}, old - 3000);
		const localMiddle = await createNote(local, { replyId: localTop.id }, old - 2000);
		const replyToLocal = await createNote(remote, { replyId: localMiddle.id }, old - 1000);
		for (const note of [top, middle, waiting]) {
			await noteDeleteService.delete(remote, note, true);
		}
		for (const note of [localTop, localMiddle]) {
			await noteDeleteService.delete(local, note, true);
		}

		const result = await clean();

		const evictedIds = [orphan, orphanReply, quoteOfWaiting, replyToLocal].map(note => note.id);
		expect(result).toMatchObject({ deletedCount: evictedIds.length, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In(evictedIds) })).toBe(false);
		expect(await noteUrisRepository.existsBy({ noteId: In(evictedIds) })).toBe(false);
		expect(await noteRelationsRepository.existsBy([{ childId: In(evictedIds) }, { parentId: In(evictedIds) }])).toBe(false);
		expect(await noteUrisRepository.countBy({ noteId: In([top.id, middle.id, waiting.id]) })).toBe(3);
		expect(await noteRelationsRepository.findBy({ childId: In([middle.id, localMiddle.id]) })).toEqual(expect.arrayContaining([
			expect.objectContaining({ childId: middle.id, parentId: top.id, kind: 0 }),
			expect.objectContaining({ childId: localMiddle.id, parentId: localTop.id, kind: 0 }),
		]));
		expect((await getNote(localMiddle.id)).statusCode).toBe(200);
	});

	test('forgets the edges of evicted orphans to their deleted parents, while a deleted local parent left without edges still answers a Tombstone', async () => {
		const liveParent = await createNote(local, {}, old - 6000);
		const localParent = await createNote(local, {}, old - 5000);
		const remoteParent = await createNote(remote, {}, old - 4000);
		const root = await createNote(remote, {}, old - 3000);
		const orphan = await createNote(remote, { replyId: localParent.id, renoteId: remoteParent.id }, old - 2000);
		const renote = await createNote(remote, { renoteId: localParent.id, text: null }, old - 1000);
		const quote = await createNote(remote, { replyId: root.id, renoteId: liveParent.id }, old);
		await noteDeleteService.delete(local, localParent, true);
		await noteDeleteService.delete(remote, remoteParent, true);
		expect((await getNote(localParent.id)).json()).toMatchObject({ id: `${config.url}/notes/${localParent.id}`, type: 'Tombstone' });

		const result = await clean();

		const evictedIds = [root, orphan, renote, quote].map(note => note.id);
		expect(result).toMatchObject({ deletedCount: evictedIds.length, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In(evictedIds) })).toBe(false);
		expect(await noteUrisRepository.existsBy({ noteId: In(evictedIds) })).toBe(false);
		expect(await noteRelationsRepository.existsBy([{ childId: In(evictedIds) }, { parentId: In(evictedIds) }])).toBe(false);
		expect(await notesRepository.existsBy({ id: liveParent.id })).toBe(true);
		expect(await noteUrisRepository.existsBy({ noteId: remoteParent.id })).toBe(true);
		expect(await noteRelationsRepository.existsBy([{ childId: localParent.id }, { parentId: localParent.id }])).toBe(false);
		expect(await recordedIds([localParent.id, remoteParent.id, ...evictedIds])).toEqual([localParent.id, remoteParent.id].sort());
		expect((await getNote(localParent.id)).json()).toMatchObject({ id: `${config.url}/notes/${localParent.id}`, type: 'Tombstone' });
		expect(await apDbResolverService.getNoteReferenceFromApId(`${config.url}/notes/${localParent.id}`)).toEqual({ note: null, formerId: localParent.id });
	});

	test('keeps the edges of a deleted local parent outside the evicted tree, so a late reply still takes the thread of a live sibling', async () => {
		const top = await createNote(local, {}, old - 9000);
		const localParent = await createNote(local, { replyId: top.id, threadId: top.id }, old - 8000);
		const evicted = await createNote(remote, { replyId: localParent.id, threadId: top.id }, old - 7000);
		const live = await createNote(local, { replyId: localParent.id, threadId: top.id }, old - 6000);
		await noteDeleteService.delete(local, top, true);
		await noteDeleteService.delete(local, localParent, true);
		await app.get(FederatedInstanceService).fetchOrRegister('remote.example.com');

		expect(await clean()).toMatchObject({ deletedCount: 1, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: evicted.id })).toBe(false);
		expect(await noteRelationsRepository.findBy({ parentId: localParent.id })).toEqual([expect.objectContaining({ childId: live.id, kind: 0 })]);
		expect(await noteRelationsRepository.existsBy({ childId: localParent.id, parentId: top.id, kind: 0 })).toBe(true);
		expect((await getNote(localParent.id)).json()).toMatchObject({ id: `${config.url}/notes/${localParent.id}`, type: 'Tombstone' });

		const late = await noteCreateService.create(remote, { text: 'late', replyFormerId: localParent.id, uri: uniqueUri(), apMentions: [], apHashtags: [], apEmojis: [] }, true);

		expect(late.replyId).toBe(localParent.id);
		expect(late.threadId).toBe(top.id);
	});

	test('does not take a note whose parent or an ancestor through deleted notes still exists as a root', async () => {
		const liveParent = await createNote(local, {}, old - 9000);
		const protectedParent = await createNote(remote, { clippedCount: 1 }, old - 8000);
		const deletedParent = await createNote(remote, {}, old - 7000);
		const deletedReply = await createNote(remote, { replyId: protectedParent.id }, old - 6000);
		const deletedQuote = await createNote(remote, { renoteId: liveParent.id }, old - 5500);
		const reply = await createNote(remote, { replyId: liveParent.id }, old - 5000);
		const replyToProtected = await createNote(remote, { replyId: protectedParent.id }, old - 4000);
		const quote = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID, renoteId: liveParent.id }, old - 3000);
		const mixed = await createNote(remote, { replyId: deletedParent.id, renoteId: liveParent.id }, old - 2000);
		const throughDeleted = await createNote(remote, { replyId: deletedReply.id }, old - 1000);
		const throughDeletedTwice = await createNote(remote, { replyId: deletedParent.id, renoteId: deletedQuote.id }, old - 500);
		for (const note of [deletedParent, deletedReply, deletedQuote]) {
			await noteDeleteService.delete(remote, note, true);
		}

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 0 });
		const kept = [liveParent, protectedParent, reply, replyToProtected, quote, mixed, throughDeleted, throughDeletedTwice];
		expect(await notesRepository.countBy({ id: In(kept.map(note => note.id)) })).toBe(kept.length);
		expect(await noteRelationsRepository.countBy({ childId: In([deletedReply, deletedQuote, reply, replyToProtected, quote, mixed, throughDeleted, throughDeletedTwice].map(note => note.id)) })).toBe(10);
	});

	test('does not take a note with an existing ancestor through a deleted note as a root in a later root window', async () => {
		const top = await createNote(remote, {}, old - 600_000);
		const clipped = await createNote(remote, { replyId: top.id, clippedCount: 1 }, old - 590_000);
		const deleted = await createNote(remote, { replyId: top.id }, old - 580_000);
		const fillers: MiNote[] = [];
		for (let i = 0; i < 110; i++) {
			fillers.push(await createNote(remote, {}, old - 500_000 + i * 1000));
		}
		const descendant = await createNote(remote, { replyId: deleted.id }, old - 1000);
		await noteDeleteService.delete(remote, deleted, true);
		const windows = recordRootWindows();

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: fillers.length, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In(fillers.map(note => note.id)) })).toBe(false);
		expect(await notesRepository.countBy({ id: In([top.id, clipped.id, descendant.id]) })).toBe(3);
		expect(await noteRelationsRepository.countBy({ childId: In([clipped.id, deleted.id, descendant.id]) })).toBe(3);
		expect(windows.length).toBeGreaterThan(1);
		expect(windows[0]).toContain(top.id);
		expect(descendant.id > windows[0][windows[0].length - 1]).toBe(true);
		expect(windows.flat()).not.toContain(descendant.id);
	});

	test('keeps the protected orphans and the orphan trees that contain an unremovable note', async () => {
		const deletedParent = await createNote(remote, {}, old - 10000);
		const clipped = await createNote(remote, { replyId: deletedParent.id, clippedCount: 1 }, old - 9000);
		const paged = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID, pageCount: 1 }, old - 8000);
		const favorited = await createNote(remote, { replyId: deletedParent.id }, old - 7000);
		const pinned = await createNote(remote, { renoteId: deletedParent.id, text: null }, old - 6000);
		const reacted = await createNote(remote, { replyId: deletedParent.id }, old - 5000);
		const withProtectedReply = await createNote(remote, { replyId: deletedParent.id }, old - 4000);
		const protectedReply = await createNote(remote, { replyId: withProtectedReply.id }, old - 3000);
		const withNewReply = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		const newReply = await createNote(remote, { replyId: withNewReply.id });
		await noteFavoritesRepository.insert({ id: idService.gen(), userId: local.id, noteId: favorited.id });
		await userNotePiningsRepository.insert({ id: idService.gen(), userId: remote.id, noteId: pinned.id });
		await noteReactionsRepository.insert({ id: idService.gen(), userId: local.id, noteId: reacted.id, reaction: '👍' });
		await noteFavoritesRepository.insert({ id: idService.gen(), userId: local.id, noteId: protectedReply.id });
		await noteDeleteService.delete(remote, deletedParent, true);

		const result = await clean();

		expect(result.deletedCount).toBe(0);
		const kept = [clipped, paged, favorited, pinned, reacted, withProtectedReply, protectedReply, withNewReply, newReply];
		expect(await notesRepository.countBy({ id: In(kept.map(note => note.id)) })).toBe(kept.length);
	});

	test('walks through deleted replies and evicts the whole tree below them, forgetting every edge of the tree', async () => {
		const liveQuoted = await createNote(local, {}, old - 7000);
		const root = await createNote(remote, {}, old - 6000);
		const deleted = await createNote(remote, { replyId: root.id, renoteId: liveQuoted.id }, old - 5000);
		const deletedReply = await createNote(remote, { replyId: deleted.id }, old - 4000);
		const child = await createNote(remote, { replyId: deletedReply.id }, old - 3000);
		const grandchild = await createNote(remote, { replyId: child.id }, old - 2000);
		const quote = await createNote(remote, { renoteId: deleted.id }, old - 1000);
		const protectors: DependentTable[] = ['note_favorite', 'clip_note', 'user_note_pining'];
		await attachDependents(child, reactor, protectors);
		await attachDependents(grandchild, reactor, protectors);
		await noteDeleteService.delete(remote, deleted, true);
		await noteDeleteService.delete(remote, deletedReply, true);

		const result = await clean();

		const evictedIds = [root, child, grandchild, quote].map(note => note.id);
		const treeIds = [...evictedIds, deleted.id, deletedReply.id];
		expect(result).toMatchObject({ deletedCount: evictedIds.length, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In(evictedIds) })).toBe(false);
		expect(await countDependents(child.id)).toEqual(dependentCounts(0));
		expect(await countDependents(grandchild.id)).toEqual(dependentCounts(0));
		expect(await noteRelationsRepository.existsBy([{ childId: In(treeIds) }, { parentId: In(treeIds) }])).toBe(false);
		expect(await noteUrisRepository.existsBy({ noteId: In(evictedIds) })).toBe(false);
		expect(await noteUrisRepository.countBy({ noteId: In([deleted.id, deletedReply.id]) })).toBe(2);
		expect(await notesRepository.existsBy({ id: liveQuoted.id })).toBe(true);
	});

	test('keeps the whole tree across deleted notes when a note above or below them is protected', async () => {
		const clippedRoot = await createNote(remote, { clippedCount: 1 }, old - 20000);
		const deletedOfClipped = await createNote(remote, { replyId: clippedRoot.id }, old - 19000);
		const belowClipped = await createNote(remote, { replyId: deletedOfClipped.id }, old - 18000);
		const belowClippedReply = await createNote(remote, { replyId: belowClipped.id }, old - 17000);
		const reactedRoot = await createNote(remote, {}, old - 16000);
		const deletedOfReacted = await createNote(remote, { replyId: reactedRoot.id }, old - 15000);
		const belowReacted = await createNote(remote, { replyId: deletedOfReacted.id }, old - 14000);
		const root = await createNote(remote, {}, old - 13000);
		const deletedReply = await createNote(remote, { replyId: root.id }, old - 12000);
		const belowDeleted = await createNote(remote, { replyId: deletedReply.id }, old - 11000);
		const favorited = await createNote(remote, { replyId: belowDeleted.id }, old - 10000);
		const replied = await createNote(remote, {}, old - 9000);
		const quoted = await createNote(remote, {}, old - 8000);
		const joint = await createNote(remote, { replyId: replied.id, renoteId: quoted.id }, old - 7000);
		const belowJoint = await createNote(remote, { replyId: joint.id }, old - 6000);
		const pinned = await createNote(remote, { replyId: quoted.id }, old - 5000);
		await noteReactionsRepository.insert({ id: idService.gen(), userId: local.id, noteId: reactedRoot.id, reaction: '👍' });
		await noteFavoritesRepository.insert({ id: idService.gen(), userId: local.id, noteId: favorited.id });
		await userNotePiningsRepository.insert({ id: idService.gen(), userId: remote.id, noteId: pinned.id });
		for (const note of [deletedOfClipped, deletedOfReacted, deletedReply, joint]) {
			await noteDeleteService.delete(remote, note, true);
		}

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 0 });
		const kept = [clippedRoot, belowClipped, belowClippedReply, reactedRoot, belowReacted, root, belowDeleted, favorited, replied, quoted, belowJoint, pinned];
		expect(await notesRepository.countBy({ id: In(kept.map(note => note.id)) })).toBe(kept.length);
		expect(await noteRelationsRepository.countBy({ childId: In([deletedOfClipped, belowClipped, belowClippedReply, deletedOfReacted, belowReacted, deletedReply, belowDeleted, favorited, joint, belowJoint, pinned].map(note => note.id)) })).toBe(12);
	});

	test('walks through deleted local notes, which still answer a Tombstone and take late replies at their former ids after the eviction removes their last edges', async () => {
		const root = await createNote(remote, {}, old - 4000);
		const localReply = await createNote(local, { replyId: root.id }, old - 3000);
		const localReplyReply = await createNote(local, { replyId: localReply.id }, old - 2000);
		const child = await createNote(remote, { replyId: localReplyReply.id }, old - 1000);
		await noteDeleteService.delete(local, localReply, true);
		await noteDeleteService.delete(local, localReplyReply, true);
		await app.get(FederatedInstanceService).fetchOrRegister('remote.example.com');
		const formerIds = [localReply.id, localReplyReply.id];
		for (const id of formerIds) {
			expect((await getNote(id)).json()).toMatchObject({ id: `${config.url}/notes/${id}`, type: 'Tombstone' });
		}

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 2, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In([root.id, child.id]) })).toBe(false);
		expect(await noteRelationsRepository.existsBy([{ childId: In(formerIds) }, { parentId: In(formerIds) }])).toBe(false);
		expect(await recordedIds([root.id, child.id, ...formerIds])).toEqual([...formerIds].sort());
		for (const id of formerIds) {
			expect((await getNote(id)).json()).toMatchObject({ id: `${config.url}/notes/${id}`, type: 'Tombstone' });
			expect(await apDbResolverService.getNoteReferenceFromApId(`${config.url}/notes/${id}`)).toEqual({ note: null, formerId: id });
		}

		const { formerId } = await apDbResolverService.getNoteReferenceFromApId(`${config.url}/notes/${localReplyReply.id}`);
		const late = await noteCreateService.create(remote, { text: 'late', replyFormerId: formerId, uri: uniqueUri(), apMentions: [], apHashtags: [], apEmojis: [] }, true);

		expect(late.replyId).toBe(localReplyReply.id);
		expect(late.threadId).toBe(localReplyReply.id);
		expect(await noteRelationsRepository.existsBy({ childId: late.id, parentId: localReplyReply.id, kind: 0 })).toBe(true);
	});

	test('forgets an evicted note without recording it, so that it answers 404 and a late reply to it cannot be linked to its id', async () => {
		const parent = await createNote(remote, {}, old - 2000);
		const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });

		expect(await clean()).toMatchObject({ deletedCount: 1, transientErrors: 0 });

		expect(await notesRepository.existsBy({ id: parent.id })).toBe(false);
		expect(await recordedIds([parent.id])).toEqual([]);
		expect((await getNote(parent.id)).statusCode).toBe(404);
		expect(await apDbResolverService.getNoteReferenceFromApId(parentUri)).toEqual({ note: null, formerId: null });
		expect(await apDbResolverService.getNoteReferenceFromApId(`${config.url}/notes/${parent.id}`)).toEqual({ note: null, formerId: null });
	});

	test('skips the batch when a root is linked to a parent after the walk', async () => {
		const parent = await createNote(remote, { clippedCount: 1 }, old - 5000);
		const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });
		const orphan = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		await notePendingParentsRepository.insert({ parentUri, childId: orphan.id, kind: 0 });
		afterWalk(() => joinPendingChildren(parent));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect((await notesRepository.findOneByOrFail({ id: orphan.id })).replyId).toBe(parent.id);
		expect(await noteRelationsRepository.existsBy({ childId: orphan.id, parentId: parent.id, kind: 0 })).toBe(true);
		expect(await noteUrisRepository.existsBy({ noteId: orphan.id })).toBe(true);
	});

	test('skips the batch when a note gets a reply after the walk', async () => {
		const orphan = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 3000);
		const reply = await createNote(remote, { replyId: orphan.id }, old - 2000);
		afterWalk(() => createNote(local, { replyId: reply.id }));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect(await notesRepository.countBy({ id: In([orphan.id, reply.id]) })).toBe(2);
		expect(await notesRepository.countBy({ replyId: reply.id })).toBe(1);
		expect(await noteRelationsRepository.countBy({ parentId: In([orphan.id, reply.id]), kind: 0 })).toBe(2);
	});

	test('keeps only the tree that gets a reply after the walk and evicts the other trees of the batch', async () => {
		const root = await createNote(remote, {}, old - 4000);
		const reply = await createNote(remote, { replyId: root.id }, old - 3000);
		const other = await createNote(remote, {}, old - 2000);
		const otherReply = await createNote(remote, { replyId: other.id }, old - 1000);
		const lateReplies: MiNote[] = [];
		afterWalk(async () => lateReplies.push(await createNote(local, { replyId: reply.id })));

		const { result, logs } = await cleanLogged();

		expect(result).toMatchObject({ deletedCount: 2, transientErrors: 1 });
		expect(await notesRepository.countBy({ id: In([root.id, reply.id, ...lateReplies.map(note => note.id)]) })).toBe(3);
		expect(await noteRelationsRepository.countBy({ parentId: In([root.id, reply.id]), kind: 0 })).toBe(2);
		expect(await notesRepository.existsBy({ id: In([other.id, otherReply.id]) })).toBe(false);
		expect(await noteRelationsRepository.existsBy([{ childId: In([other.id, otherReply.id]) }, { parentId: In([other.id, otherReply.id]) }])).toBe(false);
		expect(logs).toContain('Note trees changed while cleaning, skipped... (transient race condition?)');
	});

	test('keeps both trees when the root of one is linked after the walk to a note of the other, and evicts the other trees of the batch', async () => {
		const parent = await createNote(remote, {}, old - 4000);
		const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });
		const orphan = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 3000);
		await notePendingParentsRepository.insert({ parentUri, childId: orphan.id, kind: 0 });
		const other = await createNote(remote, {}, old - 2000);
		afterWalk(() => joinPendingChildren(parent));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 1, transientErrors: 1 });
		expect(await notesRepository.countBy({ id: In([parent.id, orphan.id]) })).toBe(2);
		expect((await notesRepository.findOneByOrFail({ id: orphan.id })).replyId).toBe(parent.id);
		expect(await noteRelationsRepository.existsBy({ childId: orphan.id, parentId: parent.id, kind: 0 })).toBe(true);
		expect(await notesRepository.existsBy({ id: other.id })).toBe(false);
	});

	test('skips the batch when a root is linked after the walk to a deleted parent whose ancestor still exists', async () => {
		const ancestor = await createNote(local, {}, old - 5000);
		const former = await createNote(remote, { replyId: ancestor.id }, old - 4000);
		const { uri: formerUri } = await noteUrisRepository.findOneByOrFail({ noteId: former.id });
		const orphan = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		await notePendingParentsRepository.insert({ parentUri: formerUri, childId: orphan.id, kind: 0 });
		await noteDeleteService.delete(remote, former, true);
		afterWalk(() => sweepPendingParents(db, idService, Date.now() + 10_000));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect((await notesRepository.findOneByOrFail({ id: orphan.id })).replyId).toBe(former.id);
		expect(await noteRelationsRepository.existsBy({ childId: orphan.id, parentId: former.id, kind: 0 })).toBe(true);
		expect(await noteUrisRepository.existsBy({ noteId: orphan.id })).toBe(true);
	});

	test('skips the batch when a root is linked to a parent and deleted after the walk', async () => {
		const parent = await createNote(remote, { clippedCount: 1 }, old - 5000);
		const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });
		const orphan = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		const child = await createNote(remote, { replyId: orphan.id }, old - 1000);
		await notePendingParentsRepository.insert({ parentUri, childId: orphan.id, kind: 0 });
		afterWalk(async () => {
			await joinPendingChildren(parent);
			await noteDeleteService.delete(remote, orphan, true);
		});

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect(await notesRepository.existsBy({ id: orphan.id })).toBe(false);
		expect(await notesRepository.existsBy({ id: child.id })).toBe(true);
		expect(await noteRelationsRepository.existsBy({ childId: orphan.id, parentId: parent.id, kind: 0 })).toBe(true);
		expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: orphan.id, kind: 0 })).toBe(true);
		expect(await noteUrisRepository.existsBy({ noteId: child.id })).toBe(true);
	});

	test('skips the batch when a root is linked after the walk to a deleted parent whose ancestor still exists and is deleted', async () => {
		const ancestor = await createNote(local, {}, old - 5000);
		const former = await createNote(remote, { replyId: ancestor.id }, old - 4000);
		const { uri: formerUri } = await noteUrisRepository.findOneByOrFail({ noteId: former.id });
		const orphan = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		const child = await createNote(remote, { replyId: orphan.id }, old - 1000);
		await notePendingParentsRepository.insert({ parentUri: formerUri, childId: orphan.id, kind: 0 });
		await noteDeleteService.delete(remote, former, true);
		afterWalk(async () => {
			await sweepPendingParents(db, idService, Date.now() + 10_000);
			await noteDeleteService.delete(remote, orphan, true);
		});

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect(await notesRepository.existsBy({ id: orphan.id })).toBe(false);
		expect(await notesRepository.existsBy({ id: child.id })).toBe(true);
		expect(await noteRelationsRepository.existsBy({ childId: orphan.id, parentId: former.id, kind: 0 })).toBe(true);
		expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: orphan.id, kind: 0 })).toBe(true);
		expect(await noteUrisRepository.existsBy({ noteId: child.id })).toBe(true);
	});

	test('evicts the tree of a root deleted after the walk without a new link, forgetting the edges of the deleted root but keeping its uri', async () => {
		const top = await createNote(remote, {}, old - 3000);
		const root = await createNote(remote, { replyId: top.id }, old - 2000);
		const child = await createNote(remote, { replyId: root.id }, old - 1000);
		await noteDeleteService.delete(remote, top, true);
		afterWalk(() => noteDeleteService.delete(remote, root, true));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 1, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: child.id })).toBe(false);
		expect(await noteRelationsRepository.existsBy([{ childId: In([root.id, child.id]) }, { parentId: In([root.id, child.id]) }])).toBe(false);
		expect(await noteUrisRepository.existsBy({ noteId: child.id })).toBe(false);
		expect(await noteUrisRepository.countBy({ noteId: In([top.id, root.id]) })).toBe(2);
	});

	test('does not skip the batch when a root of a kept tree is linked to a parent after the walk', async () => {
		const parent = await createNote(remote, { clippedCount: 1 }, old - 6000);
		const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });
		const kept = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 5000);
		const clipped = await createNote(remote, { replyId: kept.id, clippedCount: 1 }, old - 4000);
		const root = await createNote(remote, {}, old - 3000);
		const reply = await createNote(remote, { replyId: root.id }, old - 2000);
		await notePendingParentsRepository.insert({ parentUri, childId: kept.id, kind: 0 });
		afterWalk(() => joinPendingChildren(parent));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 2, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In([root.id, reply.id]) })).toBe(false);
		expect(await notesRepository.countBy({ id: In([parent.id, kept.id, clipped.id]) })).toBe(3);
		expect(await noteRelationsRepository.existsBy({ childId: kept.id, parentId: parent.id, kind: 0 })).toBe(true);
	});

	test('skips the batch when a deleted note of the tree gets a reply after the walk', async () => {
		const root = await createNote(remote, {}, old - 3000);
		const deleted = await createNote(remote, { replyId: root.id }, old - 2000);
		const child = await createNote(remote, { replyId: deleted.id }, old - 1000);
		await noteDeleteService.delete(remote, deleted, true);
		afterWalk(() => createNote(local, { replyId: deleted.id }));

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect(await notesRepository.countBy({ id: In([root.id, child.id]) })).toBe(2);
		expect(await noteRelationsRepository.countBy({ parentId: In([root.id, deleted.id]), kind: 0 })).toBe(3);
	});

	test('skips the batch when a note of the tree gets a reply after the walk through a note deleted since', async () => {
		const root = await createNote(remote, {}, old - 2000);
		const child = await createNote(remote, { replyId: root.id }, old - 1000);
		const lateReplies: MiNote[] = [];
		afterWalk(async () => {
			const late = await createNote(remote, { replyId: child.id });
			lateReplies.push(await createNote(local, { replyId: late.id }));
			await noteDeleteService.delete(remote, late, true);
		});

		const result = await clean();

		expect(result).toMatchObject({ deletedCount: 0, transientErrors: 1 });
		expect(await notesRepository.countBy({ id: In([root.id, child.id, ...lateReplies.map(note => note.id)]) })).toBe(3);
		expect(await noteRelationsRepository.countBy({ parentId: child.id, kind: 0 })).toBe(1);
		expect(await noteRelationsRepository.countBy({ childId: In(lateReplies.map(note => note.id)), kind: 0 })).toBe(1);
	});

	describe.each<[string, (parent: MiNote) => Promise<unknown>]>([
		['joining a parent read before its eviction', async parent => {
			expect((await clean()).deletedCount).toBe(1);
			await joinPendingChildren(parent);
		}],
		['the sweep finding the parent evicted after matching its uri', async () => {
			await beforeFirstQuery(/^SELECT "id", "userId", "userHost", "channelId"/, clean, () => sweepPendingParents(db, idService, Date.now() + 10_000));
		}],
		['the sweep locking a parent evicted after it was read', async () => {
			await beforeFirstQuery(/FOR UPDATE$/, clean, () => sweepPendingParents(db, idService, Date.now() + 10_000));
		}],
	])('%s', (_, join) => {
		test('leaves the waiting child for the parent fetched again', async () => {
			const parent = await createNote(remote, {}, old - 5000);
			const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });
			const child = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID });
			await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

			await join(parent);

			expect(await notesRepository.existsBy({ id: parent.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(await notePendingParentsRepository.existsBy({ parentUri, childId: child.id, kind: 0 })).toBe(true);
			expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
			expect((await getNote(parent.id)).statusCode).toBe(404);
		});
	});

	test('checks the existence of the parents and of the ancestors through deleted notes only in the partitions of their ids', async () => {
		const month = day * 30;
		const top = await createNote(remote, {}, old - month * 8);
		const deletedMiddle = await createNote(remote, { replyId: top.id }, old - month * 7);
		const liveAncestor = await createNote(local, {}, old - month * 6);
		const deletedChild = await createNote(remote, { replyId: liveAncestor.id }, old - month * 5);
		const root = await createNote(remote, {}, old - month * 4);
		const former = await createNote(remote, { replyId: root.id }, old - month * 3);
		const liveParent = await createNote(local, {}, old - month * 2);
		const localParent = await createNote(local, {}, old - month);
		const orphanOfChain = await createNote(remote, { replyId: deletedMiddle.id }, old - 6000);
		const anchored = await createNote(remote, { replyId: deletedChild.id }, old - 5000);
		const belowFormer = await createNote(remote, { replyId: former.id }, old - 4000);
		const orphanOfLocal = await createNote(remote, { renoteId: localParent.id, text: null }, old - 3000);
		const unreferenceable = await createNote(remote, { replyId: UNREFERENCEABLE_NOTE_ID }, old - 2000);
		const reply = await createNote(remote, { replyId: liveParent.id }, old - 1000);
		for (const note of [top, deletedMiddle, deletedChild, former]) {
			await noteDeleteService.delete(remote, note, true);
		}
		await noteDeleteService.delete(local, localParent, true);
		const checkedIds = [top, deletedMiddle, liveAncestor, deletedChild, root, former, liveParent, localParent].map(note => note.id);
		const rootIds = [root, orphanOfChain, orphanOfLocal, unreferenceable].map(note => note.id);
		expect(new Set([...checkedIds, reply.id].map(prefixOf)).size).toBe(9);

		const statements: { query: string; parameters: string[] }[] = [];
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: event => {
				statements.push({ query: event.query, parameters: (event.parameters ?? []) as string[] });
			},
		};
		db.subscribers.push(subscriber);
		const result = await clean().finally(() => {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
		});

		expect(result).toMatchObject({ deletedCount: rootIds.length + 1, transientErrors: 0 });
		expect(await notesRepository.existsBy({ id: In([...rootIds, belowFormer.id]) })).toBe(false);
		expect(await notesRepository.countBy({ id: In([anchored.id, reply.id]) })).toBe(2);
		const existenceChecks = statements.filter(({ query }) => /^SELECT "id" FROM "note" WHERE "id" IN \(\$1(, \$\d+)*\)$/.test(query));
		expect(existenceChecks.length).toBeGreaterThan(0);
		for (const { parameters } of existenceChecks) {
			expect(checkedIds).toEqual(expect.arrayContaining(parameters));
			expect(new Set(parameters.map(prefixOf)).size).toBe(1);
		}
		expect(new Set(existenceChecks.flatMap(({ parameters }) => parameters))).toEqual(new Set(checkedIds));
		const rootChecks = statements.filter(({ query }) => /^SELECT "id", "replyId", "renoteId" FROM "note" WHERE "id" IN \(\$1(, \$\d+)*\)$/.test(query));
		expect(rootChecks.length).toBeGreaterThan(0);
		for (const { parameters } of rootChecks) {
			expect(rootIds).toEqual(expect.arrayContaining(parameters));
			expect(new Set(parameters.map(prefixOf)).size).toBe(1);
		}
	});

	describe('a child created while the eviction holds its parent', () => {
		test.each<[string, () => MiUser, (parent: MiNote) => Parameters<NoteCreateService['create']>[1], number]>([
			['a remote reply', () => remote, parent => ({ text: 'reply', reply: parent }), 0],
			['a local reply', () => local, parent => ({ text: 'reply', reply: parent }), 0],
			['a local quote', () => local, parent => ({ text: 'quote', renote: parent }), 1],
			['a local renote', () => local, parent => ({ renote: parent }), 2],
		])('%s waits for the eviction and then waits for the parent by its uri, without an edge to the evicted parent', async (_, author, data, kind) => {
			const parent = await createNote(remote, {}, old - 2000);
			const { uri: parentUri } = await noteUrisRepository.findOneByOrFail({ noteId: parent.id });
			const user = author();
			const creations: Promise<MiNote>[] = [];
			let settled = false;

			await afterFirstQuery(/ FOR UPDATE$/, async runner => {
				const evictionPid = await backendPid(runner);
				creations.push(noteCreateService.create(user, { ...data(parent), uri: user.host != null ? uniqueUri() : null, apMentions: [], apHashtags: [], apEmojis: [] }, true).finally(() => settled = true));
				await waitUntil(async () => settled || await blockedBy(evictionPid, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR KEY SHARE$/));
				expect(settled).toBe(false);
			}, async () => {
				expect(await clean()).toMatchObject({ deletedCount: 1, transientErrors: 0 });
			});

			const [{ id }] = await Promise.all(creations);
			const child = await notesRepository.findOneByOrFail({ id });
			expect(await notesRepository.existsBy({ id: parent.id })).toBe(false);
			expect(kind === 0 ? child.replyId : child.renoteId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(child.threadId).toBeNull();
			expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
			expect(await notePendingParentsRepository.findBy({ childId: child.id })).toEqual([{ parentUri, childId: child.id, kind }]);
			expect(await db.query('SELECT "replyId", "renoteId", "replyUri", "renoteUri" FROM "note_unlinked_relation" WHERE "noteId" = $1', [child.id])).toEqual(
				user.host != null ? [] : [kind === 0 ? { replyId: parent.id, renoteId: null, replyUri: parentUri, renoteUri: null } : { replyId: null, renoteId: parent.id, replyUri: null, renoteUri: parentUri }],
			);
			if (user.host == null) {
				expect(await noteUrisRepository.existsBy({ noteId: parent.id })).toBe(false);
				if (kind === 2) {
					expect((await getActivity(child.id)).json()).toMatchObject({ type: 'Announce', object: parentUri });
				} else {
					const rendered = await app.get(ApRendererService).renderNote(child, false);
					expect(kind === 0 ? rendered.inReplyTo : rendered.quoteUrl).toBe(parentUri);
				}
			}
		});

		test('a reply that locked its parent first makes the eviction wait for it and then skip the batch', async () => {
			const parent = await createNote(remote, {}, old - 2000);
			const gate = db.createQueryRunner();
			await gate.connect();
			await db.query(`
				CREATE FUNCTION "test_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					PERFORM pg_advisory_xact_lock_shared(${gateKey});
					RETURN NEW;
				END $$
			`);
			await db.query('CREATE TRIGGER "test_gate" BEFORE INSERT ON "note_relation" FOR EACH ROW EXECUTE FUNCTION "test_gate"()');
			try {
				await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
				const gatePid = await backendPid(gate);
				const creating = noteCreateService.create(remote, { text: 'reply', reply: parent, uri: uniqueUri(), apMentions: [], apHashtags: [], apEmojis: [] }, true);
				const creatorPid = await waitUntil(() => blockedPid(gatePid, /^INSERT INTO "note_relation"/));
				let result: Awaited<ReturnType<typeof clean>> | undefined;
				const cleaning = clean().then(cleaned => result = cleaned);
				await waitUntil(async () => result != null || await blockedBy(creatorPid, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/));
				await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]);

				const child = await creating;
				expect(await cleaning).toMatchObject({ deletedCount: 0, transientErrors: 1 });
				expect(await notesRepository.countBy({ id: In([parent.id, child.id]) })).toBe(2);
				expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(parent.id);
				expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: parent.id, kind: 0 })).toBe(true);
			} finally {
				await gate.query('SELECT pg_advisory_unlock_all()');
				await gate.release();
				await db.query('DROP FUNCTION IF EXISTS "test_gate"() CASCADE');
			}
		});
	});

	describe('a protection added after the walk', () => {
		test.each<[string, (note: MiNote) => Promise<unknown>, DependentTable | null]>([
			['a favorite', note => noteFavoritesRepository.insert({ id: idService.gen(), userId: local.id, noteId: note.id }), 'note_favorite'],
			['a clip before its count is incremented', async note => {
				const clipId = idService.gen();
				await clipsRepository.insert({ id: clipId, userId: local.id, name: secureRndstr(8) });
				await clipNotesRepository.insert({ id: idService.gen(), noteId: note.id, clipId });
			}, 'clip_note'],
			['a clipped count', note => notesRepository.update({ id: note.id }, { clippedCount: 1 }), null],
			['a page', note => notesRepository.update({ id: note.id }, { pageCount: 1 }), null],
			['a pin', note => userNotePiningsRepository.insert({ id: idService.gen(), userId: note.userId, noteId: note.id }), 'user_note_pining'],
			['a reaction of a local user', note => noteReactionsRepository.insert({ id: idService.gen(), userId: local.id, noteId: note.id, reaction: '👍' }), 'note_reaction'],
		])('skips the batch when a note of the tree gets %s after the walk', async (_, protect, table) => {
			const root = await createNote(remote, {}, old - 2000);
			const reply = await createNote(remote, { replyId: root.id }, old - 1000);
			afterWalk(() => protect(reply));

			expect(await clean()).toMatchObject({ deletedCount: 0, transientErrors: 1 });
			expect(await notesRepository.countBy({ id: In([root.id, reply.id]) })).toBe(2);
			if (table != null) expect((await countDependents(reply.id))[table]).toBe(1);
		});

		test('skips the batch when the root gets a favorite after the walk', async () => {
			const root = await createNote(remote, {}, old - 2000);
			const reply = await createNote(remote, { replyId: root.id }, old - 1000);
			afterWalk(() => noteFavoritesRepository.insert({ id: idService.gen(), userId: local.id, noteId: root.id }));

			expect(await clean()).toMatchObject({ deletedCount: 0, transientErrors: 1 });
			expect(await notesRepository.countBy({ id: In([root.id, reply.id]) })).toBe(2);
			expect((await countDependents(root.id)).note_favorite).toBe(1);
		});

		test('keeps a note that was clipped while its count stayed zero without skipping the other trees of the batch', async () => {
			const clipped = await createNote(remote, {}, old - 3000);
			const clipId = idService.gen();
			await clipsRepository.insert({ id: clipId, userId: local.id, name: secureRndstr(8) });
			await clipNotesRepository.insert({ id: idService.gen(), noteId: clipped.id, clipId });
			const root = await createNote(remote, {}, old - 2000);
			const reply = await createNote(remote, { replyId: root.id }, old - 1000);
			expect((await notesRepository.findOneByOrFail({ id: clipped.id })).clippedCount).toBe(0);

			expect(await clean()).toMatchObject({ deletedCount: 2, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: clipped.id })).toBe(true);
			expect((await countDependents(clipped.id)).clip_note).toBe(1);
			expect(await notesRepository.existsBy({ id: In([root.id, reply.id]) })).toBe(false);
		});

		test('evicts the tree when a note of the tree gets a reaction of a remote user after the walk', async () => {
			const root = await createNote(remote, {}, old - 2000);
			const reply = await createNote(remote, { replyId: root.id }, old - 1000);
			afterWalk(() => noteReactionsRepository.insert({ id: idService.gen(), userId: reactor.id, noteId: reply.id, reaction: '👍' }));

			expect(await clean()).toMatchObject({ deletedCount: 2, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: In([root.id, reply.id]) })).toBe(false);
			expect((await countDependents(reply.id)).note_reaction).toBe(0);
		});
	});

	describe('the work limit of the walks through deleted notes', () => {
		test('does not take a note as a root when its walk up through deleted notes exceeds the budget, and goes on to evict the notes after it', async () => {
			const top = await insertDeletedAncestors(14);
			const candidate = await createNote(remote, { replyId: top }, old - 2000);
			const later = await createNote(remote, {}, old - 1000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 1, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: candidate.id })).toBe(true);
			expect(await notesRepository.existsBy({ id: later.id })).toBe(false);
			expect(windows.flat()).not.toContain(candidate.id);
			expect(logs).toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('skips a note whose walk up through deleted notes alone exceeds the budget and keeps the whole budget for the notes after it', async () => {
			const top = await insertDeletedAncestors(14);
			const candidate = await createNote(remote, { replyId: top }, old - 3000);
			const smallTop = await insertDeletedAncestors(5, '01');
			const later = await createNote(remote, { replyId: smallTop }, old - 2000);
			const laterRoot = await createNote(remote, {}, old - 1000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 2, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: candidate.id })).toBe(true);
			expect(await notesRepository.existsBy({ id: In([later.id, laterRoot.id]) })).toBe(false);
			expect(windows).toEqual([[later.id, laterRoot.id]]);
			expect(logs).toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('ends the batch before a note whose walk up through deleted notes exceeds what the notes before it left of the budget, and takes it in the next batch', async () => {
			const heavyTop = await insertDeletedAncestors(13);
			const heavy = await createNote(remote, { replyId: heavyTop }, old - 3000);
			const nextTop = await insertDeletedAncestors(11, '01');
			const next = await createNote(remote, { replyId: nextTop }, old - 2000);
			const root = await createNote(remote, {}, old - 1000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 3, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: In([heavy.id, next.id, root.id]) })).toBe(false);
			expect(windows).toEqual([[heavy.id], [next.id, root.id]]);
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('evicts a note whose walk up through deleted notes takes more than half of the budget, since each tree is checked again under the lock with a budget of its own', async () => {
			const top = await insertDeletedAncestors(13);
			const candidate = await createNote(remote, { replyId: top }, old - 2000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 1, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: candidate.id })).toBe(false);
			expect(windows).toEqual([[candidate.id]]);
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('keeps only the tree whose check under the lock exceeds the budget and evicts the other trees of the batch', async () => {
			const top = await insertDeletedAncestors(13);
			const candidate = await createNote(remote, { replyId: top }, old - 3000);
			const root = await createNote(remote, {}, old - 2000);
			const reply = await createNote(remote, { replyId: root.id }, old - 1000);
			afterWalk(() => insertDeletedAncestors(14, '00', 13));

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 2, transientErrors: 1 });
			expect(await notesRepository.existsBy({ id: candidate.id })).toBe(true);
			expect(await noteRelationsRepository.existsBy({ childId: candidate.id, parentId: top })).toBe(true);
			expect(await notesRepository.existsBy({ id: In([root.id, reply.id]) })).toBe(false);
			expect(logs).toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('Note trees changed while cleaning, skipped... (transient race condition?)');
		});

		test('bounds the walk of the fallback after statement timeouts by a budget of its own, so that a note the failed batch has walked up for does not keep it from moving on', async () => {
			const top = await insertDeletedAncestors(13);
			const heavy = await createNote(remote, { replyId: top }, old - 5000);
			const roots: MiNote[] = [];
			for (let i = 0; i < 12; i++) roots.push(await createNote(remote, {}, old - 4000 + i));
			const timeout = new QueryFailedError('SELECT', [], Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
			vi.spyOn(cleanRemoteNotesProcessorService as unknown as { collectRemovableTrees: (...args: unknown[]) => Promise<unknown> }, 'collectRemovableTrees').mockRejectedValue(timeout);

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 0, transientErrors: 0 });
			expect(logs.filter(row => row.startsWith('Skipped note IDs: '))).toEqual([
				`Skipped note IDs: ${[heavy, ...roots.slice(0, 9)].map(note => note.id).join(', ')}`,
				`Skipped note IDs: ${roots.slice(10).map(note => note.id).join(', ')}`,
			]);
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
			expect(logs).not.toContainEqual(expect.stringMatching(/^Reached maximum duration /));
		});

		test('bounds the walk of the fallback after statement timeouts by a budget of its own, logs its overflow and goes on past the note', async () => {
			const roots: MiNote[] = [];
			for (let i = 0; i < 10; i++) roots.push(await createNote(remote, {}, old - 4000 + i));
			const top = await insertDeletedAncestors(14);
			const candidate = await createNote(remote, { replyId: top }, old - 2000);
			const skippedLast = await createNote(remote, {}, old - 1000);
			const later = await createNote(remote, {}, old - 500);
			const timeout = new QueryFailedError('SELECT', [], Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
			vi.spyOn(cleanRemoteNotesProcessorService as unknown as { collectRemovableTrees: (...args: unknown[]) => Promise<unknown> }, 'collectRemovableTrees')
				.mockRejectedValueOnce(timeout)
				.mockRejectedValueOnce(timeout)
				.mockRejectedValueOnce(timeout);

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 1, transientErrors: 0 });
			const skipped = `Skipped note IDs: ${roots.map(note => note.id).join(', ')}`;
			expect(logs.filter(row => row.startsWith('Skipped note IDs: '))).toEqual([skipped]);
			expect(logs.findIndex(row => overflowLog.test(row))).toBeGreaterThanOrEqual(0);
			expect(logs.findIndex(row => overflowLog.test(row))).toBeLessThan(logs.indexOf(skipped));
			expect(logs.join('\n')).not.toContain(candidate.id);
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
			expect(await notesRepository.countBy({ id: In([...roots, candidate, skippedLast].map(note => note.id)) })).toBe(12);
			expect(await notesRepository.existsBy({ id: later.id })).toBe(false);
		});

		test('does not let a candidate whose walk up through deleted notes takes most of the budget keep the trees of its batch from being evicted, since the walk down has a budget of its own', async () => {
			const top = await insertDeletedAncestors(13);
			await notesRepository.insert({ id: '0099983617', text: 'ancestor', userId: local.id, userHost: null, visibility: 'public' });
			const linked = await createNote(remote, { replyId: top }, old - 9000);
			const root = await createNote(remote, {}, old - 8000);
			await insertDeletedReplies(root.id, 4095, old - 7000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 1, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: root.id })).toBe(false);
			expect(await noteRelationsRepository.existsBy({ parentId: root.id })).toBe(false);
			expect(await notesRepository.countBy({ id: In([linked.id, '0099983617']) })).toBe(2);
			expect(await noteRelationsRepository.existsBy({ childId: linked.id, parentId: top })).toBe(true);
			expect(windows).toEqual([[root.id]]);
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('skips a root whose tree alone exceeds the budget of the walk down and goes on to evict the trees after it', async () => {
			const heavy = await createNote(remote, {}, old - 60_000);
			await insertDeletedReplies(heavy.id, 20000, old - 50_000);
			const root = await createNote(remote, {}, old - 20_000);
			const reply = await createNote(remote, { replyId: root.id }, old - 10_000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 2, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: heavy.id })).toBe(true);
			expect(await noteRelationsRepository.countBy({ parentId: heavy.id })).toBe(20000);
			expect(await notesRepository.existsBy({ id: In([root.id, reply.id]) })).toBe(false);
			expect(windows).toEqual([[heavy.id, root.id], [heavy.id], [root.id]]);
			expect(logs.filter(row => overflowLog.test(row))).toHaveLength(1);
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('evicts the trees completed when the walk down overflows, walks the first unfinished root alone in the next batch, and keeps a protected note below an unfinished tree', async () => {
			const first = await createNote(remote, {}, old - 95_000);
			const deep = await createNote(remote, {}, old - 90_000);
			await insertDeletedThread(deep.id, 20, old - 89_000);
			const guarded = await createNote(remote, {}, old - 80_000);
			const guardedEnd = await insertDeletedThread(guarded.id, 20, old - 79_000);
			const clipped = await createNote(remote, { replyId: guardedEnd, clippedCount: 1 }, old - 78_000);
			const wide = await createNote(remote, {}, old - 70_000);
			await insertDeletedReplies(wide.id, 19990, old - 60_000);
			const windows = recordRootWindows();

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 3, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: In([first.id, deep.id, wide.id]) })).toBe(false);
			expect(await noteRelationsRepository.existsBy({ parentId: In([deep.id, wide.id]) })).toBe(false);
			expect(await notesRepository.countBy({ id: In([guarded.id, clipped.id]) })).toBe(2);
			expect(await noteRelationsRepository.existsBy({ childId: clipped.id, parentId: guardedEnd })).toBe(true);
			expect(await noteRelationsRepository.existsBy({ parentId: guarded.id })).toBe(true);
			expect(windows).toEqual([[first.id, deep.id, guarded.id, wide.id], [deep.id], [guarded.id]]);
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test('keeps a completed tree that gets a reply after an overflowing walk down and evicts the other completed trees of the batch', async () => {
			const deep = await createNote(remote, {}, old - 90_000);
			await insertDeletedThread(deep.id, 20, old - 89_000);
			const root = await createNote(remote, {}, old - 80_000);
			const wide = await createNote(remote, {}, old - 70_000);
			await insertDeletedReplies(wide.id, 19990, old - 60_000);
			const lateReplies: MiNote[] = [];
			afterWalk(async () => lateReplies.push(await createNote(local, { replyId: root.id })));

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 2, transientErrors: 1 });
			expect(await notesRepository.existsBy({ id: In([deep.id, wide.id]) })).toBe(false);
			expect(await notesRepository.countBy({ id: In([root.id, ...lateReplies.map(note => note.id)]) })).toBe(2);
			expect(await noteRelationsRepository.existsBy({ childId: lateReplies[0].id, parentId: root.id, kind: 0 })).toBe(true);
			expect(logs).toContain('Note trees changed while cleaning, skipped... (transient race condition?)');
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
			expect(logs).toContain('No more notes to clean. The next run will start from the beginning.');
		});

		test.each<[string, () => Promise<unknown>]>([
			['the overflow of a batch that finds no root', async () => {
				const top = await insertDeletedAncestors(14);
				await createNote(remote, { replyId: top }, old - 2000);
			}],
			['the overflow of the fallback after statement timeouts', async () => {
				for (let i = 0; i < 10; i++) await createNote(remote, {}, old - 4000 + i);
				const top = await insertDeletedAncestors(14);
				await createNote(remote, { replyId: top }, old - 2000);
				const timeout = new QueryFailedError('SELECT', [], Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }));
				vi.spyOn(cleanRemoteNotesProcessorService as unknown as { collectRemovableTrees: (...args: unknown[]) => Promise<unknown> }, 'collectRemovableTrees')
					.mockRejectedValueOnce(timeout)
					.mockRejectedValueOnce(timeout)
					.mockRejectedValueOnce(timeout);
			}],
			['the overflow of a batch and the trees that changed under the lock', async () => {
				const top = await insertDeletedAncestors(13);
				await createNote(remote, { replyId: top }, old - 3000);
				const root = await createNote(remote, {}, old - 2000);
				await createNote(remote, { replyId: root.id }, old - 1000);
				afterWalk(() => insertDeletedAncestors(14, '00', 13));
			}],
		])('a job log that fails once Redis is lost does not surface as an unhandled rejection when it logs %s', async (_, prepare) => {
			const changed = 'Note trees changed while cleaning, skipped... (transient race condition?)';
			const ours = (row: string) => overflowLog.test(row) || row === changed;
			await prepare();
			const rejections: unknown[] = [];
			const onRejection = (reason: unknown) => rejections.push(reason);
			const logs: string[] = [];
			const job = {
				log: (row: string) => {
					logs.push(row);
					return ours(row) ? Promise.reject(new Error('Missing key for job cleanRemoteNotes. addLog')) : Promise.resolve(0);
				},
				updateProgress: vi.fn(),
			};

			process.on('unhandledRejection', onRejection);
			try {
				await cleanRemoteNotesProcessorService.process(job as never);
				await setTimeout(100);
			} finally {
				process.off('unhandledRejection', onRejection);
			}

			expect(logs.filter(ours)).not.toEqual([]);
			expect(rejections).toEqual([]);
		});

		test('takes a note as a root when its walk up through deleted notes stays within the budget', async () => {
			const top = await insertDeletedAncestors(5);
			const candidate = await createNote(remote, { replyId: top }, old - 2000);

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 1, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: candidate.id })).toBe(false);
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
		});

		test('does not take a note as a root when its walk up through deleted notes within the budget reaches an existing note', async () => {
			const top = await insertDeletedAncestors(5);
			await notesRepository.insert({ id: '0099999937', text: 'ancestor', userId: local.id, userHost: null, visibility: 'public' });
			const candidate = await createNote(remote, { replyId: top }, old - 2000);

			const { result, logs } = await cleanLogged();

			expect(result).toMatchObject({ deletedCount: 0, transientErrors: 0 });
			expect(await notesRepository.existsBy({ id: candidate.id })).toBe(true);
			expect(logs).not.toContainEqual(expect.stringMatching(overflowLog));
		});
	});
});
