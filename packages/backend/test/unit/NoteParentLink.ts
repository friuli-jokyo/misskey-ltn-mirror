/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource, In } from 'typeorm';
import { CoreModule } from '@/core/CoreModule.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { IdService } from '@/core/IdService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { rekeyJoinedChildren, sweepPendingParents } from '@/misc/join-pending-children.js';
import { nextPrefix, prefixOf } from '@/misc/partition.js';
import { deleteNotesWithDependents, lockNotesInIdOrder, recordDeletedNotes } from '@/misc/note-dependents.js';
import { PartitionMigrationProcessorService } from '@/queue/processors/PartitionMigrationProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { GetterService } from '@/server/api/GetterService.js';
import NotesThreadMutingCreate, { meta as notesThreadMutingCreateMeta } from '@/server/api/endpoints/notes/thread-muting/create.js';
import NotesThreadMutingDelete, { meta as notesThreadMutingDeleteMeta } from '@/server/api/endpoints/notes/thread-muting/delete.js';
import type { Config } from '@/config.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiNote, MiUser, NoteRelationsRepository, NotesRepository, NoteThreadMutingsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { EntityManager, EntitySubscriberInterface, QueryRunner } from 'typeorm';

describe('Note parent link', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let idService: IdService;
	let noteCreateService: NoteCreateService;
	let noteDeleteService: NoteDeleteService;
	let apRendererService: ApRendererService;
	let getterService: GetterService;
	let notesThreadMutingCreate: NotesThreadMutingCreate;
	let notesThreadMutingDelete: NotesThreadMutingDelete;
	let notesRepository: NotesRepository;
	let noteRelationsRepository: NoteRelationsRepository;
	let noteThreadMutingsRepository: NoteThreadMutingsRepository;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let local: MiUser;
	let remote: MiUser;
	let bot: MiUser;
	let seq = 0;

	async function createUser(data: Partial<MiUser>): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.save({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	function uniqueUri(): string {
		return `https://remote.example.com/notes/${secureRndstr(16)}`;
	}

	function baseTime(): number {
		seq += 1;
		return Date.UTC(2024, 0, 1, 0, 0, 0) + seq * 60_000;
	}

	async function create(user: MiUser, data: Parameters<NoteCreateService['create']>[1]): Promise<MiNote> {
		const note = await noteCreateService.create(user, {
			apMentions: [],
			apHashtags: [],
			apEmojis: [],
			uri: uniqueUri(),
			...data,
		}, true);
		return await notesRepository.findOneByOrFail({ id: note.id });
	}

	async function waitFor<T>(check: () => Promise<T | false | undefined>): Promise<T> {
		for (let i = 0; i < 100; i++) {
			const result = await check();
			if (result) return result;
			await setTimeout(50);
		}
		throw new Error('timed out');
	}

	function generating(time: number, ids: MiNote['id'][]): void {
		const gen = idService.gen;
		vi.spyOn(idService, 'gen').mockImplementation((t, immutable) => (t === time && !immutable ? ids.shift() : undefined) ?? gen(t, immutable));
	}

	function clockTickingBetweenTasks(from: number): void {
		let now = from;
		let ticking = false;
		vi.spyOn(Date, 'now').mockImplementation(() => {
			if (!ticking) {
				ticking = true;
				setImmediate(() => {
					ticking = false;
					now++;
				});
			}
			return now;
		});
	}

	async function insertUsersMuting(threadId: string, time: number): Promise<Pick<MiUser, 'id'>[]> {
		const users = Array.from({ length: 1297 }, (_, i) => ({ id: idService.gen(time + i), username: secureRndstr(16) }));
		await usersRepository.insert(users.map(user => ({ ...user, usernameLower: user.username.toLowerCase() })));
		await noteThreadMutingsRepository.insert(users.map((user, i) => ({ id: idService.gen(time + i), userId: user.id, threadId })));
		return users.map(user => ({ id: user.id }));
	}

	function spyOnGenNoteId() {
		const service = noteCreateService as unknown as { genNoteId: (data: unknown, generated: Set<MiNote['id']>) => Promise<MiNote['id']> };
		const genNoteId = service.genNoteId;
		return { genNoteId, spy: vi.spyOn(service, 'genNoteId') };
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

	async function whileHolding<T>(noteIds: MiNote['id'][], change: (manager: EntityManager) => Promise<unknown>, run: () => Promise<T>): Promise<T> {
		const holder = db.createQueryRunner();
		await holder.connect();
		try {
			await holder.startTransaction('READ COMMITTED');
			expect(await lockNotesInIdOrder(holder.manager, noteIds, 'UPDATE')).toEqual([...noteIds].sort());
			await change(holder.manager);
			const holderPid = await backendPid(holder);

			let settled = false;
			const running = run().finally(() => settled = true);
			await waitFor(async () => settled || await blockedBy(holderPid, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR KEY SHARE$/));
			expect(settled).toBe(false);
			await holder.commitTransaction();

			return await running;
		} finally {
			if (holder.isTransactionActive) await holder.rollbackTransaction();
			await holder.release();
		}
	}

	async function moveThread(manager: EntityManager, noteId: MiNote['id'], threadId: string): Promise<void> {
		await manager.query('UPDATE "note" SET "threadId" = $2 WHERE "id" = $1', [noteId, threadId]);
	}

	async function insertReplies(parentId: MiNote['id'], threadIds: string[], time: number): Promise<MiNote[]> {
		const replies: MiNote[] = [];
		for (const [i, threadId] of threadIds.entries()) {
			const id = idService.gen(time + 1000 * (i + 1));
			await notesRepository.insert({ id, text: 'sibling', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: parentId, threadId });
			await noteRelationsRepository.insert({ childId: id, parentId, kind: 0 });
			replies.push(await notesRepository.findOneByOrFail({ id }));
		}
		return replies;
	}

	async function pendingRowsOf(childId: MiNote['id']): Promise<unknown[]> {
		return await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [childId]);
	}

	async function beforeFirstQuery<T>(pattern: RegExp, hook: (runner: QueryRunner) => Promise<unknown>, run: () => Promise<T>, source = db): Promise<T> {
		let fired = false;
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: async event => {
				if (fired || !pattern.test(event.query)) return;
				fired = true;
				await hook(event.queryRunner);
			},
		};
		source.subscribers.push(subscriber);
		try {
			return await run();
		} finally {
			source.subscribers.splice(source.subscribers.indexOf(subscriber), 1);
			expect(fired).toBe(true);
		}
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				PartitionMigrationProcessorService,
				GetterService,
				{ provide: 'ep:notes/thread-muting/create', useClass: NotesThreadMutingCreate },
				{ provide: 'ep:notes/thread-muting/delete', useClass: NotesThreadMutingDelete },
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
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		idService = app.get(IdService);
		noteCreateService = app.get(NoteCreateService);
		noteDeleteService = app.get(NoteDeleteService);
		apRendererService = app.get(ApRendererService);
		getterService = app.get(GetterService);
		notesThreadMutingCreate = app.get('ep:notes/thread-muting/create');
		notesThreadMutingDelete = app.get('ep:notes/thread-muting/delete');
		notesRepository = app.get(DI.notesRepository);
		noteRelationsRepository = app.get(DI.noteRelationsRepository);
		noteThreadMutingsRepository = app.get(DI.noteThreadMutingsRepository);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);

		local = await createUser({});
		remote = await createUser({ host: 'remote.example.com', uri: `https://remote.example.com/users/${secureRndstr(8)}` });
		bot = await createUser({ host: 'bot.example.com', uri: `https://bot.example.com/users/${secureRndstr(8)}`, isBot: true });

		const federatedInstanceService = app.get(FederatedInstanceService);
		await federatedInstanceService.fetchOrRegister('remote.example.com');
		await federatedInstanceService.fetchOrRegister('bot.example.com');
	});

	afterAll(async () => {
		await app.close();
	});

	describe('IdService', () => {
		test('successorWithinTime increments the suffix only', () => {
			expect(idService.successorWithinTime('abcdefgh0z')).toBe('abcdefgh10');
			expect(idService.successorWithinTime('abcdefghzz')).toBeNull();
			expect(idService.lastWithinTime('abcdefgh12')).toBe('abcdefghzz');
			expect(idService.isSameTime('abcdefgh12', 'abcdefghzz')).toBe(true);
			expect(idService.isSameTime('abcdefgh12', 'abcdefgi12')).toBe(false);
		});
	});

	describe('placement', () => {
		test('a child in the same millisecond is placed after the parent and linked', async () => {
			const t = baseTime() + 123;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const child = await create(remote, { createdAt: new Date(t), text: 'child', reply: parent });

			expect(child.id > parent.id).toBe(true);
			expect(idService.isSameTime(child.id, parent.id)).toBe(true);
			expect(child.replyId).toBe(parent.id);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: parent.id, kind: 0 })).toBe(true);
		});

		test('a child earlier than the parent keeps the reply as unreferenceable', async () => {
			const t = baseTime() + 500;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const child = await create(remote, { createdAt: new Date(t - 1000), text: 'child', reply: parent });

			expect(child.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(child.replyUserId).toBe(parent.userId);
			expect(child.threadId).toBeNull();
			expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
			await setTimeout(100);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(0);
		});

		test('a pure renote earlier than the target is kept with an unreferenceable target', async () => {
			const t = baseTime() + 500;
			const target = await create(remote, { createdAt: new Date(t), text: 'target' });
			const renote = await create(bot, { createdAt: new Date(t - 2000), renote: target });

			expect(renote.renoteId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(await noteRelationsRepository.existsBy({ childId: renote.id })).toBe(false);
		});

		test('a local child earlier than the parent records the parent it is not linked to', async () => {
			const t = baseTime() + 500;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const localParent = await create(local, { createdAt: new Date(t), text: 'local parent', uri: null });
			const reply = await create(local, { createdAt: new Date(t - 1000), text: 'reply', reply: parent, uri: null });
			const quote = await create(local, { createdAt: new Date(t - 2000), text: 'quote', reply: parent, renote: parent, uri: null });
			const renote = await create(local, { createdAt: new Date(t - 3000), renote: parent, uri: null });
			const localQuote = await create(local, { createdAt: new Date(t - 4000), text: 'local quote', renote: localParent, uri: null });

			expect([reply.replyId, quote.replyId, quote.renoteId, renote.renoteId, localQuote.renoteId]).toEqual(new Array(5).fill(UNREFERENCEABLE_NOTE_ID));
			expect(await db.query('SELECT "noteId", "replyId", "renoteId", "replyUri", "renoteUri" FROM "note_unlinked_relation" WHERE "noteId" = ANY($1) ORDER BY "noteId"', [[reply.id, quote.id, renote.id, localQuote.id]])).toEqual([
				{ noteId: localQuote.id, replyId: null, renoteId: localParent.id, replyUri: null, renoteUri: `${config.url}/notes/${localParent.id}` },
				{ noteId: renote.id, replyId: null, renoteId: parent.id, replyUri: null, renoteUri: parent.uri },
				{ noteId: quote.id, replyId: parent.id, renoteId: parent.id, replyUri: parent.uri, renoteUri: parent.uri },
				{ noteId: reply.id, replyId: parent.id, renoteId: null, replyUri: parent.uri, renoteUri: null },
			]);
		});

		test('a local child earlier than the parent renders the uri recorded for the parent after the parent is evicted', async () => {
			const t = baseTime() + 500;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const reply = await create(local, { createdAt: new Date(t - 1000), text: 'reply', reply: parent, uri: null });
			const quote = await create(local, { createdAt: new Date(t - 2000), text: 'quote', renote: parent, uri: null });
			const renote = await create(local, { createdAt: new Date(t - 3000), renote: parent, uri: null });
			await db.query('DELETE FROM "note" WHERE "id" = $1', [parent.id]);
			await db.query('DELETE FROM "note_uri" WHERE "noteId" = $1', [parent.id]);

			expect((await apRendererService.renderNote(reply, false)).inReplyTo).toBe(parent.uri);
			const renderedQuote = await apRendererService.renderNote(quote, false);
			expect([renderedQuote.quoteUrl, renderedQuote._misskey_quote]).toEqual([parent.uri, parent.uri]);
			const { renoteId, renoteUri } = await apRendererService.getOriginalParentIds(renote);
			expect(renoteId).toBe(parent.id);
			expect(await apRendererService.renderNoteUri(parent.id, renoteUri)).toBe(parent.uri);
		});

		test('a local child earlier than the parent renders the uri recorded for the parent, not the uri of a note that took the id of the evicted parent', async () => {
			const t = baseTime() + 500;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const reply = await create(local, { createdAt: new Date(t - 1000), text: 'reply', reply: parent, uri: null });
			const quote = await create(local, { createdAt: new Date(t - 2000), text: 'quote', renote: parent, uri: null });
			const renote = await create(local, { createdAt: new Date(t - 3000), renote: parent, uri: null });
			await db.query('DELETE FROM "note" WHERE "id" = $1', [parent.id]);
			await db.query('DELETE FROM "note_uri" WHERE "noteId" = $1', [parent.id]);
			const reissuedUri = uniqueUri();
			await notesRepository.insert({ id: parent.id, text: 'another note', userId: remote.id, userHost: remote.host, visibility: 'public', uri: reissuedUri });
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [reissuedUri, parent.id]);

			const expectRecordedUri = async () => {
				expect((await apRendererService.renderNote(reply, false)).inReplyTo).toBe(parent.uri);
				const renderedQuote = await apRendererService.renderNote(quote, false);
				expect([renderedQuote.quoteUrl, renderedQuote._misskey_quote]).toEqual([parent.uri, parent.uri]);
				const { renoteId, renoteUri } = await apRendererService.getOriginalParentIds(renote);
				expect(renoteId).toBe(parent.id);
				expect(await apRendererService.renderNoteUri(parent.id, renoteUri)).toBe(parent.uri);
			};
			await expectRecordedUri();
			await noteDeleteService.delete(remote, await notesRepository.findOneByOrFail({ id: parent.id }), true);
			expect(await db.query('SELECT 1 FROM "deleted_note" WHERE "id" = $1', [parent.id])).toHaveLength(1);
			await expectRecordedUri();
		});

		test('a remote child earlier than the parent records nothing', async () => {
			const t = baseTime() + 500;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const child = await create(remote, { createdAt: new Date(t - 1000), text: 'child', reply: parent });

			expect(child.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(await db.query('SELECT 1 FROM "note_unlinked_relation" WHERE "noteId" = $1', [child.id])).toEqual([]);
		});

		test('a local child linked to its parent records nothing', async () => {
			const t = baseTime() + 500;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const child = await create(local, { createdAt: new Date(t + 1000), text: 'child', reply: parent, renote: parent, uri: null });

			expect([child.replyId, child.renoteId]).toEqual([parent.id, parent.id]);
			expect(await db.query('SELECT 1 FROM "note_unlinked_relation" WHERE "noteId" = $1', [child.id])).toEqual([]);
		});

		test('a child of a deleted parent is linked to the former id', async () => {
			const t = baseTime() + 10;
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			await db.query('DELETE FROM "note" WHERE "id" = $1', [parent.id]);

			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', replyFormerId: parent.id });

			expect(child.replyId).toBe(parent.id);
			expect(child.threadId).toBe(parent.id);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: parent.id, kind: 0 })).toBe(true);
		});
	});

	describe('deleted ids', () => {
		test('a reply in the millisecond of its parent does not take the id of a deleted reply again', async () => {
			const parentId = 'asfi4j75zy';
			const t = idService.parse(parentId).date.getTime();
			await notesRepository.insert({ id: parentId, text: 'parent', userId: remote.id, userHost: remote.host, visibility: 'public' });
			const parent = await notesRepository.findOneByOrFail({ id: parentId });
			generating(t, ['asfi4j75m0', 'asfi4j75m1']);

			const first = await create(remote, { createdAt: new Date(t), text: 'first', reply: parent });
			expect(first.id).toBe('asfi4j75zz');
			expect(first.replyId).toBe(parentId);
			await noteDeleteService.delete(remote, first, true);

			const second = await create(remote, { createdAt: new Date(t), text: 'second', reply: parent });

			expect(second.id).toBe('asfi4j75m1');
			expect(second.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
		});

		test('a reply in the millisecond of its parent is placed after the deleted replies as well as the existing ones', async () => {
			const t = baseTime() + 7;
			const prefix = idService.gen(t, true).slice(0, 8);
			generating(t, [`${prefix}k0`, `${prefix}a0`, `${prefix}a1`, `${prefix}a2`]);
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const kept = await create(remote, { createdAt: new Date(t), text: 'kept', reply: parent });
			const deleted = await create(remote, { createdAt: new Date(t), text: 'deleted', reply: parent });
			await noteDeleteService.delete(remote, deleted, true);

			const next = await create(remote, { createdAt: new Date(t), text: 'next', reply: parent });

			expect([parent.id, kept.id, deleted.id, next.id]).toEqual([`${prefix}k0`, `${prefix}k1`, `${prefix}k2`, `${prefix}k3`]);
			expect(next.replyId).toBe(parent.id);
		});

		test('a note does not take a deleted id generated for it and takes the next one generated', async () => {
			const t = baseTime() + 3;
			const prefix = idService.gen(t, true).slice(0, 8);
			generating(t, [`${prefix}m0`, `${prefix}m0`, `${prefix}m1`]);
			const deleted = await create(remote, { createdAt: new Date(t), text: 'deleted' });
			await noteDeleteService.delete(remote, deleted, true);

			const next = await create(remote, { createdAt: new Date(t), text: 'next' });

			expect(deleted.id).toBe(`${prefix}m0`);
			expect(next.id).toBe(`${prefix}m1`);
		});

		test('a reply whose id generated again falls before its parent in the same millisecond is placed after the parent', async () => {
			const t = baseTime() + 5;
			const prefix = idService.gen(t, true).slice(0, 8);
			generating(t, [`${prefix}m5`, `${prefix}m6`, `${prefix}m6`, `${prefix}m4`]);
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const deleted = await create(remote, { createdAt: new Date(t), text: 'deleted' });
			await noteDeleteService.delete(remote, deleted, true);

			const reply = await create(remote, { createdAt: new Date(t), text: 'reply', reply: parent });

			expect(deleted.id).toBe(`${prefix}m6`);
			expect(reply.id).toBe(`${prefix}m7`);
			expect(reply.replyId).toBe(parent.id);
		});

		test('fails rather than issue a deleted id when nothing else is generated for the time', async () => {
			const t = baseTime() + 9;
			const prefix = idService.gen(t, true).slice(0, 8);
			await recordDeletedNotes(db, [{ id: `${prefix}n0`, uri: null }]);
			generating(t, [`${prefix}n0`, `${prefix}n0`]);

			await expect(create(remote, { createdAt: new Date(t), text: 'note' })).rejects.toThrow('Failed to generate a note id that was not deleted');
			expect(await notesRepository.existsBy({ id: `${prefix}n0` })).toBe(false);
		});

		test('a reply does not take an id that a sibling took and gave up after the id was generated for the reply', async () => {
			const t = baseTime() + 11;
			const prefix = idService.gen(t, true).slice(0, 8);
			generating(t, [`${prefix}k0`, `${prefix}a0`, `${prefix}a1`]);
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const { genNoteId, spy } = spyOnGenNoteId();
			spy.mockImplementationOnce(async (data, generated) => {
				const id = await genNoteId(data, generated);
				await notesRepository.insert({ id, text: 'sibling', userId: remote.id, userHost: remote.host, visibility: 'public' });
				await noteDeleteService.delete(remote, await notesRepository.findOneByOrFail({ id }), true);
				return id;
			});

			const reply = await create(remote, { createdAt: new Date(t), text: 'reply', reply: parent });

			expect(spy).toHaveBeenCalledTimes(2);
			expect(reply.id).toBe(`${prefix}k2`);
			expect(reply.replyId).toBe(parent.id);
			expect(await db.query('SELECT "id" FROM "deleted_note" WHERE "id" = $1', [`${prefix}k1`])).toEqual([{ id: `${prefix}k1` }]);
			expect(await notesRepository.existsBy({ id: `${prefix}k1` })).toBe(false);
		});

		test('a reply that takes the id of a sibling being deleted waits for the deletion and then takes another id', async () => {
			const t = baseTime() + 13;
			const prefix = idService.gen(t, true).slice(0, 8);
			generating(t, [`${prefix}k0`, `${prefix}a0`, `${prefix}a1`]);
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			const sibling = await create(remote, { createdAt: new Date(t), text: 'sibling', reply: parent });
			expect(sibling.id).toBe(`${prefix}k1`);
			spyOnGenNoteId().spy.mockResolvedValueOnce(sibling.id);
			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				expect(await deleteNotesWithDependents(deleter.manager, [sibling.id], { record: true })).toEqual([sibling.id]);
				const deleterPid = await backendPid(deleter);

				let settled = false;
				const creating = create(remote, { createdAt: new Date(t), text: 'reply', reply: parent }).finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(deleterPid, /^INSERT INTO "note"\(/));
				expect(settled).toBe(false);
				await deleter.commitTransaction();

				const reply = await creating;
				expect(reply.id).toBe(`${prefix}k2`);
				expect(reply.replyId).toBe(parent.id);
				expect(await notesRepository.existsBy({ id: sibling.id })).toBe(false);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}
		});

		test('a note whose id is taken by a live note takes the next one generated', async () => {
			const t = baseTime() + 15;
			const prefix = idService.gen(t, true).slice(0, 8);
			generating(t, [`${prefix}p0`, `${prefix}p0`, `${prefix}p1`]);
			const first = await create(remote, { createdAt: new Date(t), text: 'first' });

			const second = await create(remote, { createdAt: new Date(t), text: 'second' });

			expect([first.id, second.id]).toEqual([`${prefix}p0`, `${prefix}p1`]);
			expect((await notesRepository.findOneByOrFail({ id: first.id })).text).toBe('first');
			expect(await db.query('SELECT "noteId" FROM "note_uri" WHERE "uri" = ANY($1) ORDER BY "noteId"', [[first.uri, second.uri]])).toEqual([{ noteId: first.id }, { noteId: second.id }]);
		});

		test('a note whose uri is taken is reported as duplicated', async () => {
			const uri = uniqueUri();
			await create(remote, { createdAt: new Date(baseTime()), text: 'first', uri });

			await expect(create(remote, { createdAt: new Date(baseTime()), text: 'second', uri })).rejects.toMatchObject({ name: 'duplicated' });
			expect(await notesRepository.countBy({ uri })).toBe(1);
		});
	});

	describe('id time', () => {
		test('a note from a time no id can be generated for is refused', async () => {
			const user = await createUser({ host: 'remote.example.com', uri: `https://remote.example.com/users/${secureRndstr(8)}` });

			for (const time of [Date.UTC(1999, 11, 31, 23, 59, 59, 999), Date.UTC(2000, 0, 1), Number.NaN]) {
				await expect(create(user, { createdAt: new Date(time), text: 'note' })).rejects.toMatchObject({ id: 'd450b8a9-48e4-4dab-ae36-f4db763fda7c' });
			}
			expect(await notesRepository.countBy({ userId: user.id })).toBe(0);
		});

		test('a note from the earliest time an id can be generated for takes an id above the unreferenceable id', async () => {
			const note = await create(remote, { createdAt: new Date(Date.UTC(2000, 0, 1) + 1), text: 'note' });

			expect(note.id > UNREFERENCEABLE_NOTE_ID).toBe(true);
			expect(idService.parse(note.id).date.getTime()).toBe(Date.UTC(2000, 0, 1) + 1);
		});
	});

	describe('mentions', () => {
		test('a reply that could not be linked does not notify a mention to a user who muted the thread of the parent', async () => {
			const t = baseTime() + 500;
			const muting = await createUser({});
			const notMuting = await createUser({});
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent' });
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: muting.id, threadId: parent.id });
			const createNotification = vi.spyOn(app.get(NotificationService), 'createNotification').mockReturnValue(undefined);

			const reply = await noteCreateService.create(local, {
				createdAt: new Date(t - 1000),
				text: `@${muting.username} @${notMuting.username} reply`,
				reply: parent,
				localOnly: true,
				apMentions: [muting, notMuting],
				apHashtags: [],
				apEmojis: [],
			}, false);

			expect(reply.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(reply.threadId).toBeNull();
			await vi.waitFor(() => expect(createNotification).toHaveBeenCalledWith(notMuting.id, 'mention', { noteId: reply.id }, local.id), { timeout: 10_000 });
			expect(createNotification.mock.calls.map(([notifieeId]) => notifieeId)).not.toContain(muting.id);
		});
	});

	describe('waiting for a parent', () => {
		test('a child whose parent arrives later is linked when its id is greater', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });

			expect(child.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toHaveLength(1);

			const parent = await create(remote, { createdAt: new Date(t), text: 'parent', uri: parentUri });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0);

			const linked = await notesRepository.findOneByOrFail({ id: child.id });
			expect(linked.replyId).toBe(parent.id);
			expect(linked.threadId).toBe(parent.id);
			expect(linked.replyUserId).toBe(parent.userId);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: parent.id, kind: 0 })).toBe(true);
			expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toHaveLength(0);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(1);
		});

		async function linkedChild(): Promise<{ parent: MiNote; child: MiNote }> {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent', uri: parentUri });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(1);
			return { parent, child };
		}

		test('deleting a child from a copy read before the child was linked takes back the reply that the link counted on the parent', async () => {
			const { parent, child } = await linkedChild();

			await noteDeleteService.delete(remote, child, true);

			expect(child.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(await notesRepository.existsBy({ id: child.id })).toBe(false);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(0);
		});

		test('a deletion of a linked child that deletes nothing takes back nothing from the parent', async () => {
			const { parent, child } = await linkedChild();

			await noteDeleteService.delete(bot, await notesRepository.findOneByOrFail({ id: child.id }), true);

			expect(await notesRepository.existsBy({ id: child.id })).toBe(true);
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(1);
		});

		test('a child whose id is not greater than the late parent stays unreferenceable', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t), text: 'child', unresolvedReplyUri: parentUri });
			const parent = await create(remote, { createdAt: new Date(t + 700), text: 'parent', uri: parentUri });

			await waitFor(async () => (await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).length === 0);

			const kept = await notesRepository.findOneByOrFail({ id: child.id });
			expect(kept.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(kept.replyUserId).toBe(parent.userId);
			expect(kept.threadId).toBeNull();
			expect(await noteRelationsRepository.existsBy({ childId: child.id })).toBe(false);
		});

		test('replies made while waiting move to the thread of the parent when linked', async () => {
			const t = baseTime();
			const rootUri = uniqueUri();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			const grandchild = await create(remote, { createdAt: new Date(t + 6000), text: 'grandchild', reply: child });
			const greatGrandchild = await create(remote, { createdAt: new Date(t + 7000), text: 'great-grandchild', reply: grandchild });

			expect(grandchild.threadId).toBe(child.id);
			expect(greatGrandchild.threadId).toBe(child.id);

			const root = await create(remote, { createdAt: new Date(t), text: 'root', uri: rootUri });
			const parent = await create(remote, { createdAt: new Date(t + 1000), text: 'parent', uri: parentUri, reply: root });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0);

			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(parent.id);
			expect((await notesRepository.findOneByOrFail({ id: child.id })).threadId).toBe(root.id);
			expect((await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId).toBe(root.id);
			expect((await notesRepository.findOneByOrFail({ id: greatGrandchild.id })).threadId).toBe(root.id);
		});

		test('a pure renote waits for its target and is linked with kind 2', async () => {
			const t = baseTime();
			const targetUri = uniqueUri();
			const renote = await create(bot, { createdAt: new Date(t + 5000), unresolvedRenoteUri: targetUri });
			const target = await create(remote, { createdAt: new Date(t), text: 'target', uri: targetUri });

			await waitFor(async () => (await notesRepository.findOneByOrFail({ id: renote.id })).renoteId === target.id);
			expect(await noteRelationsRepository.existsBy({ childId: renote.id, parentId: target.id, kind: 2 })).toBe(true);
			expect((await notesRepository.findOneByOrFail({ id: target.id })).renoteCount).toBe(0);
		});

		test('a local parent uri is not kept as pending', async () => {
			const localUriSpy = vi.spyOn(app.get(UtilityService), 'isSynonymousUriLocal').mockImplementation(uri => new URL(uri).origin === new URL(config.url).origin);
			try {
				const child = await create(remote, { createdAt: new Date(baseTime()), text: 'child', unresolvedReplyUri: new URL(`/notes/${idService.gen()}`, config.url).href });

				expect(child.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
				expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toHaveLength(0);
			} finally {
				localUriSpy.mockRestore();
			}
		});

		test('a parent uri with a fragment is not kept as pending', async () => {
			const child = await create(remote, { createdAt: new Date(baseTime()), text: 'child', unresolvedReplyUri: `${uniqueUri()}#main` });

			expect(child.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toHaveLength(0);
		});

		test('the sweep links a child to a parent that was deleted after arriving', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			const formerId = idService.gen(t);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);

			expect(await sweepPendingParents(db, idService, Date.now() + 10_000)).toBe(true);

			const linked = await notesRepository.findOneByOrFail({ id: child.id });
			expect(linked.replyId).toBe(formerId);
			expect(linked.threadId).toBe(formerId);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: formerId, kind: 0 })).toBe(true);
		});

		test.each([
			{ waitedFor: 'with www.', toWaitedUri: (uri: string) => uri.replace('https://', 'https://www.'), toParentUri: (uri: string) => uri },
			{ waitedFor: 'without www.', toWaitedUri: (uri: string) => uri, toParentUri: (uri: string) => uri.replace('https://', 'https://www.') },
		])('a child waiting for a parent uri $waitedFor is kept under the uri without it and linked to a parent whose uri differs only by www.', async ({ toWaitedUri, toParentUri }) => {
			const t = baseTime();
			const uri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: toWaitedUri(uri) });

			expect(await db.query('SELECT "parentUri" FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toEqual([{ parentUri: uri }]);

			const parent = await create(remote, { createdAt: new Date(t), text: 'parent', uri: toParentUri(uri) });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0);
			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(parent.id);
		});

		test('a child is linked to a parent that arrived under the uri with www. while the child was being created', async () => {
			const t = baseTime();
			const uri = uniqueUri();
			const parentId = idService.gen(t);
			await notesRepository.insert({ id: parentId, text: 'parent', userId: remote.id, userHost: remote.host, visibility: 'public', uri: uri.replace('https://', 'https://www.') });
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [uri.replace('https://', 'https://www.'), parentId]);

			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: uri });

			await waitFor(async () => (await notesRepository.findOneByOrFail({ id: child.id })).replyId === parentId);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId, kind: 0 })).toBe(true);
		});

		test('the sweep links a child to a deleted parent whose uri differs only by www.', async () => {
			const t = baseTime();
			const uri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: uri });
			const formerId = idService.gen(t);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [uri.replace('https://', 'https://www.'), formerId]);

			expect(await sweepPendingParents(db, idService, Date.now() + 10_000)).toBe(true);

			const linked = await notesRepository.findOneByOrFail({ id: child.id });
			expect(linked.replyId).toBe(formerId);
			expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toHaveLength(0);
		});

		test('the sweep links a child to a parent whose uri differs only by www.', async () => {
			const t = baseTime();
			const uri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: uri });
			await setTimeout(300);
			const parentId = idService.gen(t);
			await notesRepository.insert({ id: parentId, text: 'parent', userId: remote.id, userHost: remote.host, visibility: 'public', uri: uri.replace('https://', 'https://www.') });
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [uri.replace('https://', 'https://www.'), parentId]);
			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(UNREFERENCEABLE_NOTE_ID);

			expect(await sweepPendingParents(db, idService, Date.now() + 10_000)).toBe(true);

			const linked = await notesRepository.findOneByOrFail({ id: child.id });
			expect(linked.replyId).toBe(parentId);
			expect(linked.threadId).toBe(parentId);
			expect(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [child.id])).toHaveLength(0);
		});

		test('the sweep links a child to a deleted parent in the thread of a live sibling past a deleted one', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			const threadId = idService.gen(t - 1000);
			const formerId = idService.gen(t);
			const deletedSiblingId = idService.gen(t + 1000);
			const liveSiblingId = idService.gen(t + 2000);
			await notesRepository.insert({ id: liveSiblingId, text: 'live sibling', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: formerId, threadId });
			await noteRelationsRepository.insert([
				{ childId: deletedSiblingId, parentId: formerId, kind: 0 },
				{ childId: liveSiblingId, parentId: formerId, kind: 0 },
			]);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);

			expect(await sweepPendingParents(db, idService, Date.now() + 10_000)).toBe(true);

			const linked = await notesRepository.findOneByOrFail({ id: child.id });
			expect(linked.replyId).toBe(formerId);
			expect(linked.threadId).toBe(threadId);
			expect(await noteRelationsRepository.existsBy({ childId: child.id, parentId: formerId, kind: 0 })).toBe(true);
		});
	});

	describe('thread keys', () => {
		test('a reply made from a copy of a waiting child read before the child was linked takes the thread of the parent', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent', uri: parentUri });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0);

			const reply = await create(remote, { createdAt: new Date(t + 6000), text: 'reply', reply: child });

			expect(reply.replyId).toBe(child.id);
			expect(reply.threadId).toBe(parent.id);
		});

		test('a reply made from a copy of a reply to a waiting child read before the replies were moved takes the thread of the parent', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			const grandchild = await create(remote, { createdAt: new Date(t + 6000), text: 'grandchild', reply: child });
			const parent = await create(remote, { createdAt: new Date(t), text: 'parent', uri: parentUri });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0 && (await notesRepository.findOneByOrFail({ id: grandchild.id })).threadId === parent.id);

			const reply = await create(remote, { createdAt: new Date(t + 7000), text: 'reply', reply: grandchild });

			expect(grandchild.threadId).toBe(child.id);
			expect(reply.threadId).toBe(parent.id);
		});

		test('a reply waits for a transaction that holds its parent and takes the thread the parent has once the transaction commits', async () => {
			const t = baseTime();
			const root = await create(remote, { createdAt: new Date(t), text: 'root' });
			const parent = await create(remote, { createdAt: new Date(t + 1000), text: 'parent' });

			const reply = await whileHolding([parent.id], manager => moveThread(manager, parent.id, root.id), () => create(remote, { createdAt: new Date(t + 2000), text: 'reply', reply: parent }));

			expect(reply.replyId).toBe(parent.id);
			expect(reply.threadId).toBe(root.id);
		});

		test('a reply to a deleted parent waits for a sibling being deleted and takes the thread of the next sibling', async () => {
			const t = baseTime();
			const formerId = idService.gen(t);
			const [first, second] = await insertReplies(formerId, [idService.gen(t - 2000), idService.gen(t - 1000)], t);

			const reply = await whileHolding([first.id], manager => deleteNotesWithDependents(manager, [first.id], { record: true }), () => create(remote, { createdAt: new Date(t + 5000), text: 'reply', replyFormerId: formerId }));

			expect(reply.replyId).toBe(formerId);
			expect(reply.threadId).toBe(second.threadId);
		});

		test('a reply to a deleted parent takes the former id when the only sibling is deleted while it waits', async () => {
			const t = baseTime();
			const formerId = idService.gen(t);
			const [sibling] = await insertReplies(formerId, [idService.gen(t - 1000)], t);

			const reply = await whileHolding([sibling.id], manager => deleteNotesWithDependents(manager, [sibling.id], { record: true }), () => create(remote, { createdAt: new Date(t + 5000), text: 'reply', replyFormerId: formerId }));

			expect(reply.replyId).toBe(formerId);
			expect(reply.threadId).toBe(formerId);
		});

		test('a reply to a deleted parent waits for a transaction that holds a sibling and takes the thread the sibling has once the transaction commits', async () => {
			const t = baseTime();
			const formerId = idService.gen(t);
			const [sibling] = await insertReplies(formerId, [idService.gen(t - 2000)], t);
			const moved = idService.gen(t - 1000);

			const reply = await whileHolding([sibling.id], manager => moveThread(manager, sibling.id, moved), () => create(remote, { createdAt: new Date(t + 5000), text: 'reply', replyFormerId: formerId }));

			expect(reply.threadId).toBe(moved);
		});

		test.each<[string, boolean]>([
			['the former id when no sibling survives', false],
			['the thread of the sibling that survives', true],
		])('a reply whose parent is deleted while it waits for the parent takes %s', async (_, withSibling) => {
			const t = baseTime();
			const root = await create(remote, { createdAt: new Date(t), text: 'root' });
			const parent = await create(remote, { createdAt: new Date(t + 1000), text: 'parent', reply: root });
			const siblings = withSibling ? await insertReplies(parent.id, [idService.gen(t - 1000)], t + 1000) : [];

			const reply = await whileHolding([parent.id], manager => deleteNotesWithDependents(manager, [parent.id], { record: true }), () => create(remote, { createdAt: new Date(t + 5000), text: 'reply', reply: parent }));

			expect(parent.threadId).toBe(root.id);
			expect(reply.replyId).toBe(parent.id);
			expect(reply.threadId).toBe(withSibling ? siblings[0].threadId : parent.id);
		});

		test('a quote replying to a deleted parent locks the siblings and the quoted note one at a time in id order', async () => {
			const t = baseTime();
			const formerId = idService.gen(t);
			const goneId = idService.gen(t + 1000);
			await noteRelationsRepository.insert({ childId: goneId, parentId: formerId, kind: 0 });
			const quoted = await create(remote, { createdAt: new Date(t + 2000), text: 'quoted' });
			const [later] = await insertReplies(formerId, [idService.gen(t - 1000)], t + 2000);
			expect([goneId, quoted.id, later.id]).toEqual([goneId, quoted.id, later.id].sort());

			const holder = db.createQueryRunner();
			await holder.connect();
			try {
				await holder.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(holder.manager, [quoted.id], 'UPDATE')).toEqual([quoted.id]);
				const holderPid = await backendPid(holder);

				let settled = false;
				const creating = create(remote, { createdAt: new Date(t + 5000), text: 'quote', replyFormerId: formerId, renote: quoted }).finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(holderPid, / FOR KEY SHARE$/));
				expect(settled).toBe(false);

				await holder.query('SET LOCAL lock_timeout = \'1s\'');
				expect((await deleteNotesWithDependents(holder.manager, [quoted.id, later.id], { record: true })).sort()).toEqual([quoted.id, later.id]);
				await holder.commitTransaction();

				const quote = await creating;
				expect(quote.replyId).toBe(formerId);
				expect(quote.renoteId).toBe(quoted.id);
				expect(quote.threadId).toBe(formerId);
			} finally {
				if (holder.isTransactionActive) await holder.rollbackTransaction();
				await holder.release();
			}
		});

		test('a reply does not notify the author of its parent who muted the thread the reply is stored in', async () => {
			const t = baseTime();
			const author = await createUser({});
			const mentioned = await createUser({});
			const root = await create(remote, { createdAt: new Date(t), text: 'root' });
			const parent = await create(author, { createdAt: new Date(t + 1000), text: 'parent', uri: null });
			await moveThread(db.manager, parent.id, root.id);
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: author.id, threadId: root.id });
			const createNotification = vi.spyOn(app.get(NotificationService), 'createNotification').mockReturnValue(undefined);

			const reply = await noteCreateService.create(remote, {
				createdAt: new Date(t + 2000),
				text: `@${mentioned.username} reply`,
				reply: parent,
				uri: uniqueUri(),
				apMentions: [mentioned],
				apHashtags: [],
				apEmojis: [],
			}, false);

			expect(reply.threadId).toBe(root.id);
			await vi.waitFor(() => expect(createNotification).toHaveBeenCalledWith(mentioned.id, 'mention', { noteId: reply.id }, remote.id), { timeout: 10_000 });
			expect(createNotification.mock.calls.map(([notifieeId]) => notifieeId)).not.toContain(author.id);
		});
	});

	describe('copies of the renote target', () => {
		test.each<[string, (target: MiNote) => Parameters<NoteCreateService['create']>[1], number]>([
			['quote', target => ({ text: 'quote', renote: target }), 1],
			['pure renote', target => ({ renote: target }), 2],
		])('a %s waits for a transaction that holds its target and copies the authors the target has once the transaction commits', async (_, data, kind) => {
			const t = baseTime();
			const target = await create(remote, { createdAt: new Date(t), text: 'target' });

			const child = await whileHolding([target.id], manager => manager.query(
				'UPDATE "note" SET "replyUserId" = $2, "replyUserHost" = $3, "renoteUserId" = $4, "renoteUserHost" = $5 WHERE "id" = $1',
				[target.id, remote.id, remote.host, bot.id, bot.host],
			), () => create(local, { createdAt: new Date(t + 1000), uri: null, ...data(target) }));

			expect(await noteRelationsRepository.findOneByOrFail({ childId: child.id, kind })).toMatchObject({
				parentId: target.id,
				parentReplyUserId: remote.id,
				parentReplyUserHost: remote.host,
				parentRenoteUserId: bot.id,
				parentRenoteUserHost: bot.host,
			});
		});

		test('a quote made from a copy of a waiting child read before the child was linked copies the author of the parent', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const child = await create(remote, { createdAt: new Date(t + 5000), text: 'child', unresolvedReplyUri: parentUri });
			await create(bot, { createdAt: new Date(t), text: 'parent', uri: parentUri });
			await waitFor(async () => (await pendingRowsOf(child.id)).length === 0);

			const quote = await create(local, { createdAt: new Date(t + 6000), text: 'quote', renote: child, uri: null });

			expect(child.replyUserId).toBeNull();
			expect(await noteRelationsRepository.findOneByOrFail({ childId: quote.id, kind: 1 })).toMatchObject({ parentId: child.id, parentReplyUserId: bot.id, parentReplyUserHost: bot.host });
		});
	});

	describe('thread muting', () => {
		test('muting waits for a transaction that holds the note and mutes the thread the note has once the transaction commits', async () => {
			const t = baseTime();
			const me = await createUser({}) as MiLocalUser;
			const root = await create(remote, { createdAt: new Date(t), text: 'root' });
			const note = await create(remote, { createdAt: new Date(t + 1000), text: 'note' });

			await whileHolding([note.id], manager => moveThread(manager, note.id, root.id), () => notesThreadMutingCreate.exec({ noteId: note.id }, me, null));

			expect((await noteThreadMutingsRepository.findBy({ userId: me.id })).map(muting => muting.threadId)).toEqual([root.id]);
		});

		test('unmuting waits for a transaction that holds the note and unmutes the thread the note has once the transaction commits', async () => {
			const t = baseTime();
			const me = await createUser({}) as MiLocalUser;
			const root = await create(remote, { createdAt: new Date(t), text: 'root' });
			const note = await create(remote, { createdAt: new Date(t + 1000), text: 'note' });
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: me.id, threadId: root.id });

			await whileHolding([note.id], manager => moveThread(manager, note.id, root.id), () => notesThreadMutingDelete.exec({ noteId: note.id }, me, null));

			expect(await noteThreadMutingsRepository.findBy({ userId: me.id })).toEqual([]);
		});

		test('muting a thread that is muted already answers so and keeps the one muting', async () => {
			const me = await createUser({}) as MiLocalUser;
			const note = await create(remote, { createdAt: new Date(baseTime()), text: 'note' });
			await notesThreadMutingCreate.exec({ noteId: note.id }, me, null);

			await expect(notesThreadMutingCreate.exec({ noteId: note.id }, me, null)).rejects.toMatchObject({ id: notesThreadMutingCreateMeta.errors.alreadyMuting.id });

			expect((await noteThreadMutingsRepository.findBy({ userId: me.id })).map(muting => muting.threadId)).toEqual([note.id]);
		});

		test.each<[string, () => NotesThreadMutingCreate | NotesThreadMutingDelete, string, boolean]>([
			['muting', () => notesThreadMutingCreate, notesThreadMutingCreateMeta.errors.noSuchNote.id, false],
			['unmuting', () => notesThreadMutingDelete, notesThreadMutingDeleteMeta.errors.noSuchNote.id, true],
		])('%s a note that is gone after it was fetched answers that there is no such note and leaves the mutings as they were', async (_, endpoint, errorId, muted) => {
			const me = await createUser({}) as MiLocalUser;
			const note = await create(remote, { createdAt: new Date(baseTime()), text: 'note' });
			if (muted) await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: me.id, threadId: note.id });
			vi.spyOn(getterService, 'getNote').mockResolvedValueOnce(note);
			await db.query('DELETE FROM "note" WHERE "id" = $1', [note.id]);

			await expect(endpoint().exec({ noteId: note.id }, me, null)).rejects.toMatchObject({ id: errorId });

			expect((await noteThreadMutingsRepository.findBy({ userId: me.id })).map(muting => muting.threadId)).toEqual(muted ? [note.id] : []);
		});
	});

	describe('joining waiting children', () => {
		const searching = /^SELECT "id", "threadId" FROM "note" WHERE "threadId" = ANY\(\$1\)/;
		const moving = /^UPDATE "note" SET "threadId" = \$1 WHERE "id" IN/;

		async function insertNote(time: number, data: Partial<MiNote> = {}): Promise<MiNote> {
			const id = idService.gen(time);
			await notesRepository.insert({ id, text: 'note', userId: remote.id, userHost: remote.host, visibility: 'public', ...data });
			if (data.uri != null) await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [data.uri, id]);
			if (data.replyId != null && data.replyId !== UNREFERENCEABLE_NOTE_ID) await noteRelationsRepository.insert({ childId: id, parentId: data.replyId, kind: 0 });
			return await notesRepository.findOneByOrFail({ id });
		}

		async function insertWaiting(time: number, parentUri: string, kind: number, data: Partial<MiNote> = {}): Promise<MiNote> {
			const note = await insertNote(time, { ...(kind === 0 ? { replyId: UNREFERENCEABLE_NOTE_ID } : { renoteId: UNREFERENCEABLE_NOTE_ID }), ...data });
			await db.query('INSERT INTO "note_pending_parent" ("parentUri", "childId", "kind") VALUES ($1, $2, $3)', [parentUri, note.id, kind]);
			return note;
		}

		async function joinPendingChildren(parent: MiNote): Promise<void> {
			await (noteCreateService as unknown as { joinPendingChildren: (parent: MiNote) => Promise<void> }).joinPendingChildren(parent);
		}

		async function sweep(): Promise<boolean> {
			return await sweepPendingParents(db, idService, Date.now() + 10_000);
		}

		async function failingAt<T>(pattern: RegExp, run: () => Promise<T>, parameter?: string): Promise<T> {
			const subscriber: EntitySubscriberInterface = {
				beforeQuery: event => {
					if (pattern.test(event.query) && (parameter == null || (event.parameters ?? []).includes(parameter))) throw new Error('interrupted');
				},
			};
			db.subscribers.push(subscriber);
			try {
				return await run();
			} finally {
				db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			}
		}

		async function repliedInEverySearch(child: MiNote, time: number, run: () => Promise<unknown>, onReply: (replies: MiNote[]) => void = () => {}): Promise<MiNote[]> {
			const replies: MiNote[] = [];
			const subscriber: EntitySubscriberInterface = {
				beforeQuery: async event => {
					if (!searching.test(event.query) || !event.query.includes(`"id" >= '${prefixOf(child.id)}'`)) return;
					replies.push(await insertNote(time + replies.length * 1000, { replyId: child.id, threadId: child.id }));
					onReply(replies);
				},
			};
			db.subscribers.push(subscriber);
			try {
				await run();
			} finally {
				db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			}
			return replies;
		}

		async function threadOf(note: MiNote): Promise<string | null> {
			return (await notesRepository.findOneByOrFail({ id: note.id })).threadId;
		}

		async function mutedThreadsOf(user: MiUser): Promise<string[]> {
			return (await noteThreadMutingsRepository.findBy({ userId: user.id })).map(muting => muting.threadId).sort();
		}

		const joins: [string, (parent: MiNote) => Promise<unknown>][] = [
			['joining the parent', parent => joinPendingChildren(parent)],
			['the sweep', () => sweep()],
			['the sweep after the parent is deleted', async parent => {
				await db.query('DELETE FROM "note" WHERE "id" = $1', [parent.id]);
				return await sweep();
			}],
		];

		test.each(joins)('a reply that holds a waiting child while %s links the child takes the thread of the parent once the reply commits', async (_, join) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			let joining: Promise<unknown> = Promise.resolve();

			const reply = await beforeFirstQuery(/^INSERT INTO "note"\(/, async runner => {
				const replyPid = await backendPid(runner);
				let settled = false;
				joining = join(parent).finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(replyPid, / FOR UPDATE$/));
				expect(settled).toBe(false);
			}, () => create(remote, { createdAt: new Date(t + 2000), text: 'reply', reply: child }));
			await joining;

			expect(reply.replyId).toBe(child.id);
			expect(await threadOf(child)).toBe(parent.id);
			expect(await threadOf(reply)).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test.each(joins)('a reply that holds a reply to a waiting child while %s moves the replies to the child is moved too once it commits', async (_, join) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
			let joining: Promise<unknown> = Promise.resolve();

			const reply = await beforeFirstQuery(/^INSERT INTO "note"\(/, async runner => {
				const replyPid = await backendPid(runner);
				let settled = false;
				joining = join(parent).finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(replyPid, / FOR UPDATE$/));
				expect(settled).toBe(false);
			}, () => create(remote, { createdAt: new Date(t + 3000), text: 'reply', reply: grandchild }));
			await joining;

			expect(reply.replyId).toBe(grandchild.id);
			for (const note of [child, grandchild, reply]) {
				expect(await threadOf(note)).toBe(parent.id);
			}
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test.each<[string, string, (parent: MiNote) => Promise<unknown>, RegExp]>([
			['joining the parent', 'before', parent => joinPendingChildren(parent), / FOR (NO KEY )?UPDATE$/],
			['joining the parent', 'after', parent => joinPendingChildren(parent), searching],
			['the sweep', 'before', () => sweep(), / FOR (NO KEY )?UPDATE$/],
			['the sweep', 'after', () => sweep(), searching],
		])('%s that is linked to its own parent %s it links a waiting child to it leaves the child and the replies to the child in the thread of the grandparent', async (_, __, join, pattern) => {
			const t = baseTime();
			const grandparentUri = uniqueUri();
			const parentUri = uniqueUri();
			const grandparent = await insertNote(t, { uri: grandparentUri });
			const parent = await insertNote(t + 1000, { uri: parentUri, replyId: UNREFERENCEABLE_NOTE_ID });
			const child = await insertWaiting(t + 2000, parentUri, 0);
			const grandchild = await insertNote(t + 3000, { replyId: child.id, threadId: child.id });

			await beforeFirstQuery(pattern, async () => {
				await db.query('INSERT INTO "note_pending_parent" ("parentUri", "childId", "kind") VALUES ($1, $2, 0)', [grandparentUri, parent.id]);
				await joinPendingChildren(grandparent);
			}, () => join(parent));

			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(parent.id);
			for (const note of [parent, child, grandchild]) {
				expect(await threadOf(note)).toBe(grandparent.id);
			}
			expect(await pendingRowsOf(parent.id)).toHaveLength(0);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test('moving the replies to a linked reply reads the thread of the reply under a lock, so that it waits for a move of the reply itself and takes the thread the reply is moved to', async () => {
			const t = baseTime();
			const grandparentUri = uniqueUri();
			const parentUri = uniqueUri();
			const grandparent = await insertNote(t, { uri: grandparentUri });
			const parent = await insertWaiting(t + 1000, grandparentUri, 0, { uri: parentUri });
			const child = await insertNote(t + 2000, { replyId: parent.id, threadId: parent.id });
			await db.query('INSERT INTO "note_pending_parent" ("parentUri", "childId", "kind") VALUES ($1, $2, 0)', [parentUri, child.id]);
			const grandchild = await insertNote(t + 3000, { replyId: child.id, threadId: child.id });
			const gates = { child: Promise.withResolvers<void>(), grandchild: Promise.withResolvers<void>() };
			const paused = { child: false, grandchild: false };
			let outerPid = 0;
			const subscriber: EntitySubscriberInterface = {
				afterQuery: async event => {
					if (!moving.test(event.query)) return;
					const movedId = (event.parameters as string[])[2];
					if (movedId === child.id) {
						outerPid = await backendPid(event.queryRunner);
						paused.child = true;
						await gates.child.promise;
					} else if (movedId === grandchild.id) {
						paused.grandchild = true;
						await gates.grandchild.promise;
					}
				},
			};
			db.subscribers.push(subscriber);
			try {
				const outer = joinPendingChildren(grandparent);
				await waitFor(async () => paused.child);
				let settled = false;
				const inner = rekeyJoinedChildren(db, idService, [{ id: child.id, threadId: parent.id }]).finally(() => settled = true);
				await waitFor(async () => settled || paused.grandchild || await blockedBy(outerPid, / FOR KEY SHARE$/));
				expect([settled, paused.grandchild]).toEqual([false, false]);
				gates.child.resolve();
				await waitFor(async () => settled || paused.grandchild);
				await outer;
				gates.grandchild.resolve();
				expect(await inner).toBe(true);
			} finally {
				gates.child.resolve();
				gates.grandchild.resolve();
				db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			}

			for (const note of [parent, child, grandchild]) {
				expect(await threadOf(note)).toBe(grandparent.id);
			}
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test('the sweep that links a child to a deleted parent waits for a transaction that holds the sibling it takes the thread of, and moves the replies to the child to the thread the sibling has once the transaction commits', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const formerId = idService.gen(t);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);
			const [sibling] = await insertReplies(formerId, [idService.gen(t - 2000)], t);
			const child = await insertWaiting(t + 5000, parentUri, 0);
			const grandchild = await insertNote(t + 6000, { replyId: child.id, threadId: child.id });
			const moved = idService.gen(t - 1000);

			expect(await whileHolding([sibling.id], manager => moveThread(manager, sibling.id, moved), () => sweep())).toBe(true);

			expect((await notesRepository.findOneByOrFail({ id: child.id })).replyId).toBe(formerId);
			expect(await threadOf(child)).toBe(moved);
			expect(await threadOf(grandchild)).toBe(moved);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test.each<[string, RegExp, boolean]>([
			['searching for the replies', searching, false],
			['moving the replies', moving, false],
			['finishing the join', /^DELETE FROM "note_pending_parent" WHERE "childId" = ANY/, true],
		])('a join that fails %s after it linked the children keeps the pending rows of the replies, and joining again links and counts nothing twice', async (_, pattern, moved) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const first = await insertWaiting(t + 1000, parentUri, 0);
			const second = await insertWaiting(t + 2000, parentUri, 0);
			const quote = await insertWaiting(t + 3000, parentUri, 1, { userId: local.id, userHost: null, text: 'quote' });
			const grandchild = await insertNote(t + 4000, { replyId: first.id, threadId: first.id });
			const counts = async () => {
				const { repliesCount, renoteCount } = await notesRepository.findOneByOrFail({ id: parent.id });
				return { repliesCount, renoteCount, edges: await noteRelationsRepository.countBy({ parentId: parent.id }) };
			};
			const pending = async () => (await db.query('SELECT "childId" FROM "note_pending_parent" WHERE "childId" = ANY($1) ORDER BY "childId"', [[first.id, second.id, quote.id]]) as { childId: MiNote['id'] }[]).map(row => row.childId);

			await expect(failingAt(pattern, () => joinPendingChildren(parent))).rejects.toThrow('interrupted');

			expect(await counts()).toEqual({ repliesCount: 2, renoteCount: 1, edges: 3 });
			expect(await pending()).toEqual([first.id, second.id]);
			expect(await threadOf(grandchild)).toBe(moved ? parent.id : first.id);

			await joinPendingChildren(parent);

			expect(await counts()).toEqual({ repliesCount: 2, renoteCount: 1, edges: 3 });
			expect(await pending()).toEqual([]);
			expect(await threadOf(grandchild)).toBe(parent.id);
		});

		test('a join keeps the pending row of a linked reply until the replies to the reply are moved, and deletes the pending rows of the other children when it links them', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t + 1000, { uri: parentUri });
			const unlinked = await insertWaiting(t, parentUri, 0);
			const linked = await insertWaiting(t + 2000, parentUri, 0);
			const quote = await insertWaiting(t + 3000, parentUri, 1, { text: 'quote' });
			await insertNote(t + 4000, { replyId: linked.id, threadId: linked.id });
			const pending = async () => (await db.query('SELECT "childId" FROM "note_pending_parent" WHERE "childId" = ANY($1)', [[unlinked.id, linked.id, quote.id]]) as { childId: MiNote['id'] }[]).map(row => row.childId);
			let during: MiNote['id'][] = [];

			await beforeFirstQuery(moving, async () => {
				during = await pending();
			}, () => joinPendingChildren(parent));

			expect(during).toEqual([linked.id]);
			expect(await pending()).toEqual([]);
		});

		test.each(joins.slice(0, 2))('%s copies the authors it fills in for the children into the relations of the renotes and quotes of the children', async (_, join) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri, userId: bot.id, userHost: bot.host });
			const reply = await insertWaiting(t + 1000, parentUri, 0);
			const unlinkedReply = await insertWaiting(t - 1000, parentUri, 0);
			const quote = await insertWaiting(t + 2000, parentUri, 1, { text: 'quote' });
			const renotes: MiNote[] = [];
			for (const [i, target] of [reply, unlinkedReply, quote].entries()) {
				renotes.push(await create(local, { createdAt: new Date(t + 3000 + i * 2000), text: 'quote', renote: target, uri: null }));
				renotes.push(await create(local, { createdAt: new Date(t + 4000 + i * 2000), renote: target, uri: null }));
			}
			const copies = async () => await db.query('SELECT "parentId", "parentReplyUserId", "parentReplyUserHost", "parentRenoteUserId", "parentRenoteUserHost" FROM "note_relation" WHERE "childId" = ANY($1) AND "kind" IN (1, 2) ORDER BY "childId"', [renotes.map(renote => renote.id)]);
			const copiesOf = (targets: MiNote[], copied: { reply: boolean; renote: boolean }) => targets.map(target => ({
				parentId: target.id,
				parentReplyUserId: copied.reply ? bot.id : null,
				parentReplyUserHost: copied.reply ? bot.host : null,
				parentRenoteUserId: copied.renote ? bot.id : null,
				parentRenoteUserHost: copied.renote ? bot.host : null,
			}));
			expect(await copies()).toEqual(copiesOf([reply, reply, unlinkedReply, unlinkedReply, quote, quote], { reply: false, renote: false }));

			await join(parent);

			expect(await copies()).toEqual([
				...copiesOf([reply, reply, unlinkedReply, unlinkedReply], { reply: true, renote: false }),
				...copiesOf([quote, quote], { reply: false, renote: true }),
			]);
		});

		test('a join copies the mutings of the thread of a linked reply to the thread of the parent when it links the reply, and deletes them, with those made meanwhile copied too, once the replies to the reply are moved', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const root = await insertNote(t);
			const parent = await insertNote(t + 1000, { uri: parentUri, replyId: root.id, threadId: root.id });
			const child = await insertWaiting(t + 2000, parentUri, 0);
			const grandchild = await insertNote(t + 3000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			const mutingBoth = await createUser({}) as MiLocalUser;
			const mutingMeanwhile = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);
			await notesThreadMutingCreate.exec({ noteId: grandchild.id }, mutingBoth, null);
			await notesThreadMutingCreate.exec({ noteId: parent.id }, mutingBoth, null);
			let during: string[] = [];

			await beforeFirstQuery(searching, async () => {
				during = await mutedThreadsOf(muting);
				await notesThreadMutingCreate.exec({ noteId: grandchild.id }, mutingMeanwhile, null);
			}, () => joinPendingChildren(parent));

			expect(during).toEqual([child.id, root.id].sort());
			expect(await threadOf(grandchild)).toBe(root.id);
			for (const user of [muting, mutingBoth, mutingMeanwhile]) {
				expect(await mutedThreadsOf(user)).toEqual([root.id]);
			}
		});

		test.each<[string, boolean]>([
			['the parent', false],
			['a parent deleted since', true],
		])('the sweep finishes moving the replies to a reply, with the mutings of its thread, that a join linked to %s and failed to move', async (_, deleteParent) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: grandchild.id }, muting, null);

			await expect(failingAt(moving, () => joinPendingChildren(parent))).rejects.toThrow('interrupted');

			expect(await notesRepository.findOneByOrFail({ id: child.id })).toMatchObject({ replyId: parent.id, threadId: parent.id });
			expect(await threadOf(grandchild)).toBe(child.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(1);
			expect(await mutedThreadsOf(muting)).toEqual([child.id, parent.id].sort());
			if (deleteParent) await db.query('DELETE FROM "note" WHERE "id" = $1', [parent.id]);

			expect(await sweep()).toBe(true);

			expect(await threadOf(grandchild)).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([parent.id]);
			expect(await noteRelationsRepository.countBy({ parentId: parent.id, kind: 0 })).toBe(1);
			if (!deleteParent) expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(1);
		});

		test.each<[string, (notes: { parent: MiNote; child: MiNote; grandchild: MiNote; time: number }) => Promise<MiNote>]>([
			['the reply itself', async ({ child }) => child],
			['a reply to it that is not moved yet', async ({ grandchild }) => grandchild],
			['the parent', async ({ parent }) => parent],
			['a reply made to it after the join', async ({ child, time }) => await create(remote, { createdAt: new Date(time + 3000), text: 'late reply', reply: await notesRepository.findOneByOrFail({ id: child.id }) })],
		])('unmuting from %s while a join that linked a reply has not moved the replies to it finishes moving them first, so that the thread stays unmuted', async (_, target) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);
			await expect(failingAt(moving, () => joinPendingChildren(parent))).rejects.toThrow('interrupted');
			expect(await threadOf(grandchild)).toBe(child.id);
			expect(await mutedThreadsOf(muting)).toEqual([child.id, parent.id].sort());
			const unmuted = await target({ parent, child, grandchild, time: t });

			await notesThreadMutingDelete.exec({ noteId: unmuted.id }, muting, null);

			expect(await threadOf(grandchild)).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([]);
			expect(await sweep()).toBe(true);
			expect(await mutedThreadsOf(muting)).toEqual([]);
		});

		test.each<[string, (child: MiNote, grandchild: MiNote) => MiNote]>([
			['a waiting reply', child => child],
			['a reply to a waiting reply', (_, grandchild) => grandchild],
		])('unmuting from %s that a join links between the lookup of the pending rows and the unmute finishes moving the replies first, so that the thread stays unmuted', async (_, target) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);

			await beforeFirstQuery(/ FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR KEY SHARE$/, async () => {
				await expect(failingAt(moving, () => joinPendingChildren(parent))).rejects.toThrow('interrupted');
			}, () => notesThreadMutingDelete.exec({ noteId: target(child, grandchild).id }, muting, null));

			expect(await threadOf(grandchild)).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([]);
			expect(await sweep()).toBe(true);
			expect(await mutedThreadsOf(muting)).toEqual([]);
		});

		test('unmuting from a reply to a waiting reply waits for a join that holds the waiting reply, and finishes moving the replies once the join commits, so that the thread stays unmuted', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);

			await whileHolding([child.id], async manager => {
				await manager.query('UPDATE "note" SET "replyId" = $2, "threadId" = $2 WHERE "id" = $1', [child.id, parent.id]);
				await manager.query('INSERT INTO "note_relation" ("childId", "parentId", "kind") VALUES ($1, $2, 0)', [child.id, parent.id]);
				await manager.query('INSERT INTO "note_thread_muting" ("id", "userId", "threadId") VALUES ($1, $2, $3)', [idService.gen(), muting.id, parent.id]);
			}, () => notesThreadMutingDelete.exec({ noteId: grandchild.id }, muting, null));

			expect(await threadOf(grandchild)).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([]);
			expect(await sweep()).toBe(true);
			expect(await mutedThreadsOf(muting)).toEqual([]);
		});

		test('unmuting from the root of a thread that a join links a muted waiting reply into between the lock of the unmute and its deletion finishes moving the replies first, so that the thread stays unmuted', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const root = await insertNote(t);
			const parent = await insertNote(t + 1000, { uri: parentUri, replyId: root.id, threadId: root.id });
			const child = await insertWaiting(t + 2000, parentUri, 0);
			const grandchild = await insertNote(t + 3000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);

			await beforeFirstQuery(/^DELETE FROM "note_thread_muting"/, async () => {
				await expect(failingAt(moving, () => joinPendingChildren(parent))).rejects.toThrow('interrupted');
				expect(await mutedThreadsOf(muting)).toEqual([child.id, root.id].sort());
			}, () => notesThreadMutingDelete.exec({ noteId: root.id }, muting, null));

			expect(await threadOf(grandchild)).toBe(root.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([]);
			expect(await sweep()).toBe(true);
			expect(await mutedThreadsOf(muting)).toEqual([]);
		});

		test('unmuting reads no note under its lock but the note and the note its thread is keyed on, so that its transaction locks notes of no other partition however many partitions the waiting replies whose threads the user mutes are in', async () => {
			const t = baseTime();
			const partition = 36 ** 6;
			const root = await insertNote(t);
			const note = await insertNote(t + partition, { replyId: root.id, threadId: root.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: note.id }, muting, null);
			const waiting: MiNote[] = [];
			for (let i = 2; i < 14; i++) {
				const child = await insertWaiting(t + i * partition, uniqueUri(), 0);
				await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);
				waiting.push(child);
			}
			expect(new Set([root, note, ...waiting].map(other => prefixOf(other.id))).size).toBe(14);
			const read = new Map<QueryRunner, Set<string>>();
			const unmutings: QueryRunner[] = [];
			const subscriber: EntitySubscriberInterface = {
				beforeQuery: event => {
					if (/^DELETE FROM "note_thread_muting"/.test(event.query)) unmutings.push(event.queryRunner);
					if (!/"note"/.test(event.query)) return;
					const prefixes = read.get(event.queryRunner) ?? new Set<string>();
					for (const value of (event.parameters ?? []) as unknown[]) {
						if (typeof value === 'string' && value !== UNREFERENCEABLE_NOTE_ID) prefixes.add(prefixOf(value));
					}
					read.set(event.queryRunner, prefixes);
				},
			};
			db.subscribers.push(subscriber);
			try {
				await notesThreadMutingDelete.exec({ noteId: note.id }, muting, null);
			} finally {
				db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			}

			expect(unmutings).toHaveLength(1);
			expect(read.get(unmutings[0])).toEqual(new Set([prefixOf(root.id), prefixOf(note.id)]));
			const outside = new Set([...read].filter(([runner]) => runner !== unmutings[0]).flatMap(([, prefixes]) => [...prefixes]));
			for (const child of waiting) expect(outside.has(prefixOf(child.id))).toBe(true);
			expect(await mutedThreadsOf(muting)).toEqual(waiting.map(child => child.id).sort());
		});

		test('the end of a join copies the mutings of the thread of each linked reply with ids generated for its own muting users only, so that more than 1,296 users muting the threads of the replies do not take one id twice', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const children = [await insertNote(t + 1000, { replyId: parent.id, threadId: parent.id }), await insertNote(t + 2000, { replyId: parent.id, threadId: parent.id })];
			for (const child of children) await db.query('INSERT INTO "note_pending_parent" ("parentUri", "childId", "kind") VALUES ($1, $2, 0)', [parentUri, child.id]);
			const users = Array.from({ length: 1297 }, (_, i) => ({ id: idService.gen(t - 60_000 + i), username: secureRndstr(16) }));
			await usersRepository.insert(users.map(user => ({ ...user, usernameLower: user.username.toLowerCase() })));
			await noteThreadMutingsRepository.insert(users.map((user, i) => ({ id: idService.gen(t - 60_000 + i), userId: user.id, threadId: i === 0 || i === 1296 ? children[0].id : children[1].id })));
			clockTickingBetweenTasks(t - 30_000);

			expect(await rekeyJoinedChildren(db, idService, children.map(child => ({ id: child.id, threadId: parent.id })))).toBe(true);

			const mutings: { userId: string; threadId: string }[] = await db.query('SELECT "userId", "threadId" FROM "note_thread_muting" WHERE "threadId" = ANY($1)', [[parent.id, ...children.map(child => child.id)]]);
			expect(mutings.map(muting => muting.threadId)).toEqual(new Array(1297).fill(parent.id));
			expect(mutings.map(muting => muting.userId).sort()).toEqual(users.map(user => user.id).sort());
			for (const child of children) expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test('the end of a join copies the mutings of the thread of a linked reply in groups of at most 1,296 with ids of a millisecond of their own, so that 1,297 users muting the thread do not take one id twice', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertNote(t + 1000, { replyId: parent.id, threadId: parent.id });
			await db.query('INSERT INTO "note_pending_parent" ("parentUri", "childId", "kind") VALUES ($1, $2, 0)', [parentUri, child.id]);
			const users = await insertUsersMuting(child.id, t - 60_000);
			clockTickingBetweenTasks(t - 30_000);

			expect(await rekeyJoinedChildren(db, idService, [{ id: child.id, threadId: parent.id }])).toBe(true);

			const mutings: { id: string; userId: string; threadId: string }[] = await db.query('SELECT "id", "userId", "threadId" FROM "note_thread_muting" WHERE "threadId" = ANY($1)', [[parent.id, child.id]]);
			expect(mutings.map(muting => muting.threadId)).toEqual(new Array(1297).fill(parent.id));
			expect(mutings.map(muting => muting.userId).sort()).toEqual(users.map(user => user.id).sort());
			expect(Math.max(...[...Map.groupBy(mutings, muting => muting.id.slice(0, 8)).values()].map(group => group.length))).toBeLessThanOrEqual(1296);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test('unmuting while replies keep coming in every search of a linked reply unmutes once the moving stops at its 8 rounds', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);
			await repliedInEverySearch(child, t + 2000, () => joinPendingChildren(parent));
			expect(await pendingRowsOf(child.id)).toHaveLength(1);

			const replies = await repliedInEverySearch(child, t + 20_000, () => notesThreadMutingDelete.exec({ noteId: child.id }, muting, null));

			expect(replies).toHaveLength(8);
			expect(await mutedThreadsOf(muting)).toEqual([child.id]);
		});

		test('deleting a linked reply while replies keep coming in every search of it deletes it once the moving stops at its 8 rounds', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			await repliedInEverySearch(child, t + 2000, () => joinPendingChildren(parent));
			expect(await pendingRowsOf(child.id)).toHaveLength(1);

			const replies = await repliedInEverySearch(child, t + 20_000, () => noteDeleteService.delete(remote, child, true));

			expect(replies).toHaveLength(8);
			expect(await notesRepository.existsBy({ id: child.id })).toBe(false);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test('the sweep that links a reply to a deleted parent copies the mutings of the thread of the reply to the thread it links the reply to, and keeps the pending row of the reply until the replies to the reply are moved', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const formerId = idService.gen(t);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);
			const [sibling] = await insertReplies(formerId, [idService.gen(t - 1000)], t);
			const child = await insertWaiting(t + 2000, parentUri, 0);
			const grandchild = await insertNote(t + 3000, { replyId: child.id, threadId: child.id });
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: grandchild.id }, muting, null);

			await expect(failingAt(moving, () => sweep(), grandchild.id)).rejects.toThrow('interrupted');

			expect(await notesRepository.findOneByOrFail({ id: child.id })).toMatchObject({ replyId: formerId, threadId: sibling.threadId });
			expect(await threadOf(grandchild)).toBe(child.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(1);
			expect(await mutedThreadsOf(muting)).toEqual([child.id, sibling.threadId].sort());

			expect(await sweep()).toBe(true);

			expect(await threadOf(grandchild)).toBe(sibling.threadId);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([sibling.threadId]);
		});

		test.each<[string, boolean]>([
			['the sibling between the children', true],
			['the child below the sibling', false],
		])('the sweep that links children to a deleted parent locks the children and the siblings one at a time in id order, so that a deletion that holds %s is not deadlocked', async (_, holdsSibling) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const formerId = idService.gen(t);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);
			const lower = await insertWaiting(t + 1000, parentUri, 0);
			const [sibling] = await insertReplies(formerId, [idService.gen(t - 1000)], t + 1000);
			const higher = await insertWaiting(t + 3000, parentUri, 0);
			expect([lower.id, sibling.id, higher.id]).toEqual([lower.id, sibling.id, higher.id].sort());
			const deleted = holdsSibling ? [sibling.id, higher.id] : [sibling.id];

			const holder = db.createQueryRunner();
			await holder.connect();
			try {
				await holder.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(holder.manager, [holdsSibling ? sibling.id : lower.id], 'UPDATE')).toHaveLength(1);
				const holderPid = await backendPid(holder);

				let settled = false;
				const sweeping = sweep().finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(holderPid, holdsSibling ? / FOR KEY SHARE$/ : / FOR UPDATE$/));
				expect(settled).toBe(false);

				await holder.query('SET LOCAL lock_timeout = \'1s\'');
				expect((await deleteNotesWithDependents(holder.manager, deleted, { record: true })).sort()).toEqual(deleted);
				await holder.commitTransaction();

				expect(await sweeping).toBe(true);
			} finally {
				if (holder.isTransactionActive) await holder.rollbackTransaction();
				await holder.release();
			}

			for (const child of holdsSibling ? [lower] : [lower, higher]) {
				expect(await notesRepository.findOneByOrFail({ id: child.id })).toMatchObject({ replyId: formerId, threadId: formerId });
			}
		});

		test.each<[string, (formerId: MiNote['id'], parentUri: string, time: number) => Promise<MiNote>]>([
			['the sweep that links a waiting reply to it', async (_, parentUri, time) => {
				const child = await insertWaiting(time, parentUri, 0);
				expect(await sweep()).toBe(true);
				return child;
			}],
			['a reply made to it', (formerId, _, time) => create(remote, { createdAt: new Date(time), text: 'reply', replyFormerId: formerId })],
		])('of the siblings of a deleted parent, %s takes the thread of the first that is live past more than a hundred that are deleted', async (_, reply) => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const formerId = idService.gen(t);
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);
			await noteRelationsRepository.insert(Array.from({ length: 101 }, (__, i) => ({ childId: idService.gen(t + 1 + i), parentId: formerId, kind: 0 })));
			const [sibling] = await insertReplies(formerId, [idService.gen(t - 1000)], t);

			const child = await reply(formerId, parentUri, t + 5000);

			expect(await notesRepository.findOneByOrFail({ id: child.id })).toMatchObject({ replyId: formerId, threadId: sibling.threadId });
		});

		test.each<[string, (muting: MiLocalUser) => Promise<{ held: MiNote; run: () => Promise<unknown>; muted: string }>]>([
			['muting', async muting => {
				const note = await insertNote(baseTime());
				return { held: note, run: () => notesThreadMutingCreate.exec({ noteId: note.id }, muting, null), muted: note.id };
			}],
			['a join that links a reply', async muting => {
				const t = baseTime();
				const parentUri = uniqueUri();
				const parent = await insertNote(t, { uri: parentUri });
				const child = await insertWaiting(t + 1000, parentUri, 0);
				await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);
				return { held: child, run: () => joinPendingChildren(parent), muted: parent.id };
			}],
			['the sweep that links a reply to a deleted parent', async muting => {
				const t = baseTime();
				const parentUri = uniqueUri();
				const formerId = idService.gen(t);
				await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [parentUri, formerId]);
				const child = await insertWaiting(t + 1000, parentUri, 0);
				await notesThreadMutingCreate.exec({ noteId: child.id }, muting, null);
				return { held: child, run: () => sweep(), muted: formerId };
			}],
			['the end of a join that moves the replies to a reply', async muting => {
				const t = baseTime();
				const parentUri = uniqueUri();
				const parent = await insertNote(t, { uri: parentUri });
				const child = await insertWaiting(t + 1000, parentUri, 0);
				const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
				await expect(failingAt(moving, () => joinPendingChildren(parent), grandchild.id)).rejects.toThrow('interrupted');
				await notesThreadMutingCreate.exec({ noteId: grandchild.id }, muting, null);
				return { held: child, run: () => rekeyJoinedChildren(db, idService, [{ id: child.id, threadId: parent.id }]), muted: parent.id };
			}],
		])('%s locks the muting user before the notes, so that a transaction that holds the user and then locks the notes is not deadlocked', async (_, prepare) => {
			const muting = await createUser({}) as MiLocalUser;
			const { held, run, muted } = await prepare(muting);

			const holder = db.createQueryRunner();
			await holder.connect();
			try {
				await holder.startTransaction('READ COMMITTED');
				await holder.query('SELECT 1 FROM "user" WHERE "id" = $1 FOR UPDATE', [muting.id]);
				const holderPid = await backendPid(holder);

				let settled = false;
				const running = run().finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(holderPid, / FROM "user" WHERE .* FOR KEY SHARE$/));
				expect(settled).toBe(false);

				await holder.query('SET LOCAL lock_timeout = \'1s\'');
				expect(await lockNotesInIdOrder(holder.manager, [held.id], 'UPDATE')).toEqual([held.id]);
				await holder.commitTransaction();

				await running;
			} finally {
				if (holder.isTransactionActive) await holder.rollbackTransaction();
				await holder.release();
			}

			expect(await mutedThreadsOf(muting)).toEqual([muted]);
		});

		test('the end of a join keeps the mutings of the thread of a reply when the id it gives a copy of a muting is taken, and leaves the copy to the next sweep', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const grandchild = await insertNote(t + 2000, { replyId: child.id, threadId: child.id });
			await expect(failingAt(moving, () => joinPendingChildren(parent), grandchild.id)).rejects.toThrow('interrupted');
			const muting = await createUser({}) as MiLocalUser;
			await notesThreadMutingCreate.exec({ noteId: grandchild.id }, muting, null);
			const [{ id: takenId }] = await noteThreadMutingsRepository.findBy({ userId: muting.id });
			const gen = idService.gen;
			const spy = vi.spyOn(idService, 'gen').mockImplementation((time, immutable) => (immutable ? gen(time, immutable) : takenId));

			await expect(rekeyJoinedChildren(db, idService, [{ id: child.id, threadId: parent.id }])).rejects.toThrow(/duplicate key value/);
			spy.mockRestore();

			expect(await threadOf(grandchild)).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(1);
			expect(await mutedThreadsOf(muting)).toEqual([child.id]);

			expect(await sweep()).toBe(true);

			expect(await pendingRowsOf(child.id)).toHaveLength(0);
			expect(await mutedThreadsOf(muting)).toEqual([parent.id]);
		});

		test('a join moves the replies to a linked reply in at most 8 rounds of searches and leaves the pending row of the reply to the sweep', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);

			const replies = await repliedInEverySearch(child, t + 2000, () => joinPendingChildren(parent));

			expect(replies).toHaveLength(8);
			for (const reply of replies) {
				expect(await threadOf(reply)).toBe(parent.id);
			}
			expect(await pendingRowsOf(child.id)).toHaveLength(1);

			expect(await sweep()).toBe(true);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test('the sweep stops moving the replies to a linked reply at its deadline and leaves the pending row of the reply to the next sweep', async () => {
			const t = baseTime();
			const parentUri = uniqueUri();
			await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const deadline = Date.now() + 10_000;
			let clock: { mockRestore: () => void } | undefined;

			const replies = await repliedInEverySearch(child, t + 2000, async () => {
				expect(await sweepPendingParents(db, idService, deadline)).toBe(false);
			}, found => {
				if (found.length === 2) clock = vi.spyOn(Date, 'now').mockReturnValue(deadline);
			});
			clock?.mockRestore();

			expect(replies).toHaveLength(2);
			expect(await pendingRowsOf(child.id)).toHaveLength(1);

			expect(await sweep()).toBe(true);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});

		test.each(joins.slice(0, 2))('%s links the children of each partition in a transaction of its own, so that no transaction of the join locks notes of more than two partitions', async (_, join) => {
			const t = baseTime();
			const partition = 36 ** 6;
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const children = [
				await insertWaiting(t + partition, parentUri, 0),
				await insertWaiting(t + 2 * partition, parentUri, 0),
				await insertWaiting(t + 3 * partition, parentUri, 0),
				await insertWaiting(t + 4 * partition, parentUri, 1, { text: 'quote' }),
			];
			await insertNote(t + 5 * partition, { replyId: children[0].id, threadId: children[0].id });
			expect(new Set([parent, ...children].map(note => prefixOf(note.id))).size).toBe(5);
			const locked = new Map<unknown, Set<string>>();
			const subscriber: EntitySubscriberInterface = {
				beforeQuery: event => {
					if (!/^SELECT "id", "threadId", .* FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR /.test(event.query)) return;
					const prefixes = locked.get(event.queryRunner) ?? new Set<string>();
					for (const id of event.parameters as string[]) prefixes.add(prefixOf(id));
					locked.set(event.queryRunner, prefixes);
				},
			};
			db.subscribers.push(subscriber);
			try {
				await join(parent);
			} finally {
				db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			}

			expect(locked.size).toBeGreaterThanOrEqual(3);
			for (const prefixes of locked.values()) {
				expect(prefixes.size).toBeLessThanOrEqual(2);
			}
			expect((await notesRepository.findBy({ id: In(children.map(child => child.id)) })).map(child => child.replyId ?? child.renoteId)).toEqual(new Array(4).fill(parent.id));
			expect((await notesRepository.findOneByOrFail({ id: parent.id })).repliesCount).toBe(3);
		});

		test.each(joins.slice(0, 2))('%s searches the replies to a linked reply up to the partition of the id an hour from now', async (_, join) => {
			const nextPartition = nextPrefix(prefixOf(idService.gen(Date.now(), true)));
			if (nextPartition == null) throw new Error('no partition follows the current one');
			const boundary = idService.parse(`${nextPartition}00000000`).date.getTime();
			const t = baseTime();
			const parentUri = uniqueUri();
			const parent = await insertNote(t, { uri: parentUri });
			const child = await insertWaiting(t + 1000, parentUri, 0);
			const lateId = idService.gen(boundary + seq * 1000, true);
			await notesRepository.insert({ id: lateId, text: 'late', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: child.id, threadId: child.id });
			expect(prefixOf(lateId)).toBe(nextPartition);
			vi.spyOn(Date, 'now').mockReturnValue(boundary - 30 * 60_000);

			await join(parent);

			expect((await notesRepository.findOneByOrFail({ id: lateId })).threadId).toBe(parent.id);
			expect(await pendingRowsOf(child.id)).toHaveLength(0);
		});
	});

	describe('existing inverted relations', () => {
		test('are unlinked with a backup and adjusted counters', async () => {
			const t = baseTime();
			const parentId = idService.gen(t + 500);
			const replyId = idService.gen(t);
			const renoteId = idService.gen(t + 100);
			const botRenoteId = idService.gen(t + 200);
			await notesRepository.insert({ id: parentId, text: 'parent', userId: remote.id, userHost: remote.host, visibility: 'public', repliesCount: 1, renoteCount: 1 });
			await notesRepository.insert({ id: replyId, text: 'reply', userId: bot.id, userHost: bot.host, visibility: 'public', replyId: parentId, replyUserId: remote.id, replyUserHost: remote.host, threadId: parentId });
			const replyToReplyId = idService.gen(t + 1000);
			const replyToReplyToReplyId = idService.gen(t + 2000);
			await notesRepository.insert({ id: replyToReplyId, text: 'reply to reply', userId: remote.id, userHost: remote.host, visibility: 'public', replyId, replyUserId: bot.id, replyUserHost: bot.host, threadId: parentId });
			await notesRepository.insert({ id: replyToReplyToReplyId, text: 'reply to reply to reply', userId: bot.id, userHost: bot.host, visibility: 'public', replyId: replyToReplyId, replyUserId: remote.id, replyUserHost: remote.host, threadId: parentId });
			await notesRepository.insert({ id: renoteId, userId: (await createUser({ host: 'third.example.com' })).id, userHost: 'third.example.com', visibility: 'public', renoteId: parentId, renoteUserId: remote.id, renoteUserHost: remote.host });
			await notesRepository.insert({ id: botRenoteId, userId: bot.id, userHost: bot.host, visibility: 'public', renoteId: parentId, renoteUserId: remote.id, renoteUserHost: remote.host });

			const processor = app.get(PartitionMigrationProcessorService);
			await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'noteInvertedRelationUnlink\'');
			expect(await (processor as unknown as { runNoteInvertedRelationUnlink: (job: unknown, deadline: number) => Promise<boolean> }).runNoteInvertedRelationUnlink({}, Date.now() + 60_000)).toBe(true);

			const reply = await notesRepository.findOneByOrFail({ id: replyId });
			expect(reply.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(reply.threadId).toBeNull();
			expect((await notesRepository.findOneByOrFail({ id: replyToReplyId })).threadId).toBe(replyId);
			expect((await notesRepository.findOneByOrFail({ id: replyToReplyToReplyId })).threadId).toBe(replyId);
			expect((await notesRepository.findOneByOrFail({ id: renoteId })).renoteId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect((await notesRepository.findOneByOrFail({ id: botRenoteId })).renoteId).toBe(UNREFERENCEABLE_NOTE_ID);

			const parent = await notesRepository.findOneByOrFail({ id: parentId });
			expect(parent.repliesCount).toBe(0);
			expect(parent.renoteCount).toBe(0);

			const backup: { noteId: string; replyId: string | null; renoteId: string | null }[] = await db.query('SELECT "noteId", "replyId", "renoteId" FROM "note_unlinked_relation" WHERE "noteId" = ANY($1) ORDER BY "noteId"', [[replyId, renoteId, botRenoteId]]);
			expect(backup).toEqual([
				{ noteId: replyId, replyId: parentId, renoteId: null },
				{ noteId: renoteId, replyId: null, renoteId: parentId },
				{ noteId: botRenoteId, replyId: null, renoteId: parentId },
			].sort((a, b) => (a.noteId < b.noteId ? -1 : 1)));
		});

		test('include a note that refers to itself', async () => {
			const t = baseTime();
			const selfReplyId = idService.gen(t);
			const selfRenoteId = idService.gen(t + 100);
			const childId = idService.gen(t + 200);
			await notesRepository.insert({ id: selfReplyId, text: 'self reply', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: selfReplyId, replyUserId: remote.id, replyUserHost: remote.host, threadId: selfReplyId });
			await notesRepository.insert({ id: selfRenoteId, userId: remote.id, userHost: remote.host, visibility: 'public', renoteId: selfRenoteId, renoteUserId: remote.id, renoteUserHost: remote.host });
			await notesRepository.insert({ id: childId, text: 'child', userId: bot.id, userHost: bot.host, visibility: 'public', replyId: selfReplyId, replyUserId: remote.id, replyUserHost: remote.host, threadId: selfReplyId });

			const processor = app.get(PartitionMigrationProcessorService);
			await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'noteInvertedRelationUnlink\'');
			expect(await (processor as unknown as { runNoteInvertedRelationUnlink: (job: unknown, deadline: number) => Promise<boolean> }).runNoteInvertedRelationUnlink({}, Date.now() + 60_000)).toBe(true);

			const selfReply = await notesRepository.findOneByOrFail({ id: selfReplyId });
			expect(selfReply.replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect(selfReply.threadId).toBeNull();
			expect((await notesRepository.findOneByOrFail({ id: selfRenoteId })).renoteId).toBe(UNREFERENCEABLE_NOTE_ID);
			const child = await notesRepository.findOneByOrFail({ id: childId });
			expect(child.replyId).toBe(selfReplyId);
			expect(child.threadId).toBe(selfReplyId);

			const backup: { noteId: string; replyId: string | null; renoteId: string | null }[] = await db.query('SELECT "noteId", "replyId", "renoteId" FROM "note_unlinked_relation" WHERE "noteId" = ANY($1) ORDER BY "noteId"', [[selfReplyId, selfRenoteId, childId]]);
			expect(backup).toEqual([
				{ noteId: selfReplyId, replyId: selfReplyId, renoteId: null },
				{ noteId: selfRenoteId, replyId: null, renoteId: selfRenoteId },
			]);
		});

		async function unlinkExisting(): Promise<boolean> {
			const processor = app.get(PartitionMigrationProcessorService);
			await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'noteInvertedRelationUnlink\'');
			return await (processor as unknown as { runNoteInvertedRelationUnlink: (job: unknown, deadline: number) => Promise<boolean> }).runNoteInvertedRelationUnlink({}, Date.now() + 60_000);
		}

		async function insertInvertedReply(): Promise<{ parentId: MiNote['id']; childId: MiNote['id'] }> {
			const t = baseTime();
			const parentId = idService.gen(t + 500);
			const childId = idService.gen(t);
			await notesRepository.insert({ id: parentId, text: 'parent', userId: remote.id, userHost: remote.host, visibility: 'public', repliesCount: 1, uri: uniqueUri() });
			await notesRepository.insert({ id: childId, text: 'child', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: parentId, replyUserId: remote.id, replyUserHost: remote.host, threadId: parentId, uri: uniqueUri() });
			return { parentId, childId };
		}

		test('record the uri of each parent, the local url of a local parent and nothing for a parent that is gone', async () => {
			const t = baseTime();
			const remoteParentUri = uniqueUri();
			const remoteParentId = idService.gen(t + 500);
			const localParentId = idService.gen(t + 600);
			const missingParentId = idService.gen(t + 700);
			const localReplyId = idService.gen(t);
			const quoteId = idService.gen(t + 100);
			const renoteId = idService.gen(t + 200);
			await notesRepository.insert({ id: remoteParentId, text: 'remote parent', userId: remote.id, userHost: remote.host, visibility: 'public', uri: remoteParentUri });
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [remoteParentUri, remoteParentId]);
			await notesRepository.insert({ id: localParentId, text: 'local parent', userId: local.id, userHost: null, visibility: 'public' });
			await notesRepository.insert({ id: localReplyId, text: 'local reply', userId: local.id, userHost: null, visibility: 'public', replyId: remoteParentId, replyUserId: remote.id, replyUserHost: remote.host, threadId: remoteParentId });
			await notesRepository.insert({ id: quoteId, text: 'quote', userId: bot.id, userHost: bot.host, visibility: 'public', renoteId: localParentId, renoteUserId: local.id, renoteUserHost: null, uri: uniqueUri() });
			await notesRepository.insert({ id: renoteId, userId: bot.id, userHost: bot.host, visibility: 'public', renoteId: missingParentId, uri: uniqueUri() });

			expect(await unlinkExisting()).toBe(true);

			expect(await db.query('SELECT "noteId", "replyId", "renoteId", "replyUri", "renoteUri" FROM "note_unlinked_relation" WHERE "noteId" = ANY($1) ORDER BY "noteId"', [[localReplyId, quoteId, renoteId]])).toEqual([
				{ noteId: localReplyId, replyId: remoteParentId, renoteId: null, replyUri: remoteParentUri, renoteUri: null },
				{ noteId: quoteId, replyId: null, renoteId: localParentId, replyUri: null, renoteUri: `${config.url}/notes/${localParentId}` },
				{ noteId: renoteId, replyId: null, renoteId: missingParentId, replyUri: null, renoteUri: null },
			]);

			await db.query('DELETE FROM "note" WHERE "id" = $1', [remoteParentId]);
			await db.query('DELETE FROM "note_uri" WHERE "noteId" = $1', [remoteParentId]);
			await notesRepository.insert({ id: remoteParentId, text: 'another note', userId: remote.id, userHost: remote.host, visibility: 'public', uri: uniqueUri() });
			expect((await apRendererService.renderNote(await notesRepository.findOneByOrFail({ id: localReplyId }), false)).inReplyTo).toBe(remoteParentUri);
		});

		test('skip a child that a deletion holding the child deletes meanwhile', async () => {
			const { parentId, childId } = await insertInvertedReply();
			const deleter = db.createQueryRunner();
			await deleter.connect();
			try {
				await deleter.startTransaction('READ COMMITTED');
				expect(await lockNotesInIdOrder(deleter.manager, [childId], 'UPDATE')).toEqual([childId]);
				const deleterPid = await backendPid(deleter);

				const unlinking = unlinkExisting();
				await waitFor(() => blockedBy(deleterPid, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/));

				expect(await deleteNotesWithDependents(deleter.manager, [childId], { record: true })).toEqual([childId]);
				await deleter.commitTransaction();

				expect(await unlinking).toBe(true);
			} finally {
				if (deleter.isTransactionActive) await deleter.rollbackTransaction();
				await deleter.release();
			}

			expect(await db.query('SELECT 1 FROM "note_unlinked_relation" WHERE "noteId" = $1', [childId])).toEqual([]);
			expect((await notesRepository.findOneByOrFail({ id: parentId })).repliesCount).toBe(1);
		});

		test('make a deletion of a child wait until the backup of the child is committed, so that the deletion deletes the backup', async () => {
			const { childId } = await insertInvertedReply();
			const gateKey = 1_792_049_870;
			await db.query(`
				CREATE FUNCTION "test_unlink_gate"() RETURNS trigger LANGUAGE plpgsql AS $$
				BEGIN
					PERFORM pg_advisory_xact_lock_shared(${gateKey});
					RETURN NEW;
				END $$
			`);
			await db.query('CREATE TRIGGER "test_unlink_gate" BEFORE INSERT ON "note_unlinked_relation" FOR EACH ROW EXECUTE FUNCTION "test_unlink_gate"()');
			const gate = db.createQueryRunner();
			await gate.connect();
			try {
				await gate.query('SELECT pg_advisory_lock($1)', [gateKey]);
				const gatePid = await backendPid(gate);
				const unlinking = unlinkExisting();
				const unlinkPid = await waitFor(() => blockedPid(gatePid, /INSERT INTO "note_unlinked_relation"/));

				let deleted: MiNote['id'][] | undefined;
				const deleting = db.transaction('READ COMMITTED', async transactionalEntityManager => await deleteNotesWithDependents(transactionalEntityManager, [childId], { record: true })).then(ids => deleted = ids);
				await waitFor(async () => deleted != null || await blockedBy(unlinkPid, / FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/));
				expect(deleted).toBeUndefined();

				await gate.query('SELECT pg_advisory_unlock($1)', [gateKey]);
				expect(await unlinking).toBe(true);
				expect(await deleting).toEqual([childId]);
			} finally {
				await gate.query('SELECT pg_advisory_unlock_all()');
				await gate.release();
				await db.query('DROP FUNCTION IF EXISTS "test_unlink_gate"() CASCADE');
			}

			expect(await notesRepository.existsBy({ id: childId })).toBe(false);
			expect(await db.query('SELECT 1 FROM "note_unlinked_relation" WHERE "noteId" = $1', [childId])).toEqual([]);
		});

		async function insertInvertedThread(): Promise<{ parentId: MiNote['id']; childId: MiNote['id']; replyIds: MiNote['id'][]; time: number }> {
			const { parentId, childId } = await insertInvertedReply();
			const time = idService.parse(childId).date.getTime();
			const replyIds = [idService.gen(time + 1000), idService.gen(time + 2000)];
			for (const [i, id] of replyIds.entries()) {
				await notesRepository.insert({ id, text: 'reply', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: i === 0 ? childId : replyIds[i - 1], threadId: parentId });
			}
			return { parentId, childId, replyIds, time };
		}

		async function expectThreadOfUnlinked(childId: MiNote['id'], replyIds: MiNote['id'][]): Promise<void> {
			expect((await notesRepository.findOneByOrFail({ id: childId })).threadId).toBeNull();
			for (const id of replyIds) {
				expect((await notesRepository.findOneByOrFail({ id })).threadId).toBe(childId);
			}
		}

		async function waitingWith(statement: RegExp): Promise<boolean> {
			const rows: { query: string }[] = await db.query('SELECT "query" FROM "pg_stat_activity" WHERE "datname" = current_database() AND "wait_event_type" = \'Lock\'');
			return rows.some(row => statement.test(row.query));
		}

		const levels: [string, number][] = [
			['the unlinked reply', 0],
			['a reply to the unlinked reply', 1],
			['a reply to a reply to the unlinked reply', 2],
		];

		test.each(levels)('a reply to %s that holds it when the unlink reaches it makes the unlink wait, and is moved to the thread of the unlinked reply once it commits', async (_, level) => {
			const { childId, replyIds, time } = await insertInvertedThread();
			const target = await notesRepository.findOneByOrFail({ id: [childId, ...replyIds][level] });
			let unlinking: Promise<boolean> = Promise.resolve(false);

			const reply = await beforeFirstQuery(/^INSERT INTO "note"\(/, async () => {
				let settled = false;
				unlinking = unlinkExisting().finally(() => settled = true);
				await waitFor(async () => settled || await waitingWith(/ FOR UPDATE$/));
				expect(settled).toBe(false);
			}, () => create(remote, { createdAt: new Date(time + 3000), text: 'late reply', reply: target }));
			expect(await unlinking).toBe(true);

			expect(reply.replyId).toBe(target.id);
			await expectThreadOfUnlinked(childId, [...replyIds, reply.id]);
		});

		test.each(levels)('a reply to %s made while the unlink holds it waits for the unlink and takes the thread of the unlinked reply', async (_, level) => {
			const { childId, replyIds, time } = await insertInvertedThread();
			const target = await notesRepository.findOneByOrFail({ id: [childId, ...replyIds][level] });
			const replying: Promise<MiNote>[] = [];

			expect(await beforeFirstQuery(/^UPDATE "note" SET "repliesCount" = GREATEST/, async () => {
				let settled = false;
				replying.push(create(remote, { createdAt: new Date(time + 3000), text: 'late reply', reply: target }).finally(() => settled = true));
				await waitFor(async () => settled || await waitingWith(/ FOR KEY SHARE$/));
				expect(settled).toBe(false);
			}, () => unlinkExisting(), dbLong)).toBe(true);
			const [reply] = await Promise.all(replying);

			expect(reply.replyId).toBe(target.id);
			expect(reply.threadId).toBe(childId);
			await expectThreadOfUnlinked(childId, [...replyIds, reply.id]);
		});

		async function mutedThreadsOf(user: MiUser): Promise<string[]> {
			return (await noteThreadMutingsRepository.findBy({ userId: user.id })).map(muting => muting.threadId).sort();
		}

		test('copy the mutings of the thread of an unlinked reply to the thread the reply heads and keep them, and copy none for a reply that had no thread', async () => {
			const { parentId, childId, replyIds } = await insertInvertedThread();
			const unthreaded = await insertInvertedReply();
			await db.query('UPDATE "note" SET "threadId" = NULL WHERE "id" = $1', [unthreaded.childId]);
			const muting = await createUser({});
			const other = await createUser({});
			const otherThreadId = idService.gen();
			await noteThreadMutingsRepository.insert([
				{ id: idService.gen(), userId: muting.id, threadId: parentId },
				{ id: idService.gen(), userId: muting.id, threadId: unthreaded.parentId },
				{ id: idService.gen(), userId: other.id, threadId: otherThreadId },
			]);

			expect(await unlinkExisting()).toBe(true);

			await expectThreadOfUnlinked(childId, replyIds);
			expect((await notesRepository.findOneByOrFail({ id: unthreaded.childId })).threadId).toBeNull();
			expect(await mutedThreadsOf(muting)).toEqual([parentId, childId, unthreaded.parentId].sort());
			expect(await mutedThreadsOf(other)).toEqual([otherThreadId]);
		});

		test('leave the thread keys of the replies to an unlinked reply that had no thread as they are, and move those of a reply that had one in the same batch', async () => {
			const { childId, replyIds } = await insertInvertedThread();
			const unthreaded = await insertInvertedReply();
			await db.query('UPDATE "note" SET "threadId" = NULL WHERE "id" = $1', [unthreaded.childId]);
			const time = idService.parse(unthreaded.childId).date.getTime();
			const keyless = idService.gen(time + 1000);
			const underKeyless = idService.gen(time + 2000);
			const keyed = idService.gen(time + 3000);
			await notesRepository.insert({ id: keyless, text: 'reply without a thread', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: unthreaded.childId, threadId: null });
			await notesRepository.insert({ id: underKeyless, text: 'reply to the reply without a thread', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: keyless, threadId: keyless });
			await notesRepository.insert({ id: keyed, text: 'reply in the thread of the unlinked reply', userId: remote.id, userHost: remote.host, visibility: 'public', replyId: unthreaded.childId, threadId: unthreaded.childId });

			expect(await unlinkExisting()).toBe(true);

			await expectThreadOfUnlinked(childId, replyIds);
			expect((await notesRepository.findOneByOrFail({ id: unthreaded.childId })).replyId).toBe(UNREFERENCEABLE_NOTE_ID);
			expect((await notesRepository.findBy({ id: In([unthreaded.childId, keyless, underKeyless, keyed]) })).map(note => [note.id, note.threadId]).sort()).toEqual([
				[unthreaded.childId, null],
				[keyless, null],
				[underKeyless, keyless],
				[keyed, unthreaded.childId],
			].sort());
		});

		test('lock the users who mute the thread of an unlinked reply before the notes, so that a transaction that holds such a user and then locks the reply is not deadlocked', async () => {
			const { parentId, childId, replyIds } = await insertInvertedThread();
			const muting = await createUser({});
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: muting.id, threadId: parentId });
			const holder = db.createQueryRunner();
			await holder.connect();
			try {
				await holder.startTransaction('READ COMMITTED');
				await holder.query('SELECT 1 FROM "user" WHERE "id" = $1 FOR UPDATE', [muting.id]);
				const holderPid = await backendPid(holder);

				let settled = false;
				const unlinking = unlinkExisting().finally(() => settled = true);
				await waitFor(async () => settled || await blockedBy(holderPid, / FROM "user" WHERE .* FOR KEY SHARE$/));
				expect(settled).toBe(false);

				await holder.query('SET LOCAL lock_timeout = \'1s\'');
				expect(await lockNotesInIdOrder(holder.manager, [childId], 'UPDATE')).toEqual([childId]);
				await holder.commitTransaction();

				expect(await unlinking).toBe(true);
			} finally {
				if (holder.isTransactionActive) await holder.rollbackTransaction();
				await holder.release();
			}

			await expectThreadOfUnlinked(childId, replyIds);
			expect(await mutedThreadsOf(muting)).toEqual([parentId, childId].sort());
		});

		test('retry a batch whose thread is muted by another user between the lock of the muting users and the lock of the notes, so that the muting is copied too', async () => {
			const { parentId, childId, replyIds } = await insertInvertedThread();
			const muting = await createUser({});
			const late = await createUser({});
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: muting.id, threadId: parentId });

			expect(await beforeFirstQuery(/^SELECT "id", "threadId", .* FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR UPDATE$/, async () => {
				await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: late.id, threadId: parentId });
			}, () => unlinkExisting(), dbLong)).toBe(true);

			await expectThreadOfUnlinked(childId, replyIds);
			for (const user of [muting, late]) {
				expect(await mutedThreadsOf(user)).toEqual([parentId, childId].sort());
			}
		});

		test('roll back and retry a batch whose thread is muted through a reply the walk has not locked yet, so that the muting is copied too', async () => {
			const { parentId, childId, replyIds } = await insertInvertedThread();
			const muting = await createUser({});
			const late = await createUser({}) as MiLocalUser;
			await noteThreadMutingsRepository.insert({ id: idService.gen(), userId: muting.id, threadId: parentId });

			expect(await beforeFirstQuery(/^UPDATE "note" AS n SET "threadId" = v\."threadId"/, async () => {
				await notesThreadMutingCreate.exec({ noteId: replyIds[1] }, late, null);
			}, () => unlinkExisting(), dbLong)).toBe(true);

			await expectThreadOfUnlinked(childId, replyIds);
			for (const user of [muting, late]) {
				expect(await mutedThreadsOf(user)).toEqual([parentId, childId].sort());
			}
			expect(await db.query('SELECT 1 FROM "note_unlinked_relation" WHERE "noteId" = $1', [childId])).toHaveLength(1);
		});

		test('copy the mutings of the thread of each unlinked reply with ids generated for its own muting users only, so that more than 1,296 users muting the threads of a batch do not take one id twice', async () => {
			const first = await insertInvertedThread();
			const second = await insertInvertedThread();
			const users = Array.from({ length: 1297 }, (_, i) => ({ id: idService.gen(first.time - 60_000 + i), username: secureRndstr(16) }));
			await usersRepository.insert(users.map(user => ({ ...user, usernameLower: user.username.toLowerCase() })));
			await noteThreadMutingsRepository.insert(users.map((user, i) => ({ id: idService.gen(first.time - 60_000 + i), userId: user.id, threadId: i === 0 || i === 1296 ? first.parentId : second.parentId })));
			await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'noteInvertedRelationUnlink\'');
			await db.query('INSERT INTO "partition_migration_state" ("name", "state") VALUES (\'noteInvertedRelationUnlink\', $1)', [JSON.stringify({ cursor: idService.gen(first.time - 1, true), watermark: idService.gen(Date.now() + 60 * 60_000, true), batchSize: 5000 })]);
			const deadline = Date.now() + 60_000;
			clockTickingBetweenTasks(first.time - 30_000);

			const processor = app.get(PartitionMigrationProcessorService);
			expect(await (processor as unknown as { runNoteInvertedRelationUnlink: (job: unknown, deadline: number) => Promise<boolean> }).runNoteInvertedRelationUnlink({}, deadline)).toBe(true);

			const copied: { userId: string; threadId: string }[] = await db.query('SELECT "userId", "threadId" FROM "note_thread_muting" WHERE "threadId" = ANY($1)', [[first.childId, second.childId]]);
			expect(copied.filter(row => row.threadId === first.childId).map(row => row.userId).sort()).toEqual([users[0].id, users[1296].id]);
			expect(copied.filter(row => row.threadId === second.childId)).toHaveLength(1295);
		});

		test('copy the mutings of the thread of an unlinked reply in groups of at most 1,296 with ids of a millisecond of their own, so that 1,297 users muting the thread do not take one id twice', async () => {
			const { parentId, childId, time } = await insertInvertedThread();
			const users = await insertUsersMuting(parentId, time - 60_000);
			await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'noteInvertedRelationUnlink\'');
			await db.query('INSERT INTO "partition_migration_state" ("name", "state") VALUES (\'noteInvertedRelationUnlink\', $1)', [JSON.stringify({ cursor: idService.gen(time - 1, true), watermark: idService.gen(Date.now() + 60 * 60_000, true), batchSize: 5000 })]);
			const deadline = Date.now() + 60_000;
			clockTickingBetweenTasks(time - 30_000);

			const processor = app.get(PartitionMigrationProcessorService);
			expect(await (processor as unknown as { runNoteInvertedRelationUnlink: (job: unknown, deadline: number) => Promise<boolean> }).runNoteInvertedRelationUnlink({}, deadline)).toBe(true);

			const copies: { id: string; userId: string }[] = await db.query('SELECT "id", "userId" FROM "note_thread_muting" WHERE "threadId" = $1', [childId]);
			expect(copies.map(copy => copy.userId).sort()).toEqual(users.map(user => user.id).sort());
			expect(Math.max(...[...Map.groupBy(copies, copy => copy.id.slice(0, 8)).values()].map(group => group.length))).toBeLessThanOrEqual(1296);
			expect(await noteThreadMutingsRepository.countBy({ threadId: parentId })).toBe(1297);
		});

		test('retry a batch whose unlinked reply moves to another thread between the read of the batch and the lock of the notes, so that the mutings of that thread are copied', async () => {
			const { parentId, childId, replyIds } = await insertInvertedThread();
			const movedThreadId = idService.gen();
			const muting = await createUser({});
			const mutingMoved = await createUser({});
			await noteThreadMutingsRepository.insert([
				{ id: idService.gen(), userId: muting.id, threadId: parentId },
				{ id: idService.gen(), userId: mutingMoved.id, threadId: movedThreadId },
			]);

			expect(await beforeFirstQuery(/^SELECT "id" FROM "user" WHERE "id" = ANY\(\$1\) ORDER BY "id" FOR KEY SHARE$/, async () => {
				await db.query('UPDATE "note" SET "threadId" = $2 WHERE "id" = $1', [childId, movedThreadId]);
			}, () => unlinkExisting(), dbLong)).toBe(true);

			await expectThreadOfUnlinked(childId, replyIds);
			expect(await mutedThreadsOf(muting)).toEqual([parentId]);
			expect(await mutedThreadsOf(mutingMoved)).toEqual([movedThreadId, childId].sort());
		});
	});
});
