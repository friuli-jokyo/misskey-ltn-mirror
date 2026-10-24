/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import { NoteFavoriteEntityService } from '@/core/entities/NoteFavoriteEntityService.js';
import { DI } from '@/di-symbols.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import FavoritesEndpoint from '@/server/api/endpoints/i/favorites.js';
import type { Packed } from '@/misc/json-schema.js';
import type { MiLocalUser } from '@/models/User.js';
import type { MiNote, MiNoteFavorite, MiUser, NoteFavoritesRepository, NotesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource } from 'typeorm';

describe('NoteFavoriteEntityService', () => {
	let app: TestingModule;
	let idService: IdService;
	let noteEntityService: NoteEntityService;
	let service: NoteFavoriteEntityService;
	let favoritesEndpoint: FavoritesEndpoint;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let noteFavoritesRepository: NoteFavoritesRepository;

	async function createUser(): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase() });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function createNote(user: MiUser): Promise<MiNote> {
		const id = idService.gen();
		await notesRepository.insert({ id, text: `note_${id}`, userId: user.id, userHost: user.host, visibility: 'public' });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function createFavorite(user: MiUser, note: MiNote): Promise<MiNoteFavorite> {
		const id = idService.gen();
		await noteFavoritesRepository.insert({ id, userId: user.id, noteId: note.id });
		return await noteFavoritesRepository.findOneByOrFail({ id });
	}

	async function createFavoritesWithOrphan() {
		const me = await createUser();
		const author = await createUser();
		const notes = [await createNote(author), await createNote(author), await createNote(author)];
		const favorites: MiNoteFavorite[] = [];
		for (const note of notes) {
			favorites.push(await createFavorite(me, note));
		}
		await notesRepository.delete(notes[1].id);
		expect(await noteFavoritesRepository.existsBy({ id: favorites[1].id })).toBe(true);
		return { me, favorites, orphan: favorites[1], alive: [favorites[0], favorites[2]] };
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [FavoritesEndpoint],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		idService = app.get(IdService);
		noteEntityService = app.get(NoteEntityService);
		service = app.get(NoteFavoriteEntityService);
		favoritesEndpoint = app.get(FavoritesEndpoint);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		noteFavoritesRepository = app.get(DI.noteFavoritesRepository);

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
	});

	afterAll(async () => {
		await app.close();
	});

	test('i/favorites skips favorites whose note no longer exists', async () => {
		const { me, alive } = await createFavoritesWithOrphan();

		const res: Packed<'NoteFavorite'>[] = await favoritesEndpoint.exec({}, me as MiLocalUser, null);

		const expected = [...alive].sort((a, b) => a.id < b.id ? 1 : -1);
		expect(res.map(x => x.id)).toEqual(expected.map(x => x.id));
		expect(res.map(x => x.note.id)).toEqual(expected.map(x => x.noteId));
	});

	test('packMany skips favorites whose note no longer exists', async () => {
		const { me, favorites, alive } = await createFavoritesWithOrphan();

		const packed = await service.packMany(favorites, me);

		expect(packed.map(x => x.id)).toEqual(alive.map(x => x.id));
		expect(packed.map(x => x.note.id)).toEqual(alive.map(x => x.noteId));
	});

	test('pack returns null for a favorite whose note no longer exists', async () => {
		const { me, orphan, alive } = await createFavoritesWithOrphan();

		expect(await service.pack(orphan, me)).toBeNull();
		expect(await service.pack(orphan.id, me)).toBeNull();
		expect((await service.pack(alive[0].id, me))?.note.id).toBe(alive[0].noteId);
	});

	test('packMany still throws errors other than a missing note', async () => {
		const { me, favorites } = await createFavoritesWithOrphan();
		vi.spyOn(noteEntityService, 'pack').mockRejectedValueOnce(new Error('unexpected'));

		await expect(service.packMany(favorites, me)).rejects.toThrow('unexpected');
	});
});
