/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Test } from '@nestjs/testing';
import { In } from 'typeorm';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { QueryService } from '@/core/QueryService.js';
import { SearchService } from '@/core/SearchService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { DI } from '@/di-symbols.js';
import { prefixOf } from '@/misc/partition.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { GetterService } from '@/server/api/GetterService.js';
import UsersGetFrequentlyRepliedUsers from '@/server/api/endpoints/users/get-frequently-replied-users.js';
import type { MiMeta, MiNote, MiUser, NotesRepository, UserNotePiningsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource, EntitySubscriberInterface } from 'typeorm';

const day = 1000 * 60 * 60 * 24;

describe('Fetching notes by id', () => {
	let app: TestingModule;
	let db: DataSource;
	let meta: MiMeta;
	let idService: IdService;
	let queryService: QueryService;
	let searchService: SearchService;
	let noteEntityService: NoteEntityService;
	let userEntityService: UserEntityService;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let userNotePiningsRepository: UserNotePiningsRepository;
	let usersGetFrequentlyRepliedUsers: UsersGetFrequentlyRepliedUsers;

	async function createUser(): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase() });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createNote(user: MiUser, data: Partial<MiNote> = {}, time?: number): Promise<MiNote> {
		const id = idService.gen(time);
		await notesRepository.insert({ id, text: `note_${id}`, userId: user.id, userHost: user.host, visibility: 'public', ...data });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function fetchedNoteIds<T>(run: () => Promise<T>): Promise<{ result: T; fetched: string[][] }> {
		const fetched: string[][] = [];
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: event => {
				if (/FROM "note" "MiNote" WHERE \(\("MiNote"\."id" IN \(/.test(event.query) && Array.isArray(event.parameters)) fetched.push(event.parameters.filter((parameter): parameter is string => typeof parameter === 'string'));
			},
		};
		db.subscribers.push(subscriber);
		try {
			return { result: await run(), fetched };
		} finally {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
		}
	}

	function prefixesPerStatement(fetched: string[][]): number[] {
		return fetched.map(ids => new Set(ids.map(id => prefixOf(id))).size);
	}

	async function statementsFor<T>(ugcVisibilityForVisitor: MiMeta['ugcVisibilityForVisitor'], run: () => Promise<T>): Promise<{ result: T; statements: string[] }> {
		const previous = meta.ugcVisibilityForVisitor;
		const statements: string[] = [];
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: event => {
				statements.push(event.query);
			},
		};
		meta.ugcVisibilityForVisitor = ugcVisibilityForVisitor;
		db.subscribers.push(subscriber);
		try {
			return { result: await run(), statements };
		} finally {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
			meta.ugcVisibilityForVisitor = previous;
		}
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				GetterService,
				{ provide: 'ep:users/get-frequently-replied-users', useClass: UsersGetFrequentlyRepliedUsers },
			],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		meta = app.get(DI.meta);
		idService = app.get(IdService);
		queryService = app.get(QueryService);
		searchService = app.get(SearchService);
		noteEntityService = app.get(NoteEntityService);
		userEntityService = app.get(UserEntityService);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		userNotePiningsRepository = app.get(DI.userNotePiningsRepository);
		usersGetFrequentlyRepliedUsers = app.get('ep:users/get-frequently-replied-users');
	});

	afterAll(async () => {
		await app.close();
	});

	test('NoteEntityService.packMany fetches the replies and renotes it lacks one partition at a time', async () => {
		const author = await createUser();
		const replied = await createNote(author, {}, Date.now() - 200 * day);
		const renoted = await createNote(author, {}, Date.now() - 100 * day);
		const reply = await createNote(author, { replyId: replied.id, threadId: replied.id });
		const renote = await createNote(author, { renoteId: renoted.id, text: null });
		expect(prefixOf(replied.id)).not.toBe(prefixOf(renoted.id));
		const notes = await notesRepository.findBy({ id: In([reply.id, renote.id]) });

		const { result: packed, fetched } = await fetchedNoteIds(async () => await noteEntityService.packMany(notes, null, { detail: true }));

		expect(fetched.flat().sort()).toEqual([replied.id, renoted.id].sort());
		expect(prefixesPerStatement(fetched)).toEqual(fetched.map(() => 1));
		expect(packed.find(note => note.id === reply.id)?.reply?.id).toBe(replied.id);
		expect(packed.find(note => note.id === renote.id)?.renote?.id).toBe(renoted.id);
	});

	test('UserEntityService fetches the pinned notes one partition at a time', async () => {
		const me = await createUser();
		const users = [await createUser(), await createUser()];
		const pinned: Record<string, string[]> = {};
		for (const [i, user] of users.entries()) {
			const notes = [await createNote(user, {}, Date.now() - (300 - i) * day), await createNote(user, {}, Date.now() - (100 - i) * day)];
			expect(prefixOf(notes[0].id)).not.toBe(prefixOf(notes[1].id));
			for (const note of notes) await userNotePiningsRepository.insert({ id: idService.gen(), userId: user.id, noteId: note.id });
			pinned[user.id] = notes.map(note => note.id);
		}

		const one = await fetchedNoteIds(async () => await userEntityService.pack(users[0], me, { schema: 'UserDetailed' }));
		const many = await fetchedNoteIds(async () => await userEntityService.packMany(users, me, { schema: 'UserDetailed' }));

		expect([...new Set(one.fetched.flat())].sort()).toEqual([...pinned[users[0].id]].sort());
		expect(prefixesPerStatement(one.fetched)).toEqual(one.fetched.map(() => 1));
		expect(one.result.pinnedNoteIds.toSorted()).toEqual([...pinned[users[0].id]].sort());
		expect([...new Set(many.fetched.flat())].sort()).toEqual(users.flatMap(user => pinned[user.id]).sort());
		expect(prefixesPerStatement(many.fetched)).toEqual(many.fetched.map(() => 1));
		expect(many.result.map(user => user.pinnedNoteIds.toSorted())).toEqual(users.map(user => [...pinned[user.id]].sort()));
	});

	test('users/get-frequently-replied-users looks up the notes replied to at most 100 in a statement', async () => {
		const me = await createUser();
		const authors = [await createUser(), await createUser(), await createUser()];
		const replied: MiNote[] = [];
		for (const [author, count] of [[authors[0], 100], [authors[1], 30], [authors[2], 20]] as const) {
			for (let i = 0; i < count; i++) replied.push(await createNote(author));
		}
		for (const note of [...replied, replied[0], replied[100]]) {
			await createNote(me, { replyId: note.id, threadId: note.id });
		}
		const repliedIds = new Set(replied.map(note => note.id));
		const lookups: string[][] = [];
		const subscriber: EntitySubscriberInterface = {
			beforeQuery: event => {
				if (/ FROM "note" "note" WHERE "note"\."id" IN \(/.test(event.query) && Array.isArray(event.parameters)) lookups.push(event.parameters.filter((parameter): parameter is string => typeof parameter === 'string' && repliedIds.has(parameter)));
			},
		};

		db.subscribers.push(subscriber);
		const result: { user: { id: string }; weight: number }[] = await usersGetFrequentlyRepliedUsers.exec({ userId: me.id }, me as MiLocalUser, null).finally(() => {
			db.subscribers.splice(db.subscribers.indexOf(subscriber), 1);
		});

		expect(result.map(({ user, weight }) => [user.id, weight])).toEqual([[authors[0].id, 1], [authors[1].id, 0.3], [authors[2].id, 0.2]]);
		expect(lookups.map(ids => ids.length)).toEqual([100, 50]);
		expect(lookups.flat().sort()).toEqual([...repliedIds].sort());
	});

	describe('for a visitor of a server that shows nothing to visitors', () => {
		test('QueryService.fetchPaginationQueryAcrossPartitions returns nothing without walking the partitions', async () => {
			const author = await createUser();
			const note = await createNote(author);
			const walk = () => {
				const query = notesRepository.createQueryBuilder('note').where('note.userId = :userId', { userId: author.id });
				queryService.generateVisibilityQuery(query, null);
				queryService.generateUgcVisibilityQueryForVisitor(query);
				return queryService.fetchPaginationQueryAcrossPartitions(query, {}, 10);
			};

			const all = await statementsFor('all', walk);
			const none = await statementsFor('none', walk);

			expect(all.result.map(found => found.id)).toEqual([note.id]);
			expect(all.statements.length).toBeGreaterThan(1);
			expect(none.result).toEqual([]);
			expect(none.statements).toEqual([]);
		});

		test('QueryService.fetchNotesByRelation returns nothing without reading the relations or the notes', async () => {
			const author = await createUser();
			const note = await createNote(author);
			const reply = await createNote(author, { replyId: note.id, threadId: note.id });
			await db.query('INSERT INTO "note_relation" ("childId", "parentId", "kind") VALUES ($1, $2, 0)', [reply.id, note.id]);
			const fetch = () => queryService.fetchNotesByRelation(note.id, [0], { limit: 10 }, null);

			const all = await statementsFor('all', fetch);
			const none = await statementsFor('none', fetch);

			expect(all.result.map(found => found.id)).toEqual([reply.id]);
			expect(all.statements.length).toBeGreaterThan(1);
			expect(none.result).toEqual([]);
			expect(none.statements).toEqual([]);
		});

		test('SearchService does not count the notes of the partitions to tell a common term', async () => {
			const isCommonTerm = (searchService as unknown as { isCommonTerm: (q: string, me: MiUser | null, opts: object, usePgroonga: boolean) => Promise<boolean> }).isCommonTerm;

			const { result, statements } = await statementsFor('none', () => isCommonTerm('note', null, {}, false));

			expect(result).toBe(false);
			expect(statements).toEqual([]);
		});
	});
});
