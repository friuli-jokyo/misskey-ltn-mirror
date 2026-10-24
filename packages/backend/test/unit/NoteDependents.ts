/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, In } from 'typeorm';
import { CoreModule } from '@/core/CoreModule.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { EmailService } from '@/core/EmailService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { InternalStorageService } from '@/core/InternalStorageService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { PageService } from '@/core/PageService.js';
import { PartitionMigrationStateService } from '@/core/PartitionMigrationStateService.js';
import { QueueService } from '@/core/QueueService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { joinChildrenToParent, rekeyJoinedChildren, sweepPendingParents } from '@/misc/join-pending-children.js';
import { deleteNotesWithDependents, lockNoteRowsInIdOrder, lockNotesInIdOrder, recordDeletedNotes } from '@/misc/note-dependents.js';
import { prefixOf } from '@/misc/partition.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { CleanRemoteNotesProcessorService } from '@/queue/processors/CleanRemoteNotesProcessorService.js';
import { DeleteAccountProcessorService } from '@/queue/processors/DeleteAccountProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { AuthenticateService } from '@/server/api/AuthenticateService.js';
import type { Config } from '@/config.js';
import type { IDelete } from '@/core/activitypub/type.js';
import type { MiRemoteUser } from '@/models/User.js';
import type {
	ClipNotesRepository,
	ClipsRepository,
	DriveFilesRepository,
	MiDriveFile,
	MiMeta,
	MiNote,
	MiPage,
	MiUser,
	NoteFavoritesRepository,
	NotePendingParentsRepository,
	NoteReactionsRepository,
	NoteRelationsRepository,
	NotesRepository,
	NoteThreadMutingsRepository,
	NoteUrisRepository,
	PagesRepository,
	PollsRepository,
	PollVotesRepository,
	PromoNotesRepository,
	PromoReadsRepository,
	UserNotePiningsRepository,
	UserProfilesRepository,
	UserPublickeysRepository,
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
	['note_unlinked_relation', 'noteId'],
] as const;

type DependentTable = typeof dependentTables[number][0];

