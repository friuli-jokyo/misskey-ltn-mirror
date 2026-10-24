/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { Test } from '@nestjs/testing';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { DI } from '@/di-symbols.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import type { Config } from '@/config.js';
import type { MiMeta, MiNote, MiUser, MiUserNotePining, NoteRelationsRepository, NotesRepository, NoteUrisRepository, UserNotePiningsRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';

describe('ActivityPubServerService', () => {
	let app: TestingModule;
	let fastify: FastifyInstance;
	let config: Config;
	let idService: IdService;
	let noteDeleteService: NoteDeleteService;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let noteUrisRepository: NoteUrisRepository;
	let noteRelationsRepository: NoteRelationsRepository;
	let userNotePiningsRepository: UserNotePiningsRepository;

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createNote(user: MiUser, data: Partial<MiNote> = {}): Promise<MiNote> {
		const id = idService.gen();
		await notesRepository.insert({ id, text: `note_${id}`, userId: user.id, userHost: user.host, visibility: 'public', ...data });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function createPining(user: MiUser, note: MiNote): Promise<MiUserNotePining> {
		const id = idService.gen();
		await userNotePiningsRepository.insert({ id, userId: user.id, noteId: note.id });
		return await userNotePiningsRepository.findOneByOrFail({ id });
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [ActivityPubServerService],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		config = app.get(DI.config);
		idService = app.get(IdService);
		noteDeleteService = app.get(NoteDeleteService);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		noteUrisRepository = app.get(DI.noteUrisRepository);
		noteRelationsRepository = app.get(DI.noteRelationsRepository);
		userNotePiningsRepository = app.get(DI.userNotePiningsRepository);

		app.get<MiMeta>(DI.meta).federation = 'all';

		await app.get<DataSource>(DI.db).query(`
			DO $$
			DECLARE
				r record;
			BEGIN
				FOR r IN SELECT conname, conrelid::regclass::text AS tbl FROM pg_constraint
					WHERE contype = 'f' AND confrelid = 'note'::regclass
				LOOP
					EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
				END LOOP;
			END $$
		`);

		fastify = Fastify();
		await fastify.register(app.get(ActivityPubServerService).createServer);
		await fastify.ready();
	});

	afterAll(async () => {
		await fastify.close();
		await app.close();
	});

	describe('featured', () => {
		test('skips pinned notes that no longer exist', async () => {
			const user = await createUser();
			const notes = [await createNote(user), await createNote(user), await createNote(user)];
			const pinings: MiUserNotePining[] = [];
			for (const note of notes) {
				pinings.push(await createPining(user, note));
			}
			await notesRepository.delete(notes[1].id);
			expect(await userNotePiningsRepository.existsBy({ id: pinings[1].id })).toBe(true);

			const res = await fastify.inject({
				method: 'GET',
				url: `/users/${user.id}/collections/featured`,
				headers: { accept: 'application/activity+json' },
			});

			expect(res.statusCode).toBe(200);
			const expected = [pinings[0], pinings[2]].sort((a, b) => a.id < b.id ? 1 : -1).map(pining => `${config.url}/notes/${pining.noteId}`);
			const body = res.json();
			expect(body.totalItems).toBe(2);
			expect(body.orderedItems.map((item: { id: string }) => item.id)).toEqual(expected);
		});
	});

	describe('note', () => {
		async function getNote(id: string) {
			return await fastify.inject({
				method: 'GET',
				url: `/notes/${id}`,
				headers: { accept: 'application/activity+json' },
			});
		}

		async function addEdges(id: MiNote['id']): Promise<void> {
			const t = idService.parse(id).date.getTime();
			await noteRelationsRepository.insert([
				{ childId: id, parentId: idService.gen(t - 1000, true), kind: 0 },
				{ childId: idService.gen(t + 1000, true), parentId: id, kind: 1 },
			]);
		}

		test('answers a Tombstone for a deleted local note whose deletion was recorded, without any edge', async () => {
			const user = await createUser();
			const note = await createNote(user);
			await noteDeleteService.delete(user, note, true);

			const res = await getNote(note.id);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({ id: `${config.url}/notes/${note.id}`, type: 'Tombstone' });
		});

		test('answers 404 for a deleted remote note whose deletion was recorded', async () => {
			const user = await createUser({ host: 'remote.example.com' });
			const uri = `https://remote.example.com/notes/${secureRndstr(16)}`;
			const note = await createNote(user, { uri });
			await noteUrisRepository.insert({ uri, noteId: note.id });
			await addEdges(note.id);
			await noteDeleteService.delete(user, note, true);
			expect(await app.get<DataSource>(DI.db).query('SELECT "id" FROM "deleted_note" WHERE "id" = $1', [note.id])).toEqual([{ id: note.id }]);

			expect((await getNote(note.id)).statusCode).toBe(404);
		});

		test('answers 404 for a remote note deleted before its uri was recorded', async () => {
			const user = await createUser({ host: 'remote.example.com' });
			const note = await createNote(user, { uri: `https://remote.example.com/notes/${secureRndstr(16)}` });
			expect(await noteUrisRepository.existsBy({ noteId: note.id })).toBe(false);
			await noteDeleteService.delete(user, note, true);

			expect((await getNote(note.id)).statusCode).toBe(404);
		});

		test('answers 404 for an id with edges but neither a note nor a recorded deletion', async () => {
			const id = idService.gen();
			await addEdges(id);

			expect((await getNote(id)).statusCode).toBe(404);
		});

		test('answers 404 for an unknown id', async () => {
			expect((await getNote(idService.gen())).statusCode).toBe(404);
		});
	});

	describe('note activity', () => {
		const db = () => app.get<DataSource>(DI.db);

		async function getActivity(id: string) {
			return await fastify.inject({
				method: 'GET',
				url: `/notes/${id}/activity`,
				headers: { accept: 'application/activity+json' },
			});
		}

		async function createRemoteNote(): Promise<{ user: MiUser; note: MiNote }> {
			const user = await createUser({ host: 'remote.example.com' });
			const uri = `https://remote.example.com/notes/${secureRndstr(16)}`;
			const note = await createNote(user, { uri });
			await noteUrisRepository.insert({ uri, noteId: note.id });
			return { user, note };
		}

		async function recordOriginal(note: MiNote, renoteId: MiNote['id']): Promise<void> {
			await db().query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId") VALUES ($1, NULL, $2)', [note.id, renoteId]);
		}

		test('announces the uri of a deleted remote note', async () => {
			const { user: remoteUser, note: target } = await createRemoteNote();
			const renote = await createNote(await createUser(), { text: null, renoteId: target.id });
			await noteDeleteService.delete(remoteUser, target, true);

			const res = await getActivity(renote.id);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({ type: 'Announce', object: target.uri });
		});

		test('announces the uri of a remote note deleted before its uri was recorded', async () => {
			const remoteUser = await createUser({ host: 'remote.example.com' });
			const target = await createNote(remoteUser, { uri: `https://remote.example.com/notes/${secureRndstr(16)}` });
			const renote = await createNote(await createUser(), { text: null, renoteId: target.id });
			await noteDeleteService.delete(remoteUser, target, true);

			const res = await getActivity(renote.id);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({ type: 'Announce', object: target.uri });
		});

		test('announces the local url of a deleted local note', async () => {
			const user = await createUser();
			const target = await createNote(user);
			const renote = await createNote(user, { text: null, renoteId: target.id });
			await noteDeleteService.delete(user, target, true);

			const res = await getActivity(renote.id);

			expect(res.statusCode).toBe(200);
			expect(res.json()).toMatchObject({ type: 'Announce', object: `${config.url}/notes/${target.id}` });
		});

		test('announces the uri of the recorded original of a note that could not be linked', async () => {
			const { user: remoteUser, note: target } = await createRemoteNote();
			const deleted = await createRemoteNote();
			const user = await createUser();
			const renote = await createNote(user, { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			const renoteOfDeleted = await createNote(user, { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			await recordOriginal(renote, target.id);
			await recordOriginal(renoteOfDeleted, deleted.note.id);
			await noteDeleteService.delete(deleted.user, deleted.note, true);

			expect((await getActivity(renote.id)).json()).toMatchObject({ type: 'Announce', object: target.uri });
			expect((await getActivity(renoteOfDeleted.id)).json()).toMatchObject({ type: 'Announce', object: deleted.note.uri });
			expect(await notesRepository.existsBy({ id: target.id, userId: remoteUser.id })).toBe(true);
		});

		test('announces the uri recorded for the original of a note that could not be linked, not the uri of a note that took the id of the evicted original', async () => {
			const { user: remoteUser, note: original } = await createRemoteNote();
			const renote = await createNote(await createUser(), { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			await db().query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId", "renoteUri") VALUES ($1, NULL, $2, $3)', [renote.id, original.id, original.uri]);
			await notesRepository.delete(original.id);
			await noteUrisRepository.delete({ noteId: original.id });
			const reissuedUri = `https://remote.example.com/notes/${secureRndstr(16)}`;
			await notesRepository.insert({ id: original.id, text: 'another note', userId: remoteUser.id, userHost: remoteUser.host, visibility: 'public', uri: reissuedUri });
			await noteUrisRepository.insert({ uri: reissuedUri, noteId: original.id });

			expect((await getActivity(renote.id)).json()).toMatchObject({ type: 'Announce', object: original.uri });

			await noteDeleteService.delete(remoteUser, await notesRepository.findOneByOrFail({ id: original.id }), true);

			expect((await getActivity(renote.id)).json()).toMatchObject({ type: 'Announce', object: original.uri });
		});

		test('announces nothing for a note that could not be linked without a recorded original, nor for an evicted remote note', async () => {
			const { note: evicted } = await createRemoteNote();
			const user = await createUser();
			const note = await createNote(user);
			const unrecorded = await createNote(user, { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			const renoteOfEvicted = await createNote(user, { text: null, renoteId: evicted.id });
			await notesRepository.delete(evicted.id);
			await noteUrisRepository.delete({ noteId: evicted.id });

			expect((await getActivity(unrecorded.id)).statusCode).toBe(404);
			expect((await getActivity(renoteOfEvicted.id)).statusCode).toBe(404);

			const res = await fastify.inject({
				method: 'GET',
				url: `/users/${user.id}/outbox?page=true`,
				headers: { accept: 'application/activity+json' },
			});
			expect(res.statusCode).toBe(200);
			expect(res.json().orderedItems.map((item: { id: string }) => item.id)).toEqual([`${config.url}/notes/${note.id}/activity`]);
			expect(res.body).not.toContain(`/notes/${UNREFERENCEABLE_NOTE_ID}`);
			expect(res.body).not.toContain(`/notes/${evicted.id}`);
		});
	});
});
