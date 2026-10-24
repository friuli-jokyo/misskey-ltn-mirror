/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { CoreModule } from '@/core/CoreModule.js';
import { ClipService } from '@/core/ClipService.js';
import { IdService } from '@/core/IdService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NotePiningService } from '@/core/NotePiningService.js';
import { PollService } from '@/core/PollService.js';
import { QueueService } from '@/core/QueueService.js';
import { ReactionService } from '@/core/ReactionService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { deleteNotesWithDependents, lockNotesInIdOrder } from '@/misc/note-dependents.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { generateNativeUserToken } from '@/misc/token.js';
import { ApiCallService } from '@/server/api/ApiCallService.js';
import { ApiLoggerService } from '@/server/api/ApiLoggerService.js';
import { AuthenticateService } from '@/server/api/AuthenticateService.js';
import { GetterService } from '@/server/api/GetterService.js';
import { RateLimiterService } from '@/server/api/RateLimiterService.js';
import AdminPromoCreate, { meta as adminPromoCreateMeta } from '@/server/api/endpoints/admin/promo/create.js';
import NotesCreate, { meta as notesCreateMeta, paramDef as notesCreateParamDef } from '@/server/api/endpoints/notes/create.js';
import NotesFavoritesCreate, { meta as notesFavoritesCreateMeta } from '@/server/api/endpoints/notes/favorites/create.js';
import NotesPollsVote, { meta as notesPollsVoteMeta } from '@/server/api/endpoints/notes/polls/vote.js';
import NotesReactionsCreate, { meta as notesReactionsCreateMeta, paramDef as notesReactionsCreateParamDef } from '@/server/api/endpoints/notes/reactions/create.js';
import PromoRead, { meta as promoReadMeta } from '@/server/api/endpoints/promo/read.js';
import type { Resolver } from '@/core/activitypub/ApResolverService.js';
import type { ILike, IObject } from '@/core/activitypub/type.js';
import type { MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type {
	MiNote,
	MiUser,
	NoteReactionsRepository,
	NotesRepository,
	PollsRepository,
	PollVotesRepository,
	UserNotePiningsRepository,
	UserProfilesRepository,
	UsersRepository,
} from '@/models/_.js';
import type { QueryRunner } from 'typeorm';

const gatedTables = ['note_reaction', 'poll_vote', 'note_favorite', 'clip_note', 'user_note_pining', 'promo_note', 'promo_read'] as const;

type GatedTable = typeof gatedTables[number];

const gateKey = 7_340_917;

const gatedInsert = new RegExp(`INSERT INTO "(${gatedTables.join('|')})"`);

const noteKeyShare = /FROM "note" WHERE "id" (= \$\d+|IN \(.*\) ORDER BY "id") FOR KEY SHARE/;

const noteUpdate = / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/;

const userKeyShare = /^SELECT 1 FROM "user" WHERE "id" = \$1 FOR KEY SHARE$/;

const userDelete = /^DELETE FROM "user" WHERE /;

type Site = {
	name: string;
	table: GatedTable;
	prepare: () => Promise<{ note: MiNote; create: () => Promise<unknown> }>;
	vanish: (note: MiNote) => Promise<void>;
	missing: (error: unknown) => void;
};

describe('Note dependents creation', () => {
	let app: TestingModule;
	let db: DataSource;
	let idService: IdService;
	let queueService: QueueService;
	let noteCreateService: NoteCreateService;
	let reactionService: ReactionService;
	let pollService: PollService;
	let clipService: ClipService;
	let notePiningService: NotePiningService;
	let apInboxService: ApInboxService;
	let apNoteService: ApNoteService;
	let apPersonService: ApPersonService;
	let getterService: GetterService;
	let authenticateService: AuthenticateService;
	let fastify: FastifyInstance;
	let adminPromoCreate: AdminPromoCreate;
	let notesCreate: NotesCreate;
	let notesFavoritesCreate: NotesFavoritesCreate;
	let notesPollsVote: NotesPollsVote;
	let notesReactionsCreate: NotesReactionsCreate;
	let promoRead: PromoRead;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let pollsRepository: PollsRepository;
	let pollVotesRepository: PollVotesRepository;
	let userNotePiningsRepository: UserNotePiningsRepository;

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createLocalUser(): Promise<MiLocalUser> {
		return await createUser() as MiLocalUser;
	}

	async function createRemoteUser(): Promise<MiRemoteUser> {
		const uri = `https://remote.example.com/users/${secureRndstr(16)}`;
		return await createUser({ host: 'remote.example.com', uri, inbox: `${uri}/inbox`, featured: `${uri}/featured` }) as MiRemoteUser;
	}

	async function createNote(user: MiUser, data: Partial<MiNote> = {}): Promise<MiNote> {
		const id = idService.gen();
		await notesRepository.insert({
			id,
			text: `note_${id}`,
			userId: user.id,
			userHost: user.host,
			uri: user.uri == null ? null : `${user.uri}/notes/${id}`,
			visibility: 'public',
			...data,
		});
		return await notesRepository.findOneByOrFail({ id });
	}

	async function createPollNote(user: MiUser): Promise<MiNote> {
		const note = await createNote(user, { hasPoll: true });
		await pollsRepository.insert({ noteId: note.id, multiple: false, choices: ['a', 'b'], votes: [0, 0], expiresAt: null, noteVisibility: note.visibility, userId: note.userId, userHost: note.userHost, channelId: null });
		return note;
	}

	async function deleteNoteRow(note: MiNote): Promise<void> {
		await db.query('DELETE FROM "note" WHERE "id" = $1', [note.id]);
	}

	async function vanishAfterFetch(note: MiNote): Promise<void> {
		vi.spyOn(getterService, 'getNote').mockResolvedValueOnce(note);
		await deleteNoteRow(note);
	}

	async function countDependents(table: GatedTable, noteId: MiNote['id']): Promise<number> {
		const [{ count }]: { count: number }[] = await db.query(`SELECT count(*)::int AS "count" FROM "${table}" WHERE "noteId" = $1`, [noteId]);
		return count;
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

	function rejection(result: PromiseSettledResult<unknown>): unknown {
		expect(result.status).toBe('rejected');
		return (result as PromiseRejectedResult).reason;
	}

	async function createWhileDeleting(note: MiNote, create: () => Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
		const deleter = db.createQueryRunner();
		await deleter.connect();
		try {
			await deleter.startTransaction('READ COMMITTED');
			expect(await lockNotesInIdOrder(deleter.manager, [note.id], 'UPDATE')).toEqual([note.id]);
			const deleterPid = await backendPid(deleter);

			let result: PromiseSettledResult<unknown> | undefined;
			const creating = Promise.allSettled([create()]).then(([settled]) => result = settled);
			await waitUntil(async () => result != null || await blockedBy(deleterPid, noteKeyShare));
			expect(result).toBeUndefined();

			expect(await deleteNotesWithDependents(deleter.manager, [note.id], { record: true })).toEqual([note.id]);
			await deleter.commitTransaction();

			return await creating;
		} finally {
			if (deleter.isTransactionActive) await deleter.rollbackTransaction();
			await deleter.release();
		}
	}

	async function deleteWhileCreating(note: MiNote, create: () => Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
		const gate = db.createQueryRunner();
		await gate.connect();
		try {
			await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
			const gatePid = await backendPid(gate);
			const creating = Promise.allSettled([create()]).then(([settled]) => settled);
			const creatorPid = await waitUntil(() => blockedPid(gatePid, gatedInsert));

			let deleted: MiNote['id'][] | undefined;
			const deleting = db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [note.id], { record: true })).then(ids => deleted = ids);
			await waitUntil(async () => deleted != null || await blockedBy(creatorPid, noteUpdate));

			await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]);
			expect(await deleting).toEqual([note.id]);

			return await creating;
		} finally {
			await gate.query('SELECT pg_advisory_unlock_all()');
			await gate.release();
		}
	}

	async function createWhileDroppingForeignKeys(create: () => Promise<unknown>): Promise<PromiseSettledResult<unknown>> {
		const dropper = db.createQueryRunner();
		await dropper.connect();
		try {
			await dropper.startTransaction('READ COMMITTED');
			await dropper.query('LOCK TABLE "user" IN EXCLUSIVE MODE');
			const dropperPid = await backendPid(dropper);

			let result: PromiseSettledResult<unknown> | undefined;
			const creating = Promise.allSettled([create()]).then(([settled]) => result = settled);
			await waitUntil(async () => result != null || await blockedBy(dropperPid, userKeyShare));

			await dropper.query('SET LOCAL lock_timeout = \'500ms\'');
			await dropper.query('LOCK TABLE "note" IN ACCESS EXCLUSIVE MODE');
			await dropper.commitTransaction();

			return await creating;
		} finally {
			if (dropper.isTransactionActive) await dropper.rollbackTransaction();
			await dropper.release();
		}
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				GetterService,
				ApiCallService,
				ApiLoggerService,
				AuthenticateService,
				RateLimiterService,
				{ provide: 'ep:admin/promo/create', useClass: AdminPromoCreate },
				{ provide: 'ep:notes/create', useClass: NotesCreate },
				{ provide: 'ep:notes/favorites/create', useClass: NotesFavoritesCreate },
				{ provide: 'ep:notes/polls/vote', useClass: NotesPollsVote },
				{ provide: 'ep:notes/reactions/create', useClass: NotesReactionsCreate },
				{ provide: 'ep:promo/read', useClass: PromoRead },
			],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		idService = app.get(IdService);
		queueService = app.get(QueueService);
		noteCreateService = app.get(NoteCreateService);
		reactionService = app.get(ReactionService);
		pollService = app.get(PollService);
		clipService = app.get(ClipService);
		notePiningService = app.get(NotePiningService);
		apInboxService = app.get(ApInboxService);
		apNoteService = app.get(ApNoteService);
		apPersonService = app.get(ApPersonService);
		getterService = app.get(GetterService);
		authenticateService = app.get(AuthenticateService);
		adminPromoCreate = app.get('ep:admin/promo/create');
		notesCreate = app.get('ep:notes/create');
		notesFavoritesCreate = app.get('ep:notes/favorites/create');
		notesPollsVote = app.get('ep:notes/polls/vote');
		notesReactionsCreate = app.get('ep:notes/reactions/create');
		promoRead = app.get('ep:promo/read');
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		pollsRepository = app.get(DI.pollsRepository);
		pollVotesRepository = app.get(DI.pollVotesRepository);
		userNotePiningsRepository = app.get(DI.userNotePiningsRepository);

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
		await db.query(`
			CREATE OR REPLACE FUNCTION "test_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
			BEGIN
				PERFORM pg_advisory_xact_lock_shared(${gateKey});
				RETURN NEW;
			END $$
		`);
		for (const table of gatedTables) {
			await db.query(`CREATE TRIGGER "test_gate" BEFORE INSERT ON "${table}" FOR EACH ROW EXECUTE FUNCTION "test_gate"()`);
		}

		const apiCallService = app.get(ApiCallService);
		fastify = Fastify();
		fastify.post<{ Body: Record<string, unknown>; Querystring: Record<string, unknown> }>('/notes/create', async (request, reply) => {
			apiCallService.handleRequest({ name: 'notes/create', meta: notesCreateMeta, params: notesCreateParamDef, exec: notesCreate.exec }, request, reply);
			return reply;
		});
		fastify.post<{ Body: Record<string, unknown>; Querystring: Record<string, unknown> }>('/notes/reactions/create', async (request, reply) => {
			apiCallService.handleRequest({ name: 'notes/reactions/create', meta: notesReactionsCreateMeta, params: notesReactionsCreateParamDef, exec: notesReactionsCreate.exec }, request, reply);
			return reply;
		});
		await fastify.ready();
	});

	afterAll(async () => {
		await fastify.close();
		await db.query('DROP FUNCTION IF EXISTS "test_gate"() CASCADE');
		await app.close();
	});

	test('no foreign key refers to note', async () => {
		const constraints: unknown[] = await db.query('SELECT 1 FROM pg_constraint WHERE contype = \'f\' AND confrelid = \'note\'::regclass');
		expect(constraints).toHaveLength(0);
	});

	const sites: Site[] = [
		{
			name: 'ReactionService.create',
			table: 'note_reaction',
			prepare: async () => {
				const note = await createNote(await createRemoteUser());
				const reactor = await createRemoteUser();
				return { note, create: () => reactionService.create(reactor, note, '👍') };
			},
			vanish: deleteNoteRow,
			missing: error => expect(error).toMatchObject({ id: 'a149b3de-783e-433e-9ee6-d2642d817af4' }),
		},
		{
			name: 'notes/reactions/create',
			table: 'note_reaction',
			prepare: async () => {
				const note = await createNote(await createRemoteUser());
				const me = await createLocalUser();
				return { note, create: () => notesReactionsCreate.exec({ noteId: note.id, reaction: '👍' }, me, null) };
			},
			vanish: vanishAfterFetch,
			missing: error => expect(error).toMatchObject({ id: notesReactionsCreateMeta.errors.noSuchNote.id }),
		},
		{
			name: 'PollService.vote',
			table: 'poll_vote',
			prepare: async () => {
				const note = await createPollNote(await createLocalUser());
				const voter = await createRemoteUser();
				return { note, create: () => pollService.vote(voter, note, 0) };
			},
			vanish: deleteNoteRow,
			missing: error => {
				expect(error).toBeInstanceOf(Error);
				expect((error as Error).message).toBe('note not found');
			},
		},
		{
			name: 'notes/polls/vote',
			table: 'poll_vote',
			prepare: async () => {
				const note = await createPollNote(await createLocalUser());
				const me = await createLocalUser();
				vi.spyOn(pollService, 'deliverQuestionUpdate').mockResolvedValue(undefined);
				return { note, create: () => notesPollsVote.exec({ noteId: note.id, choice: 0 }, me, null) };
			},
			vanish: vanishAfterFetch,
			missing: error => expect(error).toMatchObject({ id: notesPollsVoteMeta.errors.noSuchNote.id }),
		},
		{
			name: 'notes/favorites/create',
			table: 'note_favorite',
			prepare: async () => {
				const note = await createNote(await createRemoteUser());
				const me = await createLocalUser();
				return { note, create: () => notesFavoritesCreate.exec({ noteId: note.id }, me, null) };
			},
			vanish: vanishAfterFetch,
			missing: error => expect(error).toMatchObject({ id: notesFavoritesCreateMeta.errors.noSuchNote.id }),
		},
		{
			name: 'ClipService.addNote',
			table: 'clip_note',
			prepare: async () => {
				const note = await createNote(await createRemoteUser());
				const me = await createLocalUser();
				const clip = await clipService.create(me, secureRndstr(8), false, null);
				return { note, create: () => clipService.addNote(me, clip.id, note.id) };
			},
			vanish: deleteNoteRow,
			missing: error => expect(error).toBeInstanceOf(ClipService.NoSuchNoteError),
		},
		{
			name: 'NotePiningService.addPinned',
			table: 'user_note_pining',
			prepare: async () => {
				const user = await createRemoteUser();
				const note = await createNote(user);
				return { note, create: () => notePiningService.addPinned(user, note.id) };
			},
			vanish: async note => {
				vi.spyOn(notesRepository, 'findOneBy').mockResolvedValueOnce(note);
				await deleteNoteRow(note);
			},
			missing: error => expect(error).toMatchObject({ id: '70c4e51f-5bea-449c-a030-53bee3cce202' }),
		},
		{
			name: 'admin/promo/create',
			table: 'promo_note',
			prepare: async () => {
				const note = await createNote(await createLocalUser());
				const me = await createLocalUser();
				return { note, create: () => adminPromoCreate.exec({ noteId: note.id, expiresAt: Date.now() + 1000 * 60 * 60 }, me, null) };
			},
			vanish: vanishAfterFetch,
			missing: error => expect(error).toMatchObject({ id: adminPromoCreateMeta.errors.noSuchNote.id }),
		},
		{
			name: 'promo/read',
			table: 'promo_read',
			prepare: async () => {
				const note = await createNote(await createLocalUser());
				const me = await createLocalUser();
				return { note, create: () => promoRead.exec({ noteId: note.id }, me, null) };
			},
			vanish: vanishAfterFetch,
			missing: error => expect(error).toMatchObject({ id: promoReadMeta.errors.noSuchNote.id }),
		},
	];

	describe.each(sites)('$name', site => {
		test('creates the row for a note that exists', async () => {
			const { note, create } = await site.prepare();

			await create();

			expect(await countDependents(site.table, note.id)).toBe(1);
		});

		test('creates nothing for a note that is gone after it was fetched', async () => {
			const { note, create } = await site.prepare();
			await site.vanish(note);

			const [result] = await Promise.allSettled([create()]);

			site.missing(rejection(result));
			expect(await countDependents(site.table, note.id)).toBe(0);
		});

		test('waits for a deleter holding the note and then creates nothing', async () => {
			const { note, create } = await site.prepare();

			const result = await createWhileDeleting(note, create);

			site.missing(rejection(result));
			expect(await countDependents(site.table, note.id)).toBe(0);
		});

		test('makes a deleter wait until the row is committed, so the deleter removes it', async () => {
			const { note, create } = await site.prepare();

			const result = await deleteWhileCreating(note, create);

			expect(result.status).toBe('fulfilled');
			expect(await notesRepository.existsBy({ id: note.id })).toBe(false);
			expect(await countDependents(site.table, note.id)).toBe(0);
		});

		test('holds nothing on its own table while it waits for the note, so a switch that drops the foreign keys is not deadlocked', async () => {
			const { note, create } = await site.prepare();
			const switcher = db.createQueryRunner();
			await switcher.connect();
			try {
				await switcher.startTransaction('READ COMMITTED');
				await switcher.query('LOCK TABLE "note" IN EXCLUSIVE MODE');
				const switcherPid = await backendPid(switcher);

				let result: PromiseSettledResult<unknown> | undefined;
				const creating = Promise.allSettled([create()]).then(([settled]) => result = settled);
				await waitUntil(async () => result != null || await blockedBy(switcherPid, noteKeyShare));
				expect(result).toBeUndefined();

				await switcher.query('SET LOCAL lock_timeout = \'500ms\'');
				await switcher.query(`LOCK TABLE "${site.table}" IN ACCESS EXCLUSIVE MODE`);
				await switcher.commitTransaction();

				expect((await creating).status).toBe('fulfilled');
			} finally {
				if (switcher.isTransactionActive) await switcher.rollbackTransaction();
				await switcher.release();
			}
			expect(await countDependents(site.table, note.id)).toBe(1);
		});

		test('takes the user before the note, so a job that drops the outward foreign keys is not deadlocked', async () => {
			const { note, create } = await site.prepare();

			const result = await createWhileDroppingForeignKeys(create);

			expect(result.status).toBe('fulfilled');
			expect(await countDependents(site.table, note.id)).toBe(1);
		});
	});

	describe('ReactionService', () => {
		test('replaces a different reaction', async () => {
			const note = await createNote(await createRemoteUser());
			const reactor = await createRemoteUser();
			await reactionService.create(reactor, note, '👍');

			await reactionService.create(reactor, note, '🎉');

			expect((await noteReactionsRepository.findBy({ noteId: note.id })).map(reaction => reaction.reaction)).toEqual(['🎉']);
		});

		test('refuses the same reaction twice', async () => {
			const note = await createNote(await createRemoteUser());
			const reactor = await createRemoteUser();
			await reactionService.create(reactor, note, '👍');

			await expect(reactionService.create(reactor, note, '👍')).rejects.toMatchObject({ id: '51c42bb4-931a-456b-bff7-e5a8a70dd298' });
			expect(await countDependents('note_reaction', note.id)).toBe(1);
		});

		test('replaces nothing when the note is gone during the replacement', async () => {
			const note = await createNote(await createRemoteUser());
			const reactor = await createRemoteUser();
			await reactionService.create(reactor, note, '👍');
			const original = reactionService.delete;
			vi.spyOn(reactionService, 'delete').mockImplementation(async (user, target) => {
				await original(user, target);
				await deleteNoteRow(target);
			});

			await expect(reactionService.create(reactor, note, '🎉')).rejects.toMatchObject({ id: 'a149b3de-783e-433e-9ee6-d2642d817af4' });
			expect(await countDependents('note_reaction', note.id)).toBe(0);
		});

		function noSuchReactor(error: unknown): void {
			expect(error).toMatchObject({ id: 'cc7e1130-6bf7-4105-adeb-25f799da854f' });
		}

		test('creates nothing for a reactor that is gone', async () => {
			const note = await createNote(await createRemoteUser());
			const reactor = await createRemoteUser();
			await usersRepository.delete(reactor.id);

			const [result] = await Promise.allSettled([reactionService.create(reactor, note, '👍')]);

			noSuchReactor(rejection(result));
			expect(await countDependents('note_reaction', note.id)).toBe(0);
		});

		test('waits for a deleter holding the reactor and then creates nothing', async () => {
			const note = await createNote(await createRemoteUser());
			const reactor = await createRemoteUser();
			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				await deleter.query('DELETE FROM "user" WHERE "id" = $1', [reactor.id]);
				const deleterPid = await backendPid(deleter);

				let result: PromiseSettledResult<unknown> | undefined;
				const creating = Promise.allSettled([reactionService.create(reactor, note, '👍')]).then(([settled]) => result = settled);
				await waitUntil(async () => result != null || await blockedBy(deleterPid, userKeyShare));
				expect(result).toBeUndefined();
				await deleter.commitTransaction();

				noSuchReactor(rejection(await creating));
				expect(await countDependents('note_reaction', note.id)).toBe(0);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}
		});

		test('makes a deleter of the reactor wait until the reaction is committed', async () => {
			const note = await createNote(await createRemoteUser());
			const reactor = await createRemoteUser();
			const gate = db.createQueryRunner();
			await gate.connect();
			try {
				await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
				const gatePid = await backendPid(gate);
				const creating = reactionService.create(reactor, note, '👍');
				const creatorPid = await waitUntil(() => blockedPid(gatePid, gatedInsert));

				let deleted = false;
				const deleting = usersRepository.delete(reactor.id).then(() => deleted = true);
				await waitUntil(async () => deleted || await blockedBy(creatorPid, userDelete));
				expect(deleted).toBe(false);
				await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]);

				await creating;
				await deleting;
				expect(await noteReactionsRepository.existsBy({ noteId: note.id, userId: reactor.id })).toBe(true);
				expect(await usersRepository.existsBy({ id: reactor.id })).toBe(false);
			} finally {
				await gate.query('SELECT pg_advisory_unlock_all()');
				await gate.release();
			}
		});
	});

	describe('NoteCreateService.create', () => {
		test.each<[string, () => Promise<MiUser>]>([
			['local', createLocalUser],
			['remote', createRemoteUser],
		])('waits for a deleter holding a %s parent and then links the reply to the former id', async (_, createParentUser) => {
			const parent = await createNote(await createParentUser());
			if (parent.uri != null) await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parent.uri, parent.id]);
			const replier = await createRemoteUser();
			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(deleter.manager, [parent.id], 'UPDATE')).toEqual([parent.id]);
				const deleterPid = await backendPid(deleter);

				let settled = false;
				const creating = noteCreateService.create(replier, { text: 'reply', reply: parent, uri: `${replier.uri}/notes/${secureRndstr(16)}`, apMentions: [], apHashtags: [], apEmojis: [] }, true).finally(() => settled = true);
				await waitUntil(async () => settled || await blockedBy(deleterPid, noteKeyShare));
				expect(settled).toBe(false);
				expect(await deleteNotesWithDependents(deleter.manager, [parent.id], { record: true })).toEqual([parent.id]);
				await deleter.commitTransaction();

				const reply = await notesRepository.findOneByOrFail({ id: (await creating).id });
				expect(reply.replyId).toBe(parent.id);
				expect(reply.threadId).toBe(parent.id);
				expect(await db.query('SELECT "parentId", "kind" FROM "note_relation" WHERE "childId" = $1', [reply.id])).toEqual([{ parentId: parent.id, kind: 0 }]);
				expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [reply.id])).toEqual([]);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}
		});

		function createNoteOf(author: MiUser, data: Parameters<NoteCreateService['create']>[1] = {}): Promise<MiNote> {
			return noteCreateService.create(author, { text: 'note', uri: author.uri == null ? null : `${author.uri}/notes/${secureRndstr(16)}`, apMentions: [], apHashtags: [], apEmojis: [], ...data }, true);
		}

		function noSuchUser(error: unknown): void {
			expect(error).toMatchObject({ id: 'e3e4eb00-3a45-49d7-bf8d-959a02f5d2eb' });
		}

		test.each<[string, () => Promise<MiUser>]>([
			['local', createLocalUser],
			['remote', createRemoteUser],
		])('creates nothing for a %s author that is gone', async (_, createAuthor) => {
			const author = await createAuthor();
			await usersRepository.delete(author.id);

			const [result] = await Promise.allSettled([createNoteOf(author)]);

			noSuchUser(rejection(result));
			expect(await notesRepository.existsBy({ userId: author.id })).toBe(false);
		});

		test('creates nothing for a note sent anonymously to a user that is gone', async () => {
			const author = await createLocalUser();
			const recipient = await createLocalUser();
			await usersRepository.delete(recipient.id);

			const [result] = await Promise.allSettled([createNoteOf(author, { text: `@${recipient.username} note`, anonymouslySendToUser: recipient })]);

			expect(rejection(result)).toMatchObject({ id: '60142edb-1519-408e-926d-4f108d27bee0' });
			expect(await notesRepository.existsBy({ userId: author.id })).toBe(false);
		});

		test('waits for a deleter holding the author and then creates nothing', async () => {
			const author = await createRemoteUser();
			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				await deleter.query('DELETE FROM "user" WHERE "id" = $1', [author.id]);
				const deleterPid = await backendPid(deleter);

				let result: PromiseSettledResult<MiNote> | undefined;
				const creating = Promise.allSettled([createNoteOf(author)]).then(([settled]) => result = settled);
				await waitUntil(async () => result != null || await blockedBy(deleterPid, userKeyShare));
				expect(result).toBeUndefined();
				await deleter.commitTransaction();

				noSuchUser(rejection(await creating));
				expect(await notesRepository.existsBy({ userId: author.id })).toBe(false);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}
		});

		test('makes a deleter of the author wait until the note is committed', async () => {
			const author = await createRemoteUser();
			const gate = db.createQueryRunner();
			await gate.connect();
			await db.query('CREATE TRIGGER "test_gate" BEFORE INSERT ON "note" FOR EACH ROW EXECUTE FUNCTION "test_gate"()');
			try {
				await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
				const gatePid = await backendPid(gate);
				const creating = createNoteOf(author);
				const creatorPid = await waitUntil(() => blockedPid(gatePid, /^INSERT INTO "note"\(/));

				let deleted = false;
				const deleting = usersRepository.delete(author.id).then(() => deleted = true);
				await waitUntil(async () => deleted || await blockedBy(creatorPid, userDelete));
				expect(deleted).toBe(false);
				await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]);

				const note = await creating;
				await deleting;
				expect(await notesRepository.existsBy({ id: note.id })).toBe(true);
				expect(await usersRepository.existsBy({ id: author.id })).toBe(false);
			} finally {
				await gate.query('SELECT pg_advisory_unlock_all()');
				await gate.release();
				await db.query('DROP TRIGGER IF EXISTS "test_gate" ON "note"');
			}
		});
	});

	describe('notes/create', () => {
		test('answers that there is no such reply target when the user it sends to anonymously is deleted while it posts', async () => {
			const me = await createLocalUser();
			const recipient = await createLocalUser();
			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				await deleter.query('DELETE FROM "user" WHERE "id" = $1', [recipient.id]);
				const deleterPid = await backendPid(deleter);

				let result: PromiseSettledResult<unknown> | undefined;
				const creating = Promise.allSettled([notesCreate.exec({ text: `@${recipient.username} note`, anonymouslySendToUserId: recipient.id }, me, null)]).then(([settled]) => result = settled);
				await waitUntil(async () => result != null || await blockedBy(deleterPid, userKeyShare));
				expect(result).toBeUndefined();
				await deleter.commitTransaction();

				expect(rejection(await creating)).toMatchObject({ id: notesCreateMeta.errors.noSuchReplyTarget.id });
				expect(await notesRepository.existsBy({ userId: me.id })).toBe(false);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}
		});
	});

	describe('ApiCallService', () => {
		async function post(endpoint: string, token: string, payload: Record<string, unknown>): Promise<{ statusCode: number; authenticate: unknown; body: unknown }> {
			const res = await fastify.inject({ method: 'POST', url: `/${endpoint}`, headers: { authorization: `Bearer ${token}` }, payload });
			return { statusCode: res.statusCode, authenticate: res.headers['www-authenticate'], body: res.json() };
		}

		test.each<[string, () => Promise<Record<string, unknown>>]>([
			['notes/create', async () => ({ text: 'note' })],
			['notes/reactions/create', async () => ({ noteId: (await createNote(await createRemoteUser())).id, reaction: '👍' })],
		])('%s answers a cached token whose user is gone as it answers an invalid token', async (endpoint, params) => {
			const token = generateNativeUserToken();
			const me = await createUser({ token });
			expect((await authenticateService.authenticate(token))[0]?.id).toBe(me.id);
			await usersRepository.delete(me.id);
			const payload = await params();

			const answer = await post(endpoint, token, payload);

			expect(answer).toMatchObject({ statusCode: 401, body: { error: { code: 'AUTHENTICATION_FAILED' } } });
			expect(answer).toEqual(await post(endpoint, generateNativeUserToken(), payload));
		});
	});

	describe('ApInboxService.like', () => {
		function like(actor: MiRemoteUser, object: string): ILike {
			return { type: 'Like', id: `${actor.uri}/likes/${secureRndstr(8)}`, actor: actor.uri, object, content: '👍' };
		}

		test('reacts to a note that exists', async () => {
			const uri = `https://remote.example.com/notes/${secureRndstr(16)}`;
			const note = await createNote(await createRemoteUser(), { uri });
			const actor = await createRemoteUser();
			vi.spyOn(apNoteService, 'fetchNote').mockResolvedValueOnce(note);

			expect(await apInboxService.performOneActivity(actor, like(actor, uri))).toBe('ok');
			expect(await countDependents('note_reaction', note.id)).toBe(1);
		});

		test('skips a note that is gone after it was fetched', async () => {
			const uri = `https://remote.example.com/notes/${secureRndstr(16)}`;
			const note = await createNote(await createRemoteUser(), { uri });
			const actor = await createRemoteUser();
			vi.spyOn(apNoteService, 'fetchNote').mockResolvedValueOnce(note);
			await deleteNoteRow(note);

			expect(await apInboxService.performOneActivity(actor, like(actor, uri))).toBe(`skip: target note not found ${uri}`);
			expect(await countDependents('note_reaction', note.id)).toBe(0);
		});
	});

	describe('ClipService', () => {
		test('reports a note added twice', async () => {
			const note = await createNote(await createRemoteUser());
			const me = await createLocalUser();
			const clip = await clipService.create(me, secureRndstr(8), false, null);
			await clipService.addNote(me, clip.id, note.id);

			await expect(clipService.addNote(me, clip.id, note.id)).rejects.toBeInstanceOf(ClipService.AlreadyAddedError);
			expect(await countDependents('clip_note', note.id)).toBe(1);
		});

		test('reports a note that never existed', async () => {
			const me = await createLocalUser();
			const clip = await clipService.create(me, secureRndstr(8), false, null);
			const noteId = idService.gen();

			await expect(clipService.addNote(me, clip.id, noteId)).rejects.toBeInstanceOf(ClipService.NoSuchNoteError);
			expect(await countDependents('clip_note', noteId)).toBe(0);
		});
	});

	describe('notes/polls/vote', () => {
		test('delivers the inserted vote to the owner of a remote poll', async () => {
			const note = await createPollNote(await createRemoteUser());
			const me = await createLocalUser();
			vi.spyOn(pollService, 'deliverQuestionUpdate').mockResolvedValue(undefined);
			const deliver = vi.spyOn(queueService, 'deliver').mockReturnValue(null);

			await notesPollsVote.exec({ noteId: note.id, choice: 1 }, me, null);

			const vote = await pollVotesRepository.findOneByOrFail({ noteId: note.id, userId: me.id });
			expect(vote.choice).toBe(1);
			expect(deliver).toHaveBeenCalledTimes(1);
			expect(deliver.mock.calls[0][1]).toMatchObject({ type: 'Create', object: { id: expect.stringContaining(`#votes/${vote.id}`), name: 'b' } });
		});
	});

	describe('ApPersonService.updateFeatured', () => {
		async function prepareFeatured(count: number): Promise<{ user: MiRemoteUser; notes: MiNote[]; update: () => Promise<void> }> {
			const user = await createRemoteUser();
			const notes: MiNote[] = [];
			for (let i = 0; i < count; i++) {
				notes.push(await createNote(user));
			}
			const resolver = {
				resolveCollection: async () => ({ type: 'OrderedCollection', orderedItems: notes.map(note => ({ id: note.uri, type: 'Note' })) }),
				resolve: async (value: IObject) => value,
			} as unknown as Resolver;
			vi.spyOn(apNoteService, 'resolveNote').mockImplementation(async value => notes.find(note => note.uri === (value as IObject).id) ?? null);
			return { user, notes, update: () => apPersonService.updateFeatured(user.id, resolver) };
		}

		async function pinnedNoteIds(user: MiUser): Promise<MiNote['id'][]> {
			return (await userNotePiningsRepository.find({ where: { userId: user.id }, order: { id: 'DESC' } })).map(pin => pin.noteId);
		}

		test('pins the featured notes in their order, replacing the previous pins', async () => {
			const { user, notes, update } = await prepareFeatured(3);
			const previous = await createNote(user);
			await userNotePiningsRepository.insert({ id: idService.gen(), userId: user.id, noteId: previous.id });

			await update();

			expect(await pinnedNoteIds(user)).toEqual(notes.map(note => note.id));
		});

		test('keeps the previous pins when a pin cannot be inserted', async () => {
			const { user, notes, update } = await prepareFeatured(2);
			const previous = await createNote(user);
			await userNotePiningsRepository.insert({ id: idService.gen(), userId: user.id, noteId: previous.id });
			await db.query(`
				CREATE FUNCTION "test_refuse"() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					IF NEW."noteId" = '${notes[1].id}' THEN
						RAISE EXCEPTION 'refused';
					END IF;
					RETURN NEW;
				END $$
			`);
			await db.query('CREATE TRIGGER "test_refuse" BEFORE INSERT ON "user_note_pining" FOR EACH ROW EXECUTE FUNCTION "test_refuse"()');
			try {
				await expect(update()).rejects.toThrow('refused');
			} finally {
				await db.query('DROP FUNCTION "test_refuse"() CASCADE');
			}

			expect(await pinnedNoteIds(user)).toEqual([previous.id]);
		});

		test('pins a note listed twice once', async () => {
			const { user, notes } = await prepareFeatured(2);
			const resolver = {
				resolveCollection: async () => ({ type: 'OrderedCollection', orderedItems: [notes[0], notes[1], notes[0]].map(note => ({ id: note.uri, type: 'Note' })) }),
				resolve: async (value: IObject) => value,
			} as unknown as Resolver;

			await apPersonService.updateFeatured(user.id, resolver);

			expect(await pinnedNoteIds(user)).toEqual([notes[0].id, notes[1].id]);
		});

		test('skips a featured note that is gone after it was resolved', async () => {
			const { user, notes, update } = await prepareFeatured(3);
			await deleteNoteRow(notes[1]);

			await update();

			expect(await pinnedNoteIds(user)).toEqual([notes[0].id, notes[2].id]);
			expect(await countDependents('user_note_pining', notes[1].id)).toBe(0);
		});

		test('waits for a deleter holding a pinned featured note and then skips it', async () => {
			const { user, notes, update } = await prepareFeatured(2);
			await update();

			const result = await createWhileDeleting(notes[1], update);

			expect(result.status).toBe('fulfilled');
			expect(await pinnedNoteIds(user)).toEqual([notes[0].id]);
			expect(await countDependents('user_note_pining', notes[1].id)).toBe(0);
		});

		test('takes the user before the notes, so a job that drops the outward foreign keys is not deadlocked', async () => {
			const { user, notes, update } = await prepareFeatured(2);

			const result = await createWhileDroppingForeignKeys(update);

			expect(result.status).toBe('fulfilled');
			expect(await pinnedNoteIds(user)).toEqual(notes.map(note => note.id));
		});

		test('makes a deleter wait until the pins are committed, so the deleter removes the pin', async () => {
			const { user, notes, update } = await prepareFeatured(2);

			const result = await deleteWhileCreating(notes[0], update);

			expect(result.status).toBe('fulfilled');
			expect(await notesRepository.existsBy({ id: notes[0].id })).toBe(false);
			expect(await pinnedNoteIds(user)).toEqual([notes[1].id]);
		});
	});
});
