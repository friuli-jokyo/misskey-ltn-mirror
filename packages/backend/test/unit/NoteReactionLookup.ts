/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Test } from '@nestjs/testing';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { DI } from '@/di-symbols.js';
import { findNoteReactionById, findUserNoteReactions } from '@/misc/note-reaction-lookup.js';
import { buildSyncFunctionSql, partitionCopyKeyColumns } from '@/misc/partition-copies.js';
import { childTableName, nextPrefix, ordinalToPrefix, prefixOf, prefixToOrdinal } from '@/misc/partition.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import UsersReactions from '@/server/api/endpoints/users/reactions.js';
import type { NoteReactionRange } from '@/misc/note-reaction-lookup.js';
import type { Config } from '@/config.js';
import type { MiMeta, MiNote, MiNoteReaction, MiUser, NoteReactionsRepository, NotesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { NoteReactionLocator1792429514524 } from '../../migration/1792429514524-noteReactionLocator.js';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource, EntityManager, EntitySubscriberInterface } from 'typeorm';

const time2000 = 946684800000;

const prefixSpan = 36 ** 6;

const triggerFunctions = ['note_reaction_sync_to_p', 'note_reaction_sync_to_old', 'note_reaction_locator_insert', 'note_reaction_locator_delete', 'note_reaction_locator_update'];

