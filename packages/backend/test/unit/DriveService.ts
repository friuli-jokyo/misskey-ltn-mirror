/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, test, expect } from 'vitest';
import { Test } from '@nestjs/testing';
import {
	DeleteObjectCommand,
	DeleteObjectCommandOutput,
	InvalidObjectState,
	NoSuchKey,
	S3Client,
} from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { GlobalModule } from '@/GlobalModule.js';
import { DriveService } from '@/core/DriveService.js';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { DI } from '@/di-symbols.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import type { DriveFilesRepository, DriveFoldersRepository, MiDriveFile, MiDriveFolder, MiUser, UsersRepository } from '@/models/_.js';
import { DriveFolderFilesCountCounter1792429514514 } from '../../migration/1792429514514-driveFolderFilesCountCounter.js';
import type { TestingModule } from '@nestjs/testing';
import type { DataSource, QueryRunner } from 'typeorm';

describe('DriveService', () => {
	let app: TestingModule;
	let driveService: DriveService;
	const s3Mock = mockClient(S3Client);

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [DriveService],
		}).compile();
		app.enableShutdownHooks();
		driveService = app.get<DriveService>(DriveService);
	});

	beforeEach(async () => {
		s3Mock.reset();
	});

	afterAll(async () => {
		await app.close();
	});

	describe('Object storage', () => {
		test('delete a file', async () => {
			s3Mock.on(DeleteObjectCommand)
				.resolves({} as DeleteObjectCommandOutput);

			await driveService.deleteObjectStorageFile('peace of the world');
		});

		test('delete a file then unexpected error', async () => {
			s3Mock.on(DeleteObjectCommand)
				.rejects(new InvalidObjectState({ $metadata: {}, message: '' }));

			await expect(driveService.deleteObjectStorageFile('unexpected')).rejects.toThrow(Error);
		});

		test('delete a file with no valid key', async () => {
			// Some S3 implementations returns 404 Not Found on deleting with a non-existent key
			s3Mock.on(DeleteObjectCommand)
				.rejects(new NoSuchKey({ $metadata: {}, message: 'allowed error.' }));

			await driveService.deleteObjectStorageFile('lol no way');
		});
	});

	describe('Folder file counts', () => {
		let db: DataSource;
		let idService: IdService;
		let usersRepository: UsersRepository;
		let driveFoldersRepository: DriveFoldersRepository;
		let driveFilesRepository: DriveFilesRepository;

		async function createUser(): Promise<MiUser> {
			const id = idService.gen();
			const username = secureRndstr(16);
			await usersRepository.insert({ id, username, usernameLower: username.toLowerCase() });
			return await usersRepository.findOneByOrFail({ id });
		}

		async function createFolders(user: MiUser, count: number): Promise<MiDriveFolder[]> {
			const folders: MiDriveFolder[] = [];
			for (let i = 0; i < count; i++) {
				const id = idService.gen();
				await driveFoldersRepository.insert({ id, name: secureRndstr(8), userId: user.id, parentId: null });
				folders.push(await driveFoldersRepository.findOneByOrFail({ id }));
			}
			return folders.sort((a, b) => (a.id < b.id ? -1 : 1));
		}

		async function createFile(user: MiUser, folder: MiDriveFolder): Promise<MiDriveFile> {
			const id = idService.gen();
			await driveFilesRepository.insert({ id, userId: user.id, userHost: null, md5: secureRndstr(32), name: `file-${id}`, type: 'text/plain', size: 1, storedInternal: true, url: `https://example.com/${id}`, accessKey: secureRndstr(16), folderId: folder.id });
			return await driveFilesRepository.findOneByOrFail({ id });
		}

		async function countsOf(folders: MiDriveFolder[]): Promise<number[]> {
			const rows: { id: string; filesCount: number }[] = await db.query('SELECT "id", "filesCount" FROM "drive_folder" WHERE "id" = ANY($1) ORDER BY "id"', [folders.map(folder => folder.id)]);
			return rows.map(row => row.filesCount);
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

		async function whileHoldingFolder(folder: MiDriveFolder, run: () => Promise<unknown>, blockedAt: RegExp, then: (holder: QueryRunner) => Promise<unknown>): Promise<unknown> {
			const holder = db.createQueryRunner();
			await holder.connect();
			try {
				await holder.startTransaction('READ COMMITTED');
				await holder.query('SELECT 1 FROM "drive_folder" WHERE "id" = $1 FOR NO KEY UPDATE', [folder.id]);
				const running = run().then(() => 'done', (e: unknown) => String(e));
				await waitUntilBlockedBy(holder, blockedAt);
				await then(holder);
				await holder.commitTransaction();
				return await running;
			} finally {
				if (holder.isTransactionActive) await holder.rollbackTransaction();
				await holder.release();
			}
		}

		beforeAll(async () => {
			db = app.get(DI.db);
			idService = app.get(IdService);
			usersRepository = app.get(DI.usersRepository);
			driveFoldersRepository = app.get(DI.driveFoldersRepository);
			driveFilesRepository = app.get(DI.driveFilesRepository);
			await db.query('DROP FUNCTION IF EXISTS "drive_file_sync_folder_files_count"() CASCADE');
			await db.query('ALTER TABLE "drive_folder" DROP COLUMN "filesCount"');
			await new DriveFolderFilesCountCounter1792429514514().up(db);
		});

		afterAll(async () => {
			await db.query('DROP FUNCTION IF EXISTS "drive_file_sync_folder_files_count"() CASCADE');
		});

		test('a move of a file to a folder with a smaller id counts the folders in id order, so that a move in the opposite direction is not deadlocked', async () => {
			const user = await createUser();
			const [lower, higher] = await createFolders(user, 2);
			const down = await createFile(user, higher);
			const up = await createFile(user, lower);

			expect(await whileHoldingFolder(lower, () => driveFilesRepository.update(down.id, { folderId: lower.id }), /^UPDATE "drive_file"/, async holder => {
				await holder.query('UPDATE "drive_file" SET "folderId" = $2 WHERE "id" = $1', [up.id, higher.id]);
			})).toBe('done');

			expect(await countsOf([lower, higher])).toEqual([1, 1]);
		});

		test('moving files out of several folders locks the files and then the folders in id order before it moves them, so that a move of another file between those folders is not deadlocked', async () => {
			const user = await createUser();
			const [first, second, third] = await createFolders(user, 3);
			const moved = [await createFile(user, first), await createFile(user, second)];
			const other = await createFile(user, second);

			expect(await whileHoldingFolder(second, () => driveService.moveFiles(moved.map(file => file.id), third.id, user.id), /"drive_f/, async holder => {
				await holder.query('UPDATE "drive_file" SET "folderId" = $2 WHERE "id" = $1', [other.id, third.id]);
			})).toBe('done');

			expect(await countsOf([first, second, third])).toEqual([0, 0, 3]);
		});
	});
});