describe('Note dependents', () => {
	let app: TestingModule;
	let db: DataSource;
	let config: Config;
	let meta: MiMeta;
	let idService: IdService;
	let emailService: EmailService;
	let globalEventService: GlobalEventService;
	let internalStorageService: InternalStorageService;
	let pageService: PageService;
	let partitionMigrationStateService: PartitionMigrationStateService;
	let queueService: QueueService;
	let noteCreateService: NoteCreateService;
	let noteDeleteService: NoteDeleteService;
	let deleteAccountService: DeleteAccountService;
	let apDbResolverService: ApDbResolverService;
	let apInboxService: ApInboxService;
	let authenticateService: AuthenticateService;
	let cleanRemoteNotesProcessorService: CleanRemoteNotesProcessorService;
	let deleteAccountProcessorService: DeleteAccountProcessorService;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let userPublickeysRepository: UserPublickeysRepository;
	let notesRepository: NotesRepository;
	let noteRelationsRepository: NoteRelationsRepository;
	let noteThreadMutingsRepository: NoteThreadMutingsRepository;
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
	let driveFilesRepository: DriveFilesRepository;
	let pagesRepository: PagesRepository;

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createNote(user: MiUser, data: Partial<MiNote> = {}, time?: number): Promise<MiNote> {
		const id = idService.gen(time);
		await notesRepository.insert({ id, text: `note_${id}`, userId: user.id, userHost: user.host, visibility: 'public', ...data });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function createFile(user: MiUser): Promise<MiDriveFile> {
		const id = idService.gen();
		await driveFilesRepository.insert({ id, userId: user.id, userHost: user.host, md5: secureRndstr(32), name: `file-${id}`, type: 'text/plain', size: 1, storedInternal: true, url: `https://example.com/${id}`, accessKey: secureRndstr(16) });
		return await driveFilesRepository.findOneByOrFail({ id });
	}

	async function createPage(user: MiUser, referenced: MiNote): Promise<MiPage> {
		return await pageService.create(user, { title: secureRndstr(8), name: secureRndstr(8), summary: null, content: [{ type: 'note', note: referenced.id }], variables: [], script: '', font: 'sans-serif', alignCenter: false, hideTitleWhenPinned: false });
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
		if (tables.has('note_unlinked_relation')) {
			await db.query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId", "replyUri") VALUES ($1, $2, NULL, $3)', [note.id, idService.gen(), uniqueUri()]);
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

	async function recordedIds(noteIds: MiNote['id'][]): Promise<MiNote['id'][]> {
		const rows: { id: MiNote['id'] }[] = await db.query('SELECT "id" FROM "deleted_note" WHERE "id" = ANY($1) ORDER BY "id"', [noteIds]);
		return rows.map(row => row.id);
	}

	async function failingAt<T>(pattern: RegExp, run: () => Promise<T>): Promise<T> {
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: event => {
				if (pattern.test(event.query)) throw new Error('interrupted');
			},
		};
		db.subscribers.push(subscriber);
		try {
			return await run();
		} finally {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
		}
	}

	async function waitUntilBlockedBy(holder: QueryRunner, statement: RegExp): Promise<void> {
		const [{ pid }]: { pid: number }[] = await holder.query('SELECT pg_backend_pid() AS "pid"');
		for (let i = 0; i < 100; i++) {
			const blocked: { query: string }[] = await db.query('SELECT "query" FROM "pg_stat_activity" WHERE $1 = ANY(pg_blocking_pids("pid"))', [pid]);
			if (blocked.some(row => statement.test(row.query))) return;
			await setTimeout(50);
		}
		throw new Error('timed out');
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				AuthenticateService,
				CleanRemoteNotesProcessorService,
				DeleteAccountProcessorService,
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
		app.enableShutdownHooks();

		db = app.get(DI.db);
		config = app.get(DI.config);
		meta = app.get(DI.meta);
		idService = app.get(IdService);
		emailService = app.get(EmailService);
		globalEventService = app.select(CoreModule).get(GlobalEventService, { strict: true });
		internalStorageService = app.get(InternalStorageService);
		pageService = app.get(PageService);
		partitionMigrationStateService = app.get(PartitionMigrationStateService);
		queueService = app.get(QueueService);
		noteCreateService = app.get(NoteCreateService);
		noteDeleteService = app.get(NoteDeleteService);
		deleteAccountService = app.get(DeleteAccountService);
		apDbResolverService = app.get(ApDbResolverService);
		apInboxService = app.get(ApInboxService);
		authenticateService = app.get(AuthenticateService);
		cleanRemoteNotesProcessorService = app.get(CleanRemoteNotesProcessorService);
		deleteAccountProcessorService = app.get(DeleteAccountProcessorService);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		userPublickeysRepository = app.get(DI.userPublickeysRepository);
		notesRepository = app.get(DI.notesRepository);
		noteRelationsRepository = app.get(DI.noteRelationsRepository);
		noteThreadMutingsRepository = app.get(DI.noteThreadMutingsRepository);
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
		driveFilesRepository = app.get(DI.driveFilesRepository);
		pagesRepository = app.get(DI.pagesRepository);

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
	});

	afterAll(async () => {
		await app.close();
	});

	test('no foreign key refers to or from note and note_reaction', async () => {
		const constraints: unknown[] = await db.query(`
			SELECT 1 FROM pg_constraint
			WHERE contype = 'f' AND (confrelid IN ('note'::regclass, 'note_reaction'::regclass) OR conrelid IN ('note'::regclass, 'note_reaction'::regclass))
		`);
		expect(constraints).toHaveLength(0);
	});

	describe('helpers', () => {
		test('lockNotesInIdOrder returns the existing notes in id order', async () => {
			const author = await createUser();
			const a = await createNote(author);
			const b = await createNote(author);
			const c = await createNote(author);

			const locked = await db.transaction(async transactionalEntityManager => await lockNotesInIdOrder(transactionalEntityManager, [c.id, idService.gen(), a.id, b.id, a.id], 'UPDATE'));

			expect(locked).toEqual([a.id, b.id, c.id].sort());
		});

		test('lockNoteRowsInIdOrder waits for a holder of a note and returns the existing notes in id order with the thread and the authors they have once it holds them', async () => {
			const author = await createUser();
			const replied = await createUser({ host: 'remote.example.com' });
			const a = await createNote(author);
			const b = await createNote(author, { threadId: a.id });
			const threadId = idService.gen();
			const holder = db.createQueryRunner();
			await holder.connect();
			try {
				await holder.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(holder.manager, [b.id], 'UPDATE')).toEqual([b.id]);
				await holder.query('UPDATE "note" SET "threadId" = $2, "replyUserId" = $3, "replyUserHost" = $4, "renoteUserId" = $3, "renoteUserHost" = $4 WHERE "id" = $1', [b.id, threadId, replied.id, replied.host]);

				let settled = false;
				const locking = db.transaction('READ COMMITTED', async transactionalEntityManager => await lockNoteRowsInIdOrder(transactionalEntityManager, [b.id, idService.gen(), a.id, b.id], 'KEY SHARE')).finally(() => settled = true);
				await waitUntilBlockedBy(holder, / FOR KEY SHARE$/);
				expect(settled).toBe(false);
				await holder.commitTransaction();

				expect(await locking).toEqual([
					{ id: a.id, threadId: null, replyUserId: null, replyUserHost: null, renoteUserId: null, renoteUserHost: null },
					{ id: b.id, threadId, replyUserId: replied.id, replyUserHost: replied.host, renoteUserId: replied.id, renoteUserHost: replied.host },
				]);
			} finally {
				if (holder.isTransactionActive) await holder.rollbackTransaction();
				await holder.release();
			}
		});

		test('deleteNotesWithDependents deletes the given notes and only their dependents', async () => {
			const author = await createUser();
			const other = await createUser();
			const deleted = await createNote(author);
			const kept = await createNote(author);
			await attachDependents(deleted, other);
			await attachDependents(kept, other);
			const missingId = idService.gen();

			const result = await db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [deleted.id, missingId], { record: true }));

			expect(result).toEqual([deleted.id]);
			expect(await notesRepository.existsBy({ id: deleted.id })).toBe(false);
			expect(await countDependents(deleted.id)).toEqual(dependentCounts(0));
			expect(await notesRepository.existsBy({ id: kept.id })).toBe(true);
			expect(await countDependents(kept.id)).toEqual(dependentCounts(1));
		});

		test('deleteNotesWithDependents records the ids of the notes it deleted only when asked to', async () => {
			const author = await createUser();
			const recorded = await createNote(author);
			const forgotten = await createNote(author);
			const kept = await createNote(author);
			const missingId = idService.gen();

			await db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [recorded.id, missingId], { record: true }));
			await db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [forgotten.id], { record: false }));

			expect(await notesRepository.countBy({ id: In([recorded.id, forgotten.id]) })).toBe(0);
			expect(await recordedIds([recorded.id, forgotten.id, kept.id, missingId])).toEqual([recorded.id]);
		});

		test('deleteNotesWithDependents keeps the uri of a deleted remote note that had none recorded, only when it records the deletion', async () => {
			const remote = await createUser({ host: 'remote.example.com' });
			const recordedUri = uniqueUri();
			const recorded = await createNote(remote, { uri: recordedUri });
			const forgotten = await createNote(remote, { uri: uniqueUri() });
			const listedUri = uniqueUri();
			const listed = await createNote(remote, { uri: listedUri });
			await noteUrisRepository.insert({ uri: listedUri, noteId: listed.id });

			await db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [recorded.id, listed.id], { record: true }));
			await db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [forgotten.id], { record: false }));

			expect(await noteUrisRepository.findBy({ noteId: In([recorded.id, forgotten.id, listed.id]) })).toEqual(expect.arrayContaining([
				{ uri: recordedUri, noteId: recorded.id },
				{ uri: listedUri, noteId: listed.id },
			]));
			expect(await noteUrisRepository.countBy({ noteId: In([recorded.id, forgotten.id, listed.id]) })).toBe(2);
			expect(await recordedIds([recorded.id, forgotten.id, listed.id])).toEqual([recorded.id, listed.id].sort());
		});

		test('recordDeletedNotes keeps an id recorded twice once', async () => {
			const id = idService.gen();

			await recordDeletedNotes(db, [{ id, uri: null }]);
			await recordDeletedNotes(db, [{ id, uri: null }, { id, uri: null }]);

			expect(await db.query('SELECT "id" FROM "deleted_note" WHERE "id" = $1', [id])).toEqual([{ id }]);
		});
	});

	describe('NoteDeleteService', () => {
		test('deletes the dependents of the deleted note', async () => {
			const author = await createUser();
			const other = await createUser();
			const note = await createNote(author);
			const kept = await createNote(author);
			await attachDependents(note, other);
			await attachDependents(kept, other);

			await noteDeleteService.delete(author, note, true);

			expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
			expect(await countDependents(note.id)).toEqual(dependentCounts(0));
			expect(await countDependents(kept.id)).toEqual(dependentCounts(1));
		});

		test('keeps the dependents when the note is not deleted', async () => {
			const author = await createUser();
			const other = await createUser();
			const note = await createNote(author);
			await attachDependents(note, other);

			await noteDeleteService.delete(other, note, true);

			expect(await notesRepository.existsBy({ id: note.id })).toBe(true);
			expect(await countDependents(note.id)).toEqual(dependentCounts(1));
			expect(await recordedIds([note.id])).toEqual([]);
		});

		test('records the ids of the deleted local and remote notes', async () => {
			const local = await createUser();
			const remote = await createUser({ host: 'remote.example.com' });
			const localNote = await createNote(local);
			const remoteUri = uniqueUri();
			const remoteNote = await createNote(remote, { uri: remoteUri });
			await noteUrisRepository.insert({ uri: remoteUri, noteId: remoteNote.id });

			await noteDeleteService.delete(local, localNote, true);
			await noteDeleteService.delete(remote, remoteNote, true);

			expect(await notesRepository.countBy({ id: In([localNote.id, remoteNote.id]) })).toBe(0);
			expect(await recordedIds([localNote.id, remoteNote.id])).toEqual([localNote.id, remoteNote.id].sort());
			expect(await noteUrisRepository.existsBy({ noteId: remoteNote.id })).toBe(true);
			expect(await noteUrisRepository.existsBy({ noteId: localNote.id })).toBe(false);
		});

		test('keeps the uri of a deleted remote note whose uri was not recorded yet, in the transaction that deletes it', async () => {
			const remote = await createUser({ host: 'remote.example.com' });
			const uri = uniqueUri();
			const note = await createNote(remote, { uri });
			await attachDependents(note, await createUser());

			await expect(failingAt(/^DELETE FROM "poll" /, () => noteDeleteService.delete(remote, note, true))).rejects.toThrow('interrupted');

			expect(await notesRepository.existsBy({ id: note.id })).toBe(true);
			expect(await noteUrisRepository.existsBy({ noteId: note.id })).toBe(false);

			await noteDeleteService.delete(remote, note, true);

			expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
			expect(await noteUrisRepository.findBy({ noteId: note.id })).toEqual([{ uri, noteId: note.id }]);
			expect(await recordedIds([note.id])).toEqual([note.id]);
		});

		test('records the id in the transaction that deletes the note', async () => {
			const author = await createUser();
			const note = await createNote(author);
			await attachDependents(note, await createUser());

			await expect(failingAt(/^DELETE FROM "poll" /, () => noteDeleteService.delete(author, note, true))).rejects.toThrow('interrupted');

			expect(await notesRepository.existsBy({ id: note.id })).toBe(true);
			expect(await recordedIds([note.id])).toEqual([]);

			await noteDeleteService.delete(author, note, true);

			expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
			expect(await recordedIds([note.id])).toEqual([note.id]);
		});

		test('deletes the recorded original parents of the note in the transaction that deletes it', async () => {
			const author = await createUser();
			const note = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID });
			await db.query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId") VALUES ($1, $2, NULL)', [note.id, idService.gen()]);

			await expect(failingAt(/^DELETE FROM "note_unlinked_relation" /, () => noteDeleteService.delete(author, note, true))).rejects.toThrow('interrupted');

			expect(await notesRepository.existsBy({ id: note.id })).toBe(true);
			expect(await countDependents(note.id)).toMatchObject({ note_unlinked_relation: 1 });

			await noteDeleteService.delete(author, note, true);

			expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
			expect(await countDependents(note.id)).toMatchObject({ note_unlinked_relation: 0 });
		});
	});

	describe('CleanRemoteNotesProcessorService', () => {
		test('deletes the dependents of the cleaned notes', async () => {
			meta.enableRemoteNotesCleaning = true;
			meta.remoteNotesCleaningMaxProcessingDurationInMinutes = 0.3;
			meta.remoteNotesCleaningExpiryDaysForEachNotes = 30;

			const remote = await createUser({ host: 'remote.example.com' });
			const remoteReactor = await createUser({ host: 'reactor.example.com' });
			const old = Date.now() - 1000 * 60 * 60 * 24 * 31;
			const root = await createNote(remote, {}, old);
			const reply = await createNote(remote, { replyId: root.id }, old + 1000);
			await noteRelationsRepository.insert({ childId: reply.id, parentId: root.id, kind: 0 });
			const protectors: DependentTable[] = ['note_favorite', 'clip_note', 'user_note_pining'];
			await attachDependents(root, remoteReactor, protectors);
			await attachDependents(reply, remoteReactor, protectors);

			await cleanRemoteNotesProcessorService.process({ log: vi.fn().mockResolvedValue(0), updateProgress: vi.fn() } as never);

			expect(await notesRepository.existsBy({ id: root.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reply.id })).toBe(false);
			expect(await countDependents(root.id)).toEqual(dependentCounts(0));
			expect(await countDependents(reply.id)).toEqual(dependentCounts(0));
			expect(await noteRelationsRepository.existsBy({ childId: reply.id })).toBe(false);
			expect(await recordedIds([root.id, reply.id])).toEqual([]);
		});

		test('forgets only the notes it deleted, not the ones deleted while it was cleaning', async () => {
			meta.enableRemoteNotesCleaning = true;
			meta.remoteNotesCleaningMaxProcessingDurationInMinutes = 0.3;
			meta.remoteNotesCleaningExpiryDaysForEachNotes = 30;

			const remote = await createUser({ host: 'remote.example.com' });
			const old = Date.now() - 1000 * 60 * 60 * 24 * 31;
			const deletedUri = uniqueUri();
			const deleted = await createNote(remote, { uri: deletedUri }, old);
			await noteUrisRepository.insert({ uri: deletedUri, noteId: deleted.id });
			const deletedReply = await createNote(remote, { replyId: deleted.id }, old + 1000);
			await noteRelationsRepository.insert({ childId: deletedReply.id, parentId: deleted.id, kind: 0 });
			const cleanedUri = uniqueUri();
			const cleaned = await createNote(remote, { uri: cleanedUri }, old + 2000);
			await noteUrisRepository.insert({ uri: cleanedUri, noteId: cleaned.id });

			const transaction = db.transaction.bind(db) as unknown as (...args: unknown[]) => Promise<unknown>;
			vi.spyOn(db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }, 'transaction').mockImplementationOnce(async (...args) => {
				await db.query('DELETE FROM "note" WHERE "id" = ANY($1)', [[deleted.id, deletedReply.id]]);
				return await transaction(...args);
			});

			const result = await cleanRemoteNotesProcessorService.process({ log: vi.fn().mockResolvedValue(0), updateProgress: vi.fn() } as never);

			expect(result.deletedCount).toBe(1);
			expect(await notesRepository.existsBy({ id: cleaned.id })).toBe(false);
			expect(await noteUrisRepository.existsBy({ noteId: cleaned.id })).toBe(false);
			expect(await noteUrisRepository.existsBy({ noteId: deleted.id })).toBe(true);
			expect(await noteRelationsRepository.existsBy({ childId: deletedReply.id, parentId: deleted.id })).toBe(true);
		});
	});

	describe('DeleteAccountProcessorService', () => {
		test('a hard deletion deletes the notes, the reactions and the notes sent anonymously, and schedules the purge', async () => {
			const target = await createUser();
			const other = await createUser();
			const own = await createNote(target);
			await attachDependents(own, other);
			const sent = await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' });
			await attachDependents(sent, other);
			const reacted = await createNote(other);
			await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
			await noteReactionsRepository.insert({ id: idService.gen(), userId: other.id, noteId: reacted.id, reaction: '👍' });
			await usersRepository.update(target.id, { isDeleted: true });
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id }, soft: false } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await countDependents(own.id)).toEqual(dependentCounts(0));
			expect(await notesRepository.existsBy({ id: sent.id })).toBe(false);
			expect(await countDependents(sent.id)).toEqual(dependentCounts(0));
			expect(await recordedIds([own.id, sent.id, reacted.id])).toEqual([own.id, sent.id].sort());
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await noteReactionsRepository.existsBy({ userId: other.id, noteId: reacted.id })).toBe(true);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(true);
			expect(add).toHaveBeenCalledTimes(1);
			expect(add).toHaveBeenCalledWith('purgeAccount', { user: { id: target.id } }, expect.objectContaining({ delay: expect.any(Number), jobId: `purgeAccount-${target.id}` }));
			expect((add.mock.calls[0][2] as { delay: number }).delay).toBeGreaterThanOrEqual(1000 * 60 * 60 * 48);
		});

		test('a hard deletion of a remote user deletes the user in the same job and schedules nothing', async () => {
			const target = await createUser({ host: 'remote.example.com', isDeleted: true });
			const other = await createUser();
			const own = await createNote(target);
			await attachDependents(own, other);
			const reacted = await createNote(other);
			await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id } } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await countDependents(own.id)).toEqual(dependentCounts(0));
			expect(await recordedIds([own.id])).toEqual([own.id]);
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			expect(add).not.toHaveBeenCalled();
		});

		test('a hard deletion of a remote user keeps the uris of its notes whose uris were not recorded yet', async () => {
			const target = await createUser({ host: 'remote.example.com', isDeleted: true });
			const uri = uniqueUri();
			const own = await createNote(target, { uri });
			vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id } } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await noteUrisRepository.findBy({ noteId: own.id })).toEqual([{ uri, noteId: own.id }]);
			expect(await recordedIds([own.id])).toEqual([own.id]);
		});

		test('a hard deletion that failed part way runs again and sends the email once', async () => {
			const target = await createUser();
			await userProfilesRepository.update({ userId: target.id }, { email: `${secureRndstr(8)}@example.com`, emailVerified: true });
			const own = await createNote(target);
			await usersRepository.update(target.id, { isDeleted: true });
			const sendEmail = vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
			vi.spyOn(deleteAccountProcessorService as unknown as { deleteReactionsOf: (user: MiUser) => Promise<void> }, 'deleteReactionsOf').mockRejectedValueOnce(new Error('interrupted'));
			const job = { data: { user: { id: target.id }, soft: false } } as never;

			await expect(deleteAccountProcessorService.process(job)).rejects.toThrow('interrupted');
			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(sendEmail).not.toHaveBeenCalled();
			expect(add).not.toHaveBeenCalled();

			await deleteAccountProcessorService.process(job);

			expect(sendEmail).toHaveBeenCalledTimes(1);
			expect(add).toHaveBeenCalledTimes(1);
			expect(add).toHaveBeenCalledWith('purgeAccount', { user: { id: target.id } }, expect.objectContaining({ jobId: `purgeAccount-${target.id}` }));
			expect(await usersRepository.existsBy({ id: target.id })).toBe(true);
		});

		test('a soft deletion deletes the notes only and schedules nothing', async () => {
			const target = await createUser({ host: 'remote.example.com' });
			const other = await createUser();
			const own = await createNote(target);
			const sent = await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' });
			const reacted = await createNote(other);
			await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
			await usersRepository.update(target.id, { isDeleted: true });
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id }, soft: true } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await recordedIds([own.id, sent.id])).toEqual([own.id]);
			expect(await notesRepository.existsBy({ id: sent.id })).toBe(true);
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(true);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(true);
			expect(add).not.toHaveBeenCalled();
		});

		test('the purge deletes what was left and then the user', async () => {
			const target = await createUser({ isDeleted: true });
			const other = await createUser();
			const late = await createNote(target);
			await attachDependents(late, other);
			const sent = await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' });
			await attachDependents(sent, other);
			const reacted = await createNote(other);
			await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });

			await deleteAccountProcessorService.processPurge({ data: { user: { id: target.id } } } as never);

			expect(await notesRepository.existsBy({ id: late.id })).toBe(false);
			expect(await countDependents(late.id)).toEqual(dependentCounts(0));
			expect(await notesRepository.existsBy({ id: sent.id })).toBe(false);
			expect(await countDependents(sent.id)).toEqual(dependentCounts(0));
			expect(await recordedIds([late.id, sent.id, reacted.id])).toEqual([late.id, sent.id].sort());
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
		});

		test('the purge deletes again, right after the user, what was written for the user after its last cleanup', async () => {
			const target = await createUser({ isDeleted: true });
			const other = await createUser();
			const reacted = await createNote(other);
			const late: MiNote[] = [];
			const deleteUser = usersRepository.delete.bind(usersRepository);
			vi.spyOn(usersRepository, 'delete').mockImplementationOnce(async criteria => {
				late.push(await createNote(target));
				late.push(await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' }));
				for (const note of late) await attachDependents(note, other);
				await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
				return await deleteUser(criteria);
			});

			await deleteAccountProcessorService.processPurge({ data: { user: { id: target.id } } } as never);

			expect(late).toHaveLength(2);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			for (const note of late) {
				expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
				expect(await countDependents(note.id)).toEqual(dependentCounts(0));
			}
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
		});

		test('a purge that dies after deleting the user deletes, when it is retried, what was written for the user after its last cleanup', async () => {
			const target = await createUser({ isDeleted: true });
			const other = await createUser();
			const reacted = await createNote(other);
			const late: MiNote[] = [];
			const deleteUser = usersRepository.delete.bind(usersRepository);
			vi.spyOn(usersRepository, 'delete').mockImplementationOnce(async criteria => {
				late.push(await createNote(target));
				late.push(await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' }));
				for (const note of late) await attachDependents(note, other);
				await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
				const result = await deleteUser(criteria);
				vi.spyOn(deleteAccountProcessorService as unknown as { deleteReactionsOf: (user: { id: MiUser['id'] }) => Promise<void> }, 'deleteReactionsOf').mockRejectedValueOnce(new Error('the job died'));
				return result;
			});
			const job = { data: { user: { id: target.id } } } as never;

			await expect(deleteAccountProcessorService.processPurge(job)).rejects.toThrow('the job died');

			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			expect(await notesRepository.countBy({ id: In(late.map(note => note.id)) })).toBe(2);
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(true);

			expect(await deleteAccountProcessorService.processPurge(job)).toBe('Account purged');

			for (const note of late) {
				expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
				expect(await countDependents(note.id)).toEqual(dependentCounts(0));
			}
			expect(await recordedIds(late.map(note => note.id))).toEqual(late.map(note => note.id).sort());
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
		});

		function withNoteIdFloors(): void {
			const isPhaseFinished = partitionMigrationStateService.isPhaseFinished.bind(partitionMigrationStateService);
			vi.spyOn(partitionMigrationStateService, 'isPhaseFinished').mockImplementation(async name => name === 'userNoteIdFloorBackfill' || await isPhaseFinished(name));
		}

		function writeLateFor(target: MiUser, other: MiUser, reacted: MiNote, late: MiNote[], afterDeletion?: () => void): void {
			const deleteUser = usersRepository.delete.bind(usersRepository);
			vi.spyOn(usersRepository, 'delete').mockImplementationOnce(async criteria => {
				late.push(await createNote(target, {}, Date.now() - 1000 * 60 * 60 * 24 * 365));
				late.push(await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' }));
				for (const note of late) await attachDependents(note, other);
				await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
				const result = await deleteUser(criteria);
				afterDeletion?.();
				return result;
			});
		}

		test('a hard deletion of a remote user deletes again, right after the user, what was written for the user after its last cleanup, however old', async () => {
			withNoteIdFloors();
			const target = await createUser({ host: 'remote.example.com', isDeleted: true });
			const other = await createUser();
			const reacted = await createNote(other);
			const late: MiNote[] = [];
			writeLateFor(target, other, reacted, late);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id } } } as never);

			expect(late).toHaveLength(2);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			for (const note of late) {
				expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
				expect(await countDependents(note.id)).toEqual(dependentCounts(0));
			}
			expect(await recordedIds(late.map(note => note.id))).toEqual(late.map(note => note.id).sort());
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
		});

		test('a hard deletion of a remote user that dies after deleting the user deletes, when it is retried, what was written for the user after its last cleanup', async () => {
			withNoteIdFloors();
			const target = await createUser({ host: 'remote.example.com', isDeleted: true });
			const other = await createUser();
			const reacted = await createNote(other);
			const late: MiNote[] = [];
			writeLateFor(target, other, reacted, late, () => {
				vi.spyOn(deleteAccountProcessorService as unknown as { deleteReactionsOf: (user: { id: MiUser['id'] }) => Promise<void> }, 'deleteReactionsOf').mockRejectedValueOnce(new Error('the job died'));
			});
			const job = { data: { user: { id: target.id } } } as never;

			await expect(deleteAccountProcessorService.process(job)).rejects.toThrow('the job died');

			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			expect(await notesRepository.countBy({ id: In(late.map(note => note.id)) })).toBe(2);
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(true);

			await deleteAccountProcessorService.process(job);

			for (const note of late) {
				expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
				expect(await countDependents(note.id)).toEqual(dependentCounts(0));
			}
			expect(await recordedIds(late.map(note => note.id))).toEqual(late.map(note => note.id).sort());
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
		});

		test('the purge stops a cached native token of the user from authenticating', async () => {
			const token = secureRndstr(16);
			const target = await createUser({ token });
			expect((await authenticateService.authenticate(token))[0]).toMatchObject({ id: target.id });
			await usersRepository.update(target.id, { isDeleted: true });

			await deleteAccountProcessorService.processPurge({ data: { user: { id: target.id } } } as never);

			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			await vi.waitFor(async () => {
				await expect(authenticateService.authenticate(token)).rejects.toThrow('user not found');
			}, { timeout: 5000, interval: 50 });
		});

		test('a hard deletion of a remote user stops the caches from resolving its uri and its key to it', async () => {
			const uri = `https://remote.example.com/users/${secureRndstr(16)}`;
			const keyId = `${uri}#main-key`;
			const target = await createUser({ host: 'remote.example.com', uri });
			await userPublickeysRepository.insert({ userId: target.id, keyId, keyPem: secureRndstr(16) });
			expect(await apDbResolverService.getUserFromApId(uri)).toMatchObject({ id: target.id });
			expect(await apDbResolverService.getAuthUserFromKeyId(keyId)).toMatchObject({ user: { id: target.id } });

			await deleteAccountProcessorService.process({ data: { user: { id: target.id } } } as never);

			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			const recreated = await createUser({ host: 'remote.example.com', uri });
			await userPublickeysRepository.insert({ userId: recreated.id, keyId, keyPem: secureRndstr(16) });
			await vi.waitFor(async () => {
				expect(await apDbResolverService.getUserFromApId(uri)).toMatchObject({ id: recreated.id });
				expect(await apDbResolverService.getAuthUserFromKeyId(keyId)).toMatchObject({ user: { id: recreated.id } });
			}, { timeout: 5000, interval: 50 });
		});

		test('a hard deletion deletes the files with their storage objects and the pages', async () => {
			const target = await createUser({ isDeleted: true });
			const referenced = await createNote(await createUser());
			const file = await createFile(target);
			const page = await createPage(target, referenced);
			const del = vi.spyOn(internalStorageService, 'del').mockImplementation(() => {});
			vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id }, soft: false } } as never);

			expect(await driveFilesRepository.existsBy({ id: file.id })).toBe(false);
			expect(del).toHaveBeenCalledWith(file.accessKey);
			expect(await pagesRepository.existsBy({ id: page.id })).toBe(false);
			expect(await notesRepository.findOneByOrFail({ id: referenced.id })).toMatchObject({ pageCount: 0 });
			expect(await usersRepository.existsBy({ id: target.id })).toBe(true);
		});

		test('the purge alone finishes a deletion whose deletion job was lost, without sending the email', async () => {
			const target = await createUser({ isDeleted: true });
			await userProfilesRepository.update({ userId: target.id }, { email: `${secureRndstr(8)}@example.com`, emailVerified: true });
			const other = await createUser();
			const own = await createNote(target);
			await attachDependents(own, other);
			const sent = await createNote(other, { anonymouslySendToUserId: target.id, visibility: 'specified' });
			await attachDependents(sent, other);
			const reacted = await createNote(other);
			await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });
			const file = await createFile(target);
			const referenced = await createNote(other);
			const page = await createPage(target, referenced);
			expect(await notesRepository.findOneByOrFail({ id: referenced.id })).toMatchObject({ pageCount: 1 });
			const del = vi.spyOn(internalStorageService, 'del').mockImplementation(() => {});
			const sendEmail = vi.spyOn(emailService, 'sendEmail').mockResolvedValue(undefined);

			await deleteAccountProcessorService.processPurge({ data: { user: { id: target.id } } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await countDependents(own.id)).toEqual(dependentCounts(0));
			expect(await notesRepository.existsBy({ id: sent.id })).toBe(false);
			expect(await countDependents(sent.id)).toEqual(dependentCounts(0));
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(false);
			expect(await notesRepository.existsBy({ id: reacted.id })).toBe(true);
			expect(await driveFilesRepository.existsBy({ id: file.id })).toBe(false);
			expect(del).toHaveBeenCalledWith(file.accessKey);
			expect(await pagesRepository.existsBy({ id: page.id })).toBe(false);
			expect(await notesRepository.findOneByOrFail({ id: referenced.id })).toMatchObject({ pageCount: 0 });
			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			expect(sendEmail).not.toHaveBeenCalled();
		});

		test('the purge leaves a user that is not deleted', async () => {
			const target = await createUser();
			const note = await createNote(target);
			const reacted = await createNote(await createUser());
			await noteReactionsRepository.insert({ id: idService.gen(), userId: target.id, noteId: reacted.id, reaction: '👍' });

			await deleteAccountProcessorService.processPurge({ data: { user: { id: target.id } } } as never);

			expect(await usersRepository.existsBy({ id: target.id })).toBe(true);
			expect(await notesRepository.existsBy({ id: note.id })).toBe(true);
			expect(await noteReactionsRepository.existsBy({ userId: target.id })).toBe(true);
		});

		test('a hard deletion marks the user deleted when the request did not, so that the purge still deletes the user', async () => {
			const target = await createUser();
			const own = await createNote(target);
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
			const publish = vi.spyOn(globalEventService, 'publishInternalEvent');

			await deleteAccountProcessorService.process({ data: { user: { id: target.id }, soft: false } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await usersRepository.findOneByOrFail({ id: target.id })).toMatchObject({ isDeleted: true });
			expect(publish).toHaveBeenCalledWith('userChangeDeletedState', { id: target.id, isDeleted: true });
			expect(add).toHaveBeenCalledWith('purgeAccount', { user: { id: target.id } }, expect.objectContaining({ jobId: `purgeAccount-${target.id}` }));

			await deleteAccountProcessorService.processPurge({ data: { user: { id: target.id } } } as never);

			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
		});

		test('a hard deletion of a remote user that is not marked deleted yet still deletes the user', async () => {
			const target = await createUser({ host: 'remote.example.com' });
			const own = await createNote(target);
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await deleteAccountProcessorService.process({ data: { user: { id: target.id } } } as never);

			expect(await notesRepository.existsBy({ id: own.id })).toBe(false);
			expect(await usersRepository.existsBy({ id: target.id })).toBe(false);
			expect(add).not.toHaveBeenCalled();
		});
	});

	describe('DeleteAccountService', () => {
		test('marks the user deleted only after the deletion job is queued', async () => {
			const target = await createUser();
			const add = vi.spyOn(queueService.dbQueue, 'add').mockRejectedValueOnce(new Error('redis is down'));

			await expect(deleteAccountService.deleteAccount(target)).rejects.toThrow('redis is down');
			expect(await usersRepository.findOneByOrFail({ id: target.id })).toMatchObject({ isDeleted: false });

			add.mockResolvedValueOnce(undefined as never);
			await deleteAccountService.deleteAccount(target);

			expect(add).toHaveBeenLastCalledWith('deleteAccount', { user: { id: target.id }, soft: false }, expect.objectContaining({ jobId: `deleteAccount-${target.id}` }));
			expect(await usersRepository.findOneByOrFail({ id: target.id })).toMatchObject({ isDeleted: true });
		});
	});

	describe('ApInboxService', () => {
		async function createRemoteActor(data: Partial<MiUser> = {}): Promise<MiRemoteUser> {
			return await createUser({ host: 'remote.example.com', uri: `https://remote.example.com/users/${secureRndstr(16)}`, ...data }) as MiRemoteUser;
		}

		function deleteOf(actor: MiRemoteUser): IDelete {
			return { type: 'Delete', id: `${actor.uri}#delete`, actor: actor.uri, object: actor.uri };
		}

		test('a Delete of an actor whose deletion job could not be queued queues it when the activity is retried', async () => {
			const actor = await createRemoteActor();
			const add = vi.spyOn(queueService.dbQueue, 'add').mockRejectedValueOnce(new Error('redis is down'));

			await expect(apInboxService.performOneActivity(actor, deleteOf(actor))).rejects.toThrow('redis is down');
			expect(await usersRepository.findOneByOrFail({ id: actor.id })).toMatchObject({ isDeleted: false });

			add.mockResolvedValueOnce({ name: 'deleteAccount', id: `deleteAccount-${actor.id}` } as never);
			expect(await apInboxService.performOneActivity(actor, deleteOf(actor))).toBe(`ok: queued deleteAccount deleteAccount-${actor.id}`);
			expect(add).toHaveBeenLastCalledWith('deleteAccount', { user: { id: actor.id } }, expect.objectContaining({ jobId: `deleteAccount-${actor.id}` }));
			expect(await usersRepository.findOneByOrFail({ id: actor.id })).toMatchObject({ isDeleted: true });
		});

		test('a Delete of an actor that is already deleted queues nothing', async () => {
			const actor = await createRemoteActor({ isDeleted: true });
			const add = vi.spyOn(queueService.dbQueue, 'add');

			expect(await apInboxService.performOneActivity(actor, deleteOf(actor))).toBe('skip: already deleted or actor not found');
			expect(add).not.toHaveBeenCalled();
		});
	});

	describe('QueueService', () => {
		test('the purge waits for the deliver retries with a margin', async () => {
			const original = config.deliverJobMaxAttempts;
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
			try {
				config.deliverJobMaxAttempts = 12;
				await queueService.createPurgeAccountJob({ id: 'a' });
				config.deliverJobMaxAttempts = 3;
				await queueService.createPurgeAccountJob({ id: 'b' });
			} finally {
				config.deliverJobMaxAttempts = original;
			}

			expect(add).toHaveBeenNthCalledWith(1, 'purgeAccount', { user: { id: 'a' } }, expect.objectContaining({ delay: 183_024_000 }));
			expect(add).toHaveBeenNthCalledWith(2, 'purgeAccount', { user: { id: 'b' } }, expect.objectContaining({ delay: 172_800_000 }));
		});

		test('the account jobs are retried with a backoff under an id fixed per user', async () => {
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await queueService.createDeleteAccountJob({ id: 'a' }, { soft: true });
			await queueService.createPurgeAccountJob({ id: 'a' });

			const retry = { attempts: 10, backoff: { type: 'exponential', delay: 60_000 } };
			expect(add).toHaveBeenNthCalledWith(1, 'deleteAccount', { user: { id: 'a' }, soft: true }, expect.objectContaining({ jobId: 'deleteAccount-a', ...retry }));
			expect(add).toHaveBeenNthCalledWith(2, 'purgeAccount', { user: { id: 'a' } }, expect.objectContaining({ jobId: 'purgeAccount-a', ...retry }));
		});

		test('the purge is removed as soon as it fails, unlike the deletion job', async () => {
			const add = vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			await queueService.createDeleteAccountJob({ id: 'a' });
			await queueService.createPurgeAccountJob({ id: 'a' });

			expect(add.mock.calls[0][2]?.removeOnFail).toEqual({ age: 3600 * 24 * 7, count: 100 });
			expect(add.mock.calls[1][2]?.removeOnFail).toBe(true);
		});

		test('the account jobs are queued once per user', async () => {
			const userId = idService.gen();
			const deletion = await queueService.createDeleteAccountJob({ id: userId });
			const purge = await queueService.createPurgeAccountJob({ id: userId });
			try {
				expect((await queueService.createDeleteAccountJob({ id: userId })).id).toBe(deletion.id);
				expect((await queueService.createPurgeAccountJob({ id: userId })).id).toBe(purge.id);

				expect((await queueService.dbQueue.getWaiting()).filter(job => job.data.user.id === userId).map(job => job.name)).toEqual(['deleteAccount']);
				expect((await queueService.dbQueue.getDelayed()).filter(job => job.data.user.id === userId).map(job => job.name)).toEqual(['purgeAccount']);
				expect(purge.opts.removeOnFail).toBe(true);
			} finally {
				await deletion.remove();
				await purge.remove();
			}
		});
	});

	describe('waiting children', () => {
		test('the sweep locks a child before claiming its pending row', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const parentUri = uniqueUri();
			const parent = await createNote(author, { uri: parentUri });
			await noteUrisRepository.insert({ uri: parentUri, noteId: parent.id });
			const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
			await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(deleter.manager, [child.id], 'UPDATE')).toEqual([child.id]);

				const sweep = sweepPendingParents(db, idService, Date.now() + 10_000);
				await waitUntilBlockedBy(deleter, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/);

				expect(await deleteNotesWithDependents(deleter.manager, [child.id], { record: true })).toEqual([child.id]);
				await deleter.commitTransaction();

				expect(await sweep).toBe(true);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}

			expect(await notePendingParentsRepository.existsBy({ childId: child.id })).toBe(false);
			expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(0);
		});

		test('the sweep claims a pending row whose child is gone', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const parentUri = uniqueUri();
			const parent = await createNote(author, { uri: parentUri });
			await noteUrisRepository.insert({ uri: parentUri, noteId: parent.id });
			const missingId = idService.gen(Date.now() + 1000);
			await notePendingParentsRepository.insert({ parentUri, childId: missingId, kind: 0 });

			expect(await sweepPendingParents(db, idService, Date.now() + 10_000)).toBe(true);

			expect(await notePendingParentsRepository.existsBy({ childId: missingId })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(0);
		});

		test('joining a parent locks a child before claiming its pending row', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const parentUri = uniqueUri();
			const parent = await createNote(author, { uri: parentUri });
			const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
			await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(deleter.manager, [child.id], 'UPDATE')).toEqual([child.id]);

				const join = (noteCreateService as unknown as { joinPendingChildren: (parent: MiNote) => Promise<void> }).joinPendingChildren(parent);
				await waitUntilBlockedBy(deleter, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/);

				expect(await deleteNotesWithDependents(deleter.manager, [child.id], { record: true })).toEqual([child.id]);
				await deleter.commitTransaction();

				await join;
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}

			expect(await notePendingParentsRepository.existsBy({ childId: child.id })).toBe(false);
			expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(0);
		});

		test('joining a parent still links a waiting child', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const parentUri = uniqueUri();
			const parent = await createNote(author, { uri: parentUri });
			const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
			await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

			await (noteCreateService as unknown as { joinPendingChildren: (parent: MiNote) => Promise<void> }).joinPendingChildren(parent);

			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(parent.id);
			expect(await notePendingParentsRepository.existsBy({ childId: child.id })).toBe(false);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: parent.id, kind: 0 })).toBe(true);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(1);
		});

		test('a failed join does not stop the rest of the post-processing', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const note = await createNote(author, { uri: uniqueUri() });
			const service = noteCreateService as unknown as {
				joinPendingChildren: (parent: MiNote) => Promise<void>;
				index: (note: MiNote) => void;
				postNoteCreated: (note: MiNote, user: MiUser, data: object, silent: boolean, tags: string[], mentionedUsers: MiUser[], waitingParentUris: string[]) => Promise<void>;
			};
			vi.spyOn(service, 'joinPendingChildren').mockRejectedValue(new Error('join failed'));
			const index = vi.spyOn(service, 'index').mockReturnValue(undefined);
			vi.spyOn(console, 'error').mockReturnValue(undefined);

			await service.postNoteCreated(note, author, { visibility: 'public', text: note.text }, true, [], [], []);

			expect(index).toHaveBeenCalledWith(note);
			await vi.waitFor(async () => expect((await usersRepository.findOneByOrFail({ id: author.id })).notesCount).toBe(1));
		});

		describe.each<[string, (parent: MiNote, parentUri: string) => Promise<void>]>([
			['joining a parent', async parent => {
				await (noteCreateService as unknown as { joinPendingChildren: (parent: MiNote) => Promise<void> }).joinPendingChildren(parent);
			}],
			['the sweep', async (parent, parentUri) => {
				await noteUrisRepository.insert({ uri: parentUri, noteId: parent.id });
				expect(await sweepPendingParents(db, idService, Date.now() + 10_000)).toBe(true);
			}],
		])('%s', (_, join) => {
			test('locks the parent together with the children in id order', async () => {
				const author = await createUser({ host: 'remote.example.com' });
				const parentUri = uniqueUri();
				const parent = await createNote(author, { uri: parentUri });
				const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
				await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

				const deleter = db.createQueryRunner();
				await deleter.connect();
				try {
					await deleter.startTransaction('READ COMMITTED');
					expect(await lockNotesInIdOrder(deleter.manager, [parent.id], 'UPDATE')).toEqual([parent.id]);

					const joining = join(parent, parentUri);
					await waitUntilBlockedBy(deleter, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/);

					expect((await deleteNotesWithDependents(deleter.manager, [parent.id, child.id], { record: true })).sort()).toEqual([parent.id, child.id].sort());
					await deleter.commitTransaction();

					await joining;
				} finally {
					if (deleter.isTransactionActive) await deleter.rollbackTransaction();
					await deleter.release();
				}

				expect(await notePendingParentsRepository.existsBy({ childId: child.id })).toBe(false);
				expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
			});

			test('holds nothing on note_pending_parent while it waits for the notes, so a switch that drops the foreign keys is not deadlocked', async () => {
				const author = await createUser({ host: 'remote.example.com' });
				const parentUri = uniqueUri();
				const parent = await createNote(author, { uri: parentUri });
				const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
				await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

				const switcher = db.createQueryRunner();
				await switcher.connect();
				try {
					await switcher.startTransaction('READ COMMITTED');
					await switcher.query('LOCK TABLE "note" IN EXCLUSIVE MODE');

					const joining = join(parent, parentUri);
					await waitUntilBlockedBy(switcher, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/);

					await switcher.query('SET LOCAL lock_timeout = \'500ms\'');
					await switcher.query('LOCK TABLE "note_pending_parent" IN ACCESS EXCLUSIVE MODE');
					await switcher.commitTransaction();

					await joining;
				} finally {
					if (switcher.isTransactionActive) await switcher.rollbackTransaction();
					await switcher.release();
				}

				expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(parent.id);
				expect(await notePendingParentsRepository.existsBy({ childId: child.id })).toBe(false);
			});

			test('links the children without locking the replies to them, and moves the replies once a deletion holding one of them commits', async () => {
				const author = await createUser({ host: 'remote.example.com' });
				const parentUri = uniqueUri();
				const parent = await createNote(author, { uri: parentUri });
				const first = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
				const reply = await createNote(author, { replyId: first.id, threadId: first.id }, Date.now() + 2000);
				const second = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 3000);
				await notePendingParentsRepository.insert([{ parentUri, childId: first.id, kind: 0 }, { parentUri, childId: second.id, kind: 0 }]);

				const deleter = db.createQueryRunner();
				await deleter.connect();
				try {
					await deleter.startTransaction('READ COMMITTED');
					expect(await lockNotesInIdOrder(deleter.manager, [reply.id], 'UPDATE')).toEqual([reply.id]);

					const joining = join(parent, parentUri);
					await waitUntilBlockedBy(deleter, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/);

					expect((await deleteNotesWithDependents(deleter.manager, [reply.id, second.id], { record: true })).sort()).toEqual([reply.id, second.id].sort());
					await deleter.commitTransaction();

					await joining;
				} finally {
					if (deleter.isTransactionActive) await deleter.rollbackTransaction();
					await deleter.release();
				}

				const linked = await notesRepository.findOneByOrFail({ id: first.id });
				expect(linked.replyId).toBe(parent.id);
				expect(linked.threadId).toBe(parent.id);
				expect(await notePendingParentsRepository.existsBy({ childId: In([first.id, second.id]) })).toBe(false);
				expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(2);
			});

			test('searches the partitions for the replies to a waiting child before the transaction that joins it, so the transaction does not hold every partition it searched', async () => {
				const author = await createUser({ host: 'remote.example.com' });
				const parentUri = uniqueUri();
				const parent = await createNote(author, { uri: parentUri });
				const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
				const reply = await createNote(author, { replyId: child.id, threadId: child.id }, Date.now() + 2000);
				await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });
				const searches: boolean[] = [];
				const subscriber: EntitySubscriberInterface = {
					beforeQuery: event => {
						if (/"threadId" = ANY\(\$1\) AND "id" >= /.test(event.query)) searches.push(event.queryRunner.isTransactionActive);
					},
				};
				db.subscribers.push(subscriber);
				try {
					await join(parent, parentUri);
				} finally {
					db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
				}

				expect(searches.length).toBeGreaterThan(0);
				expect(searches).not.toContain(true);
				expect((await notesRepository.findOneByOrFail({ id: reply.id })).threadId).toBe(parent.id);
			});

			test('still moves the replies to a waiting child to the thread of the parent', async () => {
				const author = await createUser({ host: 'remote.example.com' });
				const parentUri = uniqueUri();
				const parent = await createNote(author, { uri: parentUri });
				const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, Date.now() + 1000);
				const reply = await createNote(author, { replyId: child.id, threadId: child.id }, Date.now() + 2000);
				const replyToReply = await createNote(author, { replyId: reply.id, threadId: child.id }, Date.now() + 3000);
				await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });

				await join(parent, parentUri);

				expect((await notesRepository.findOneByOrFail({ id: child.id })).threadId).toBe(parent.id);
				expect((await notesRepository.findOneByOrFail({ id: reply.id })).threadId).toBe(parent.id);
				expect((await notesRepository.findOneByOrFail({ id: replyToReply.id })).threadId).toBe(parent.id);
			});
		});
	});

	describe('deleting a linked child whose replies a join failed to move', () => {
		const pendingLookup = /^SELECT "childId" FROM "note_pending_parent" WHERE "childId" = ANY\(\$1\) AND "kind" = 0/;

		async function mutedThreadsOf(user: MiUser): Promise<string[]> {
			return (await noteThreadMutingsRepository.findBy({ userId: user.id })).map(muting => muting.threadId).sort();
		}

		async function interruptedJoin(author: MiUser, time: number): Promise<{ parent: MiNote; child: MiNote; grandchild: MiNote; muting: MiUser }> {
			const other = await createUser({ host: 'remote.example.com' });
			const parentUri = uniqueUri();
			const parent = await createNote(other, { uri: parentUri }, time);
			const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, time + 1000);
			await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });
			const grandchild = await createNote(other, { replyId: child.id, threadId: child.id }, time + 2000);
			await noteRelationsRepository.insert({ childId: grandchild.id, parentId: child.id, kind: 0 });
			const muting = await createUser();
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: muting.id, threadId: child.id });

			await expect(failingAt(/^UPDATE "note" SET "threadId" = \$1 WHERE "id" IN/, () => joinChildrenToParent(db, idService, parent, parentUri, [{ childId: child.id, kind: 0 }]))).rejects.toThrow('interrupted');

			expect(await notesRepository.findOneByOrFail({ id: child.id })).toMatchObject({ replyId: parent.id, threadId: parent.id });
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(child.id);
			expect(await notePendingParentsRepository.countBy({ childId: child.id })).toBe(1);
			expect(await mutedThreadsOf(muting)).toEqual([child.id, parent.id].sort());
			return { parent, child, grandchild, muting };
		}

		async function observingDeletion(child: MiNote, grandchild: MiNote, run: () => Promise<unknown>): Promise<{ lookups: MiNote['id'][][]; atDeletion: { threadId: string | null; pending: number }[] }> {
			const lookups: MiNote['id'][][] = [];
			const atDeletion: { threadId: string | null; pending: number }[] = [];
			const subscriber: EntitySubscriberInterface = {
				beforeQuery: async event => {
					if (pendingLookup.test(event.query)) lookups.push((event.parameters as MiNote['id'][][])[0]);
					if (/^DELETE FROM "note" WHERE "id" /.test(event.query) && (event.parameters ?? []).includes(child.id)) {
						atDeletion.push({
							threadId: (await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId,
							pending: await notePendingParentsRepository.countBy({ childId: child.id }),
						});
					}
				},
			};
			db.subscribers.push(subscriber);
			try {
				await run();
			} finally {
				db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			}
			return { lookups, atDeletion };
		}

		test('NoteDeleteService finishes moving the replies to the child, with the mutings of its thread, before it deletes the child, and looks up the pending rows once before the deletion and once under its lock', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const { parent, child, grandchild, muting } = await interruptedJoin(author, Date.now() - 60_000);

			const { lookups, atDeletion } = await observingDeletion(child, grandchild, () => noteDeleteService.delete(author, child, true));

			expect(atDeletion).toEqual([{ threadId: parent.id, pending: 0 }]);
			expect(await notesRepository.existsBy({ id: child.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(parent.id);
			expect(await mutedThreadsOf(muting)).toEqual([parent.id]);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(0);
			expect(lookups).toEqual([[child.id], [child.id]]);
		});

		test('DeleteAccountProcessorService finishes moving the replies to the child before it deletes the batch with the child, and looks up the pending rows of each batch once before the deletion and once under its lock', async () => {
			const author = await createUser({ host: 'remote.example.com', isDeleted: true });
			const time = Date.now() - 60 * 60_000;
			const { parent, child, grandchild, muting } = await interruptedJoin(author, time);
			const others: MiNote[] = [];
			for (let i = 0; i < 119; i++) {
				others.push(await createNote(author, {}, time + 3000 + i * 1000));
			}
			vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);

			const { lookups, atDeletion } = await observingDeletion(child, grandchild, () => deleteAccountProcessorService.process({ data: { user: { id: author.id } } } as never));

			expect(atDeletion).toEqual([{ threadId: parent.id, pending: 0 }]);
			expect(await notesRepository.countBy({ userId: author.id })).toBe(0);
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(parent.id);
			expect(await mutedThreadsOf(muting)).toEqual([parent.id]);
			expect(lookups.map(ids => ids.length)).toEqual([100, 100, 20, 20]);
			expect(lookups.flat().sort()).toEqual([child.id, child.id, ...others.flatMap(note => [note.id, note.id])].sort());
		});

		test('CleanRemoteNotesProcessorService finishes moving the replies to the child, with the mutings of its thread, before it evicts the tree with the child, and looks up the pending rows of the batch once before the eviction and once under its lock', async () => {
			meta.enableRemoteNotesCleaning = true;
			meta.remoteNotesCleaningMaxProcessingDurationInMinutes = 0.3;
			meta.remoteNotesCleaningExpiryDaysForEachNotes = 30;
			const author = await createUser({ host: 'remote.example.com' });
			const { parent, child, grandchild, muting } = await interruptedJoin(author, Date.now() - 1000 * 60 * 60 * 24 * 31);

			const { lookups, atDeletion } = await observingDeletion(child, grandchild, () => cleanRemoteNotesProcessorService.process({ log: vi.fn().mockResolvedValue(0), updateProgress: vi.fn() } as never));

			expect(atDeletion).toEqual([{ threadId: parent.id, pending: 0 }]);
			expect(await notesRepository.countBy({ id: In([parent.id, child.id, grandchild.id]) })).toBe(0);
			expect(await mutedThreadsOf(muting)).toEqual([parent.id]);
			expect(lookups.filter(ids => ids.includes(child.id))).toHaveLength(2);
			for (const ids of lookups.filter(ids => ids.includes(child.id))) {
				expect(ids).toEqual(expect.arrayContaining([parent.id, child.id, grandchild.id]));
			}
		});
	});

	describe('deleting a child that a join links after the deletion looked up the pending rows', () => {
		async function linkedBeforeTheLock<T>(child: MiNote, link: () => Promise<unknown>, run: () => Promise<T>): Promise<T> {
			let fired = false;
			const subscriber: EntitySubscriberInterface = {
				beforeQuery: async event => {
					if (fired || !/ FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/.test(event.query) || !(event.parameters ?? []).includes(child.id)) return;
					fired = true;
					await link();
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

		async function waitingChild(author: MiUser, time: number): Promise<{ parent: MiNote; parentUri: string; child: MiNote; grandchild: MiNote }> {
			const other = await createUser({ host: 'remote.example.com' });
			const parentUri = uniqueUri();
			const parent = await createNote(other, { uri: parentUri }, time);
			const child = await createNote(author, { replyId: UNREFERENCEABLE_NOTE_ID }, time + 1000);
			await notePendingParentsRepository.insert({ parentUri, childId: child.id, kind: 0 });
			const grandchild = await createNote(other, { replyId: child.id, threadId: child.id }, time + 2000);
			await noteRelationsRepository.insert({ childId: grandchild.id, parentId: child.id, kind: 0 });
			return { parent, parentUri, child, grandchild };
		}

		test.each<[string, boolean, (author: MiUser, child: MiNote) => Promise<unknown>]>([
			['NoteDeleteService', false, (author, child) => noteDeleteService.delete(author, child, true)],
			['DeleteAccountProcessorService', true, async author => {
				vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
				await deleteAccountProcessorService.process({ data: { user: { id: author.id } } } as never);
			}],
		])('%s rolls back a deletion of a child that a join links before the deletion locks it, finishes moving the replies to the child and deletes it then', async (_, isDeleted, remove) => {
			const author = await createUser({ host: 'remote.example.com', isDeleted });
			const { parent, parentUri, child, grandchild } = await waitingChild(author, Date.now() - 60_000);

			await linkedBeforeTheLock(child, async () => {
				await expect(failingAt(/^UPDATE "note" SET "threadId" = \$1 WHERE "id" IN/, () => joinChildrenToParent(db, idService, parent, parentUri, [{ childId: child.id, kind: 0 }]))).rejects.toThrow('interrupted');
			}, () => remove(author, child));

			expect(await notesRepository.existsBy({ id: child.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(parent.id);
			expect(await notePendingParentsRepository.countBy({ childId: child.id })).toBe(0);
		});

		test('DeleteAccountProcessorService rolls back a deletion of a child that a join links before the deletion locks it even when moving the replies to another child of the batch stops at its 8 rounds, finishes moving the replies to the child and deletes it then', async () => {
			const author = await createUser({ host: 'remote.example.com', isDeleted: true });
			const other = await createUser({ host: 'remote.example.com' });
			const time = Date.now() - 60_000;
			const { parent, parentUri, child, grandchild } = await waitingChild(author, time);
			const cappedUri = uniqueUri();
			const cappedParent = await createNote(other, { uri: cappedUri }, time - 4000);
			const capped = await createNote(author, { replyId: cappedParent.id, threadId: cappedParent.id }, time - 3000);
			await notePendingParentsRepository.insert({ parentUri: cappedUri, childId: capped.id, kind: 0 });
			vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
			let replies = 0;
			const replying: EntitySubscriberInterface = {
				beforeQuery: async event => {
					if (!/^SELECT "id", "threadId" FROM "note" WHERE "threadId" = ANY\(\$1\)/.test(event.query) || !event.query.includes(`"id" >= '${prefixOf(capped.id)}'`) || !(event.parameters as MiNote['id'][][])[0].includes(capped.id)) return;
					replies++;
					await createNote(other, { replyId: capped.id, threadId: capped.id }, time - 2000 + replies);
				},
			};
			db.subscribers.push(replying);
			try {
				await linkedBeforeTheLock(child, async () => {
					await expect(failingAt(/^UPDATE "note" SET "threadId" = \$1 WHERE "id" IN/, () => joinChildrenToParent(db, idService, parent, parentUri, [{ childId: child.id, kind: 0 }]))).rejects.toThrow('interrupted');
				}, () => deleteAccountProcessorService.process({ data: { user: { id: author.id } } } as never));
			} finally {
				db.subscribers.splice(db.subscribers.indexOf(replying), 1);
			}

			expect(replies).toBe(8);
			expect(await notesRepository.countBy({ id: In([capped.id, child.id]) })).toBe(0);
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(parent.id);
			expect(await notePendingParentsRepository.countBy({ childId: child.id })).toBe(0);
		});

		test('NoteDeleteService finishes moving the replies to a child that a join links before the deletion locks it, so that a join of the parent moves them on even though the child is gone when the first join goes on', async () => {
			const author = await createUser({ host: 'remote.example.com' });
			const other = await createUser({ host: 'remote.example.com' });
			const time = Date.now() - 60_000;
			const grandparentUri = uniqueUri();
			const grandparent = await createNote(other, { uri: grandparentUri }, time - 1000);
			const { parent, parentUri, child, grandchild } = await waitingChild(author, time);
			await notesRepository.update({ id: parent.id }, { replyId: UNREFERENCEABLE_NOTE_ID });
			await notePendingParentsRepository.insert({ parentUri: grandparentUri, childId: parent.id, kind: 0 });

			await linkedBeforeTheLock(child, async () => {
				await expect(failingAt(/^SELECT "id", "threadId" FROM "note" WHERE "threadId" = ANY\(\$1\)/, () => joinChildrenToParent(db, idService, parent, parentUri, [{ childId: child.id, kind: 0 }]))).rejects.toThrow('interrupted');
			}, () => noteDeleteService.delete(author, child, true));
			await joinChildrenToParent(db, idService, grandparent, grandparentUri, [{ childId: parent.id, kind: 0 }]);
			expect(await rekeyJoinedChildren(db, idService, [{ id: child.id, threadId: parent.id }])).toBe(true);

			expect(await notesRepository.existsBy({ id: child.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).threadId).toBe(grandparent.id);
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(grandparent.id);
		});
	});
});