describe('note reaction lookups without a note id', () => {
	let app: TestingModule;
	let fastify: FastifyInstance;
	let db: DataSource;
	let config: Config;
	let idService: IdService;
	let roleService: RoleService;
	let apResolverService: ApResolverService;
	let usersReactions: UsersReactions;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let base: number;
	let author: MiUser;
	let reactor: MiUser;
	let other: MiUser;
	let lone: MiUser;
	let writer: MiUser;
	const r: MiNoteReaction[] = [];
	const l: MiNoteReaction[] = [];

	function at(ord: number, offset: number): string {
		return idService.gen(time2000 + ord * prefixSpan + 1000 + offset);
	}

	async function createUser(id: string): Promise<MiUser> {
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase() });
		await userProfilesRepository.insert({ userId: id, publicReactions: true });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createNote(id: string, visibility: MiNote['visibility'] = 'public'): Promise<MiNote> {
		await notesRepository.insert({ id, text: `note_${id}`, userId: author.id, userHost: null, visibility });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function react(user: MiUser, note: MiNote, id: string): Promise<MiNoteReaction> {
		await noteReactionsRepository.insert({ id, noteId: note.id, userId: user.id, reaction: '👍' });
		return await noteReactionsRepository.findOneByOrFail({ noteId: note.id, id });
	}

	async function createPartition(prefix: string): Promise<void> {
		const upper = nextPrefix(prefix);
		await db.query(`CREATE TABLE "${childTableName('note_reaction', prefix)}" PARTITION OF "note_reaction_p" FOR VALUES FROM ('${prefix}') TO (${upper != null ? `'${upper}'` : 'MAXVALUE'})`);
	}

	async function located(userId: string): Promise<{ id: string; noteId: string; userId: string }[]> {
		return await db.query('SELECT "id", "noteId", "userId" FROM "note_reaction_locator" WHERE "userId" = $1 ORDER BY "id"', [userId]);
	}

	async function ids(userId: string, range: Partial<NoteReactionRange>): Promise<string[]> {
		const reactions = await findUserNoteReactions(db, userId, { ascending: false, limit: 10, ...range }, idService.gen(Date.now(), true));
		return reactions.map(reaction => reaction.id);
	}

	async function listed(ps: Record<string, unknown>): Promise<string[]> {
		const reactions: { id: string }[] = await usersReactions.exec({ userId: reactor.id, ...ps }, null, null);
		return reactions.map(reaction => reaction.id);
	}

	function lockedTables(): string[][] {
		const transaction = db.transaction.bind(db) as unknown as (run: (em: EntityManager) => Promise<unknown>) => Promise<unknown>;
		const held: string[][] = [];
		vi.spyOn(db as unknown as { transaction: (run: (em: EntityManager) => Promise<unknown>) => Promise<unknown> }, 'transaction').mockImplementation(async run => await transaction(async em => {
			const result = await run(em);
			const rows: { name: string }[] = await em.query(`
				SELECT c.relname AS "name"
				FROM pg_locks l
				JOIN pg_class c ON c.oid = l.relation
				WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation' AND c.relkind IN ('r', 'p') AND c.relname LIKE 'note\\_reaction%'
				ORDER BY 1
			`);
			held.push(rows.map(row => row.name));
			return result;
		}));
		return held;
	}

	function partition(ord: number): string {
		return childTableName('note_reaction', ordinalToPrefix(ord));
	}

	async function waitUntilBlockedBy(pid: number, statement: RegExp): Promise<void> {
		for (let i = 0; i < 100; i++) {
			const blocked: { query: string }[] = await db.query('SELECT "query" FROM "pg_stat_activity" WHERE $1 = ANY(pg_blocking_pids("pid"))', [pid]);
			if (blocked.some(row => statement.test(row.query))) return;
			await setTimeout(50);
		}
		throw new Error('timed out');
	}

	async function expectUserReactionPages(): Promise<void> {
		const page = (...reactions: MiNoteReaction[]) => reactions.map(reaction => reaction.id);

		expect(await ids(reactor.id, {})).toEqual(page(r[7], r[6], r[5], r[4], r[3], r[2], r[1], r[0]));
		expect(await ids(reactor.id, { limit: 3 })).toEqual(page(r[7], r[6], r[5]));
		expect(await ids(reactor.id, { limit: 3, untilId: r[5].id })).toEqual(page(r[4], r[3], r[2]));
		expect(await ids(reactor.id, { limit: 3, untilId: r[2].id })).toEqual(page(r[1], r[0]));
		expect(await ids(reactor.id, { limit: 3, untilId: r[0].id })).toEqual([]);
		expect(await ids(reactor.id, { limit: 3, sinceId: r[0].id, ascending: true })).toEqual(page(r[1], r[2], r[3]));
		expect(await ids(reactor.id, { limit: 3, sinceId: r[3].id, ascending: true })).toEqual(page(r[4], r[5], r[6]));
		expect(await ids(reactor.id, { limit: 3, sinceId: r[6].id, ascending: true })).toEqual(page(r[7]));
		expect(await ids(reactor.id, { limit: 3, sinceId: r[7].id, ascending: true })).toEqual([]);
		expect(await ids(reactor.id, { limit: 3, sinceId: r[1].id, untilId: r[6].id })).toEqual(page(r[5], r[4], r[3]));
		expect(await ids(reactor.id, { limit: 3, sinceId: r[1].id, untilId: r[6].id, ascending: true })).toEqual(page(r[2], r[3], r[4]));
		expect(await ids(reactor.id, { sinceId: r[0].id, untilId: r[1].id })).toEqual([]);

		expect(await ids(lone.id, { limit: 2 })).toEqual(page(l[3], l[2]));
		expect(await ids(lone.id, { limit: 2, untilId: l[2].id })).toEqual(page(l[1], l[0]));
		expect(await ids(lone.id, { limit: 2, untilId: l[0].id })).toEqual([]);
		expect(await ids(lone.id, { limit: 2, sinceId: l[0].id, ascending: true })).toEqual(page(l[1], l[2]));
		expect(await ids(lone.id, { limit: 2, sinceId: l[2].id, ascending: true })).toEqual(page(l[3]));

		expect(await listed({ limit: 3 })).toEqual(page(r[7], r[6], r[5]));
		expect(await listed({ limit: 3, untilId: r[5].id })).toEqual(page(r[3], r[2], r[1]));
		expect(await listed({ limit: 3, sinceId: r[0].id })).toEqual(page(r[1], r[2], r[3]));
		expect(await listed({ limit: 3, sinceId: r[3].id })).toEqual(page(r[5], r[6], r[7]));
		expect(await listed({ limit: 3, sinceDate: time2000 + (base - 4) * prefixSpan })).toEqual(page(r[1], r[2], r[3]));
		expect(await listed({ limit: 3, untilDate: time2000 + (base - 1) * prefixSpan })).toEqual(page(r[3], r[2], r[1]));
		expect(await listed({ limit: 10, sinceDate: time2000 + (base - 4) * prefixSpan, untilDate: time2000 + base * prefixSpan })).toEqual(page(r[3], r[2], r[1]));
		expect(await listed({ limit: 3, untilId: r[5].id, sinceDate: time2000 + (base - 3) * prefixSpan })).toEqual(page(r[3], r[2], r[1]));
		expect(await listed({ limit: 3, sinceId: r[0].id, untilDate: time2000 + (base - 4) * prefixSpan })).toEqual(page(r[1], r[2], r[3]));
		expect(await listed({ limit: 3, sinceId: r[0].id, untilId: r[5].id, sinceDate: time2000 + (base - 3) * prefixSpan, untilDate: time2000 + (base - 3) * prefixSpan })).toEqual(page(r[3], r[2], r[1]));
	}

	async function expectOldFormatLikes(): Promise<void> {
		for (const reaction of [r[0], r[1]]) {
			const res = await fastify.inject({ method: 'GET', url: `/likes/${reaction.id}`, headers: { accept: 'application/activity+json' } });
			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({
				type: 'Like',
				id: `${config.url}/likes/${reaction.noteId}/${reaction.id}`,
				actor: `${config.url}/users/${reactor.id}`,
				object: `${config.url}/notes/${reaction.noteId}`,
			});
			const resolver = await apResolverService.createResolver();
			expect(await resolver.resolve(`${config.url}/likes/${reaction.id}`)).toMatchObject({ id: `${config.url}/likes/${reaction.noteId}/${reaction.id}` });
		}
		for (const id of [at(base, 999), 'ZZZZZZZZZZ', 'a']) {
			const res = await fastify.inject({ method: 'GET', url: `/likes/${id}`, headers: { accept: 'application/activity+json' } });
			expect(res.statusCode).toBe(404);
			const resolver = await apResolverService.createResolver();
			await expect(resolver.resolve(`${config.url}/likes/${id}`)).rejects.toThrow();
		}
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				ActivityPubServerService,
				{ provide: 'ep:users/reactions', useClass: UsersReactions },
			],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		config = app.get(DI.config);
		idService = app.get(IdService);
		roleService = app.get(RoleService);
		apResolverService = app.get(ApResolverService);
		usersReactions = app.get('ep:users/reactions');
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);

		app.get<MiMeta>(DI.meta).federation = 'all';
		fastify = Fastify();
		await fastify.register(app.get(ActivityPubServerService).createServer);
		await fastify.ready();

		for (const name of triggerFunctions) {
			await db.query(`DROP FUNCTION IF EXISTS ${name}() CASCADE`);
		}
		await db.query('CREATE TABLE "note_reaction_p" (LIKE "note_reaction" INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING COMMENTS) PARTITION BY RANGE ("noteId")');
		await db.query('ALTER TABLE "note_reaction_p" ADD PRIMARY KEY ("noteId", "id")');
		base = prefixToOrdinal(prefixOf(idService.gen(Date.now(), true)));
		for (const ord of [base - 300, base - 150, ...Array.from({ length: 10 }, (_, i) => base - 8 + i)]) {
			await createPartition(ordinalToPrefix(ord));
		}
		await db.query('CREATE INDEX "IDX_NOTE_REACTION_ID_mig" ON "note_reaction_p" ("id")');
		await db.query('CREATE INDEX "IDX_NOTE_REACTION_USER_ID_ID_mig" ON "note_reaction_p" ("userId", "id")');
		await new NoteReactionLocator1792429514524().up(db);
		await db.query(buildSyncFunctionSql('note_reaction', 'note_reaction_p', 'note_reaction_sync_to_p', partitionCopyKeyColumns.note_reaction));
		await db.query('CREATE TRIGGER "note_reaction_sync" AFTER INSERT OR UPDATE OR DELETE ON "note_reaction" FOR EACH ROW EXECUTE FUNCTION note_reaction_sync_to_p()');

		author = await createUser(at(base - 8, 0));
		other = await createUser(at(base - 8, 1));
		writer = await createUser(at(base - 8, 2));
		reactor = await createUser(at(base - 6, 0));
		lone = await createUser(at(base - 300, 0));

		r.push(await react(reactor, await createNote(at(base - 6, 5)), at(base - 6, 10)));
		r.push(await react(reactor, await createNote(at(base - 6, 6)), at(base - 4, 10)));
		r.push(await react(reactor, await createNote(at(base - 4, 5)), at(base - 4, 20)));
		r.push(await react(reactor, await createNote(at(base - 4, 6)), at(base - 3, 10)));
		r.push(await react(reactor, await createNote(at(base - 1, 5), 'followers'), at(base - 1, 10)));
		r.push(await react(reactor, await createNote(at(base - 4, 7)), at(base, 10)));
		r.push(await react(reactor, await createNote(at(base, 5)), at(base, 20)));
		r.push(await react(reactor, await createNote(at(base - 5, 5)), at(base, 30)));
		await react(other, await notesRepository.findOneByOrFail({ id: r[2].noteId }), at(base - 4, 30));
		await react(other, await notesRepository.findOneByOrFail({ id: r[0].noteId }), at(base, 40));

		l.push(await react(lone, await createNote(at(base - 300, 5)), at(base - 300, 10)));
		l.push(await react(lone, await createNote(at(base - 300, 6)), at(base - 150, 10)));
		l.push(await react(lone, await createNote(at(base - 150, 5)), at(base, 50)));
		l.push(await react(lone, await createNote(at(base, 6)), at(base, 60)));
	});

	afterAll(async () => {
		for (const name of triggerFunctions) {
			await db.query(`DROP FUNCTION IF EXISTS ${name}() CASCADE`);
		}
		await fastify.close();
		await app.close();
	});

	test('the locator holds the reactions whose id prefix differs from their note\'s, written through the mirror of the plain copy', async () => {
		expect(await located(reactor.id)).toEqual([r[1], r[3], r[5], r[7]].map(reaction => ({ id: reaction.id, noteId: reaction.noteId, userId: reactor.id })));
		expect(await located(lone.id)).toEqual([l[1], l[2]].map(reaction => ({ id: reaction.id, noteId: reaction.noteId, userId: lone.id })));

		const crossNote = await createNote(at(base - 2, 5));
		const sameNote = await createNote(at(base, 70));
		const cross = await react(writer, crossNote, at(base, 80));
		const same = await react(writer, sameNote, at(base, 90));
		expect(await located(writer.id)).toEqual([{ id: cross.id, noteId: crossNote.id, userId: writer.id }]);

		await noteReactionsRepository.delete({ noteId: cross.noteId, id: cross.id });
		await noteReactionsRepository.delete({ noteId: same.noteId, id: same.id });
		expect(await located(writer.id)).toEqual([]);
	});

	test('users/reactions reads the plain copy in id order with both directions of pagination', async () => {
		await expectUserReactionPages();
	});

	test('old-format likes are found on the plain copy and missing ones are 404', async () => {
		await expectOldFormatLikes();
	});

	test('a lookup that starts while a switch holds note_reaction waits for it and then reads only the partitions it needs of the partitioned copy', async () => {
		const held = lockedTables();
		const holder = db.createQueryRunner();
		await holder.connect();
		try {
			const [{ pid }]: { pid: number }[] = await holder.query('SELECT pg_backend_pid() AS "pid"');
			await holder.startTransaction();
			await holder.query('LOCK TABLE "note_reaction", "note_reaction_p" IN ACCESS EXCLUSIVE MODE');
			const lookup = findNoteReactionById(db, r[1].id);
			await waitUntilBlockedBy(pid, /^LOCK TABLE ONLY "note_reaction" IN ACCESS SHARE MODE$/);
			await holder.query('DROP TRIGGER "note_reaction_sync" ON "note_reaction"');
			await holder.query('ALTER TABLE "note_reaction" RENAME TO "note_reaction_old"');
			await holder.query('ALTER TABLE "note_reaction_p" RENAME TO "note_reaction"');
			await holder.query(buildSyncFunctionSql('note_reaction', 'note_reaction_old', 'note_reaction_sync_to_old', partitionCopyKeyColumns.note_reaction));
			await holder.query('CREATE TRIGGER "note_reaction_sync" AFTER INSERT OR UPDATE OR DELETE ON "note_reaction" FOR EACH ROW EXECUTE FUNCTION note_reaction_sync_to_old()');
			await holder.commitTransaction();

			expect((await lookup)?.id).toBe(r[1].id);
		} finally {
			if (holder.isTransactionActive) await holder.rollbackTransaction();
			await holder.release();
		}

		expect(held).toEqual([['note_reaction', 'note_reaction_locator', partition(base - 6)]]);
	});

	test('the lookup by id on the partitioned copy locks only the parent, the locator and the partition it reads, and a page of a user\'s reactions locks only the parent while it reads which copy is live', async () => {
		const held = lockedTables();

		expect((await findNoteReactionById(db, r[0].id))?.id).toBe(r[0].id);
		expect(await ids(reactor.id, { limit: 3 })).toEqual([r[7].id, r[6].id, r[5].id]);

		expect(held).toEqual([
			['note_reaction', 'note_reaction_locator', partition(base - 6)],
			['note_reaction'],
		]);
	});

	test('a page of users/reactions on the partitioned copy holds no lock on the partitions it has read while it waits for the next one', async () => {
		const holder = db.createQueryRunner();
		await holder.connect();
		try {
			const [{ pid }]: { pid: number }[] = await holder.query('SELECT pg_backend_pid() AS "pid"');
			await holder.startTransaction();
			await holder.query(`LOCK TABLE "${partition(base - 2)}" IN ACCESS EXCLUSIVE MODE`);
			const page = listed({ limit: 5 });
			await waitUntilBlockedBy(pid, / FROM "note_reaction" "reaction" WHERE "reaction"\."noteId" >= /);

			const granted: { name: string }[] = await db.query(`
				SELECT c.relname AS "name"
				FROM pg_locks l
				JOIN pg_class c ON c.oid = l.relation
				WHERE l.locktype = 'relation' AND l.granted AND l.pid NOT IN (pg_backend_pid(), $1) AND c.relkind = 'r' AND c.relname LIKE 'note\\_reaction\\_p\\_%'
			`, [pid]);
			expect(granted).toEqual([]);

			await holder.commitTransaction();
			expect(await page).toEqual([r[7].id, r[6].id, r[5].id, r[3].id, r[2].id]);
		} finally {
			if (holder.isTransactionActive) await holder.rollbackTransaction();
			await holder.release();
		}
	});

	test('the first page of users/reactions on the partitioned copy does not read the partition after the one of now', async () => {
		const holder = db.createQueryRunner();
		await holder.connect();
		try {
			const [{ pid }]: { pid: number }[] = await holder.query('SELECT pg_backend_pid() AS "pid"');
			await holder.startTransaction();
			await holder.query(`LOCK TABLE "${partition(base + 1)}" IN ACCESS EXCLUSIVE MODE`);
			let settled = false;
			const page = listed({ limit: 3 }).finally(() => settled = true);
			const blocked = async (): Promise<boolean> => {
				for (;;) {
					if (settled) return false;
					const waiting: unknown[] = await db.query('SELECT 1 FROM "pg_stat_activity" WHERE $1 = ANY(pg_blocking_pids("pid"))', [pid]);
					if (waiting.length > 0) return true;
					await setTimeout(20);
				}
			};

			expect(await blocked()).toBe(false);
			expect(await page).toEqual([r[7].id, r[6].id, r[5].id]);
		} finally {
			if (holder.isTransactionActive) await holder.rollbackTransaction();
			await holder.release();
		}
	});

	test('users/reactions reads the partitioned copy in the same order with both directions of pagination', async () => {
		await expectUserReactionPages();
	});

	test('users/reactions reads no reaction and no note for a visitor of a server that shows nothing to visitors', async () => {
		const meta = app.get<MiMeta>(DI.meta);
		const previous = meta.ugcVisibilityForVisitor;
		const statements: string[] = [];
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: event => {
				statements.push(event.query);
			},
		};
		meta.ugcVisibilityForVisitor = 'none';
		db.subscribers.push(subscriber);
		try {
			expect(await listed({ limit: 3 })).toEqual([]);
		} finally {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			meta.ugcVisibilityForVisitor = previous;
		}

		expect(statements.filter(query => /"note(_reaction(_locator)?)?"/.test(query))).toEqual([]);
		expect(await listed({ limit: 3 })).toEqual([r[7].id, r[6].id, r[5].id]);
	});

	test('old-format likes are found on the partitioned copy and missing ones are 404', async () => {
		await expectOldFormatLikes();
	});

	test('a moderator asking for the reactions of a user that does not exist gets none without reading any partition', async () => {
		const moderator = await createUser(at(base, 150)) as MiLocalUser;
		vi.spyOn(roleService, 'isModerator').mockResolvedValue(true);
		const held = lockedTables();

		for (const userId of ['0000000000', at(base - 6, 1)]) {
			expect(await usersReactions.exec({ userId }, moderator, null)).toEqual([]);
		}
		expect(held).toEqual([]);
		expect((await usersReactions.exec({ userId: reactor.id, limit: 3 }, moderator, null)).map((reaction: { id: string }) => reaction.id)).toEqual([r[7].id, r[6].id, r[5].id]);
		expect(held).toHaveLength(1);
	});

	test('ids that are not of the partition scheme find nothing on the partitioned copy instead of failing', async () => {
		for (const range of [{ untilId: 'ZZZZZZZZZZ' }, { sinceId: 'a', ascending: true }, { sinceId: r[0].id, untilId: 'ZZ' }]) {
			expect(await ids(reactor.id, range)).toEqual([]);
		}
		expect(await ids('ZZZZZZZZZZ', {})).toEqual([]);
		expect(await listed({ untilId: 'ZZZZZZZZZZ' })).toEqual([]);
	});

	test('the locator follows inserts, updates and deletes on the partitioned copy', async () => {
		const crossNote = await createNote(at(base - 2, 6));
		const sameNote = await createNote(at(base, 100));
		const cross = await react(writer, crossNote, at(base, 110));
		await react(writer, sameNote, at(base, 120));
		expect(await located(writer.id)).toEqual([{ id: cross.id, noteId: crossNote.id, userId: writer.id }]);

		await db.query('UPDATE "note_reaction" SET "userId" = $1 WHERE "noteId" = $2 AND "id" = $3', [other.id, cross.noteId, cross.id]);
		expect(await located(writer.id)).toEqual([]);
		expect(await located(other.id)).toEqual(expect.arrayContaining([{ id: cross.id, noteId: crossNote.id, userId: other.id }]));

		const movedNote = await createNote(at(base, 130));
		await db.query('UPDATE "note_reaction" SET "noteId" = $1 WHERE "noteId" = $2 AND "id" = $3', [movedNote.id, cross.noteId, cross.id]);
		expect(await db.query('SELECT 1 FROM "note_reaction_locator" WHERE "id" = $1', [cross.id])).toHaveLength(0);
		await db.query('UPDATE "note_reaction" SET "noteId" = $1 WHERE "noteId" = $2 AND "id" = $3', [crossNote.id, movedNote.id, cross.id]);
		expect(await located(other.id)).toEqual(expect.arrayContaining([{ id: cross.id, noteId: crossNote.id, userId: other.id }]));

		await db.query('DELETE FROM "note_reaction" WHERE "userId" = ANY($1) AND "noteId" = ANY($2)', [[writer.id, other.id], [crossNote.id, sameNote.id]]);
		expect(await located(writer.id)).toEqual([]);
		expect(await db.query('SELECT 1 FROM "note_reaction_locator" WHERE "id" = $1', [cross.id])).toHaveLength(0);
		expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_old" WHERE "noteId" = ANY($1)', [[crossNote.id, sameNote.id]])).toEqual([{ count: 0 }]);
	});

	test('a stale locator row neither hides a reaction nor makes one up', async () => {
		const ghost = at(base, 140);
		await db.query('INSERT INTO "note_reaction_locator" ("id", "noteId", "userId") VALUES ($1, $2, $3), ($4, $5, $3)', [r[0].id, r[2].noteId, reactor.id, ghost, r[0].noteId]);
		try {
			expect((await findNoteReactionById(db, r[0].id))?.id).toBe(r[0].id);
			expect(await findNoteReactionById(db, ghost)).toBe(null);
			expect(await ids(reactor.id, {})).toEqual([r[7], r[6], r[5], r[4], r[3], r[2], r[1], r[0]].map(reaction => reaction.id));
			expect(await ids(reactor.id, { limit: 2, untilId: r[2].id })).toEqual([r[1], r[0]].map(reaction => reaction.id));
		} finally {
			await db.query('DELETE FROM "note_reaction_locator" WHERE "id" = ANY($1)', [[r[0].id, ghost]]);
		}
	});
});
