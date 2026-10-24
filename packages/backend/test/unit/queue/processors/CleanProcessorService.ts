/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { DataSource } from 'typeorm';
import { CoreModule } from '@/core/CoreModule.js';
import { IdService } from '@/core/IdService.js';
import { QueueService } from '@/core/QueueService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { CleanProcessorService } from '@/queue/processors/CleanProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import type { MiUser, UserProfilesRepository, UsersRepository } from '@/models/_.js';

describe('CleanProcessorService', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let service: CleanProcessorService;
	let queueService: QueueService;
	let idService: IdService;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;

	const createdUserIds: MiUser['id'][] = [];

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		createdUserIds.push(id);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function jobsOf(users: MiUser[]) {
		const jobs = await queueService.dbQueue.getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
		return jobs.filter(job => users.some(user => user.id === job.data.user.id)).sort((a, b) => (a.id ?? '').localeCompare(b.id ?? ''));
	}

	function catalogAs(row: { relkind?: string; version?: number }, failing?: string) {
		const query = dbLong.query.bind(dbLong) as (...args: unknown[]) => Promise<unknown>;
		return vi.spyOn(dbLong as unknown as { query: (...args: unknown[]) => Promise<unknown> }, 'query').mockImplementation(async (...args) => {
			if (args[0] === failing) throw new Error(`${failing} failed`);
			const rows = await query(...args);
			return String(args[0]).includes('server_version_num') ? (rows as object[]).map(x => ({ ...x, ...row })) : rows;
		});
	}

	function analyzed(calls: unknown[][]): string[] {
		return calls.map(([sql]) => String(sql)).filter(sql => sql.startsWith('ANALYZE'));
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				CleanProcessorService,
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
		dbLong = app.get(DI.dbLong);
		service = app.get(CleanProcessorService);
		queueService = app.get(QueueService);
		idService = app.get(IdService);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
	});

	afterEach(async () => {
		for (const userId of createdUserIds) {
			await queueService.dbQueue.remove(`purgeAccount-${userId}`);
		}
	});

	afterAll(async () => {
		await app.close();
	});

	test('queues one purge per deleted local user and nothing for the others, also when it runs again', async () => {
		const deleted = [await createUser({ isDeleted: true }), await createUser({ isDeleted: true })];
		const others = [
			await createUser(),
			await createUser({ host: 'remote.example.com', isDeleted: true }),
			await createUser({ host: 'remote.example.com' }),
		];
		const expected = deleted
			.map(user => ({ name: 'purgeAccount', id: `purgeAccount-${user.id}`, data: { user: { id: user.id } } }))
			.sort((a, b) => a.id.localeCompare(b.id));

		await service.process();
		const first = await jobsOf([...deleted, ...others]);
		await service.process();
		const second = await jobsOf([...deleted, ...others]);

		expect(first.map(job => ({ name: job.name, id: job.id, data: job.data }))).toEqual(expected);
		expect(second.map(job => ({ name: job.name, id: job.id, data: job.data }))).toEqual(expected);
		expect(second.map(job => job.timestamp)).toEqual(first.map(job => job.timestamp));
		for (const job of second) {
			expect(await job.isDelayed()).toBe(true);
			expect(job.opts.delay).toBeGreaterThanOrEqual(1000 * 60 * 60 * 48);
		}
	});

	test('queues the purge again with the full delay once the queue lost it', async () => {
		const target = await createUser({ isDeleted: true });
		const jobId = `purgeAccount-${target.id}`;

		await service.process();
		expect((await jobsOf([target])).map(job => job.id)).toEqual([jobId]);
		await queueService.dbQueue.remove(jobId);
		expect(await jobsOf([target])).toEqual([]);

		await service.process();

		const [job] = await jobsOf([target]);
		expect(job).toMatchObject({ name: 'purgeAccount', id: jobId, data: { user: { id: target.id } } });
		expect(await job.isDelayed()).toBe(true);
		expect(job.opts.delay).toBeGreaterThanOrEqual(1000 * 60 * 60 * 48);
	});

	test('analyzes the parents of note and note_reaction on DI.dbLong while they are partitioned', async () => {
		const longQuery = catalogAs({ relkind: 'p' });
		const query = vi.spyOn(db, 'query');

		await service.process();

		expect(analyzed(longQuery.mock.calls)).toEqual(['ANALYZE ONLY "note"', 'ANALYZE ONLY "note_reaction"']);
		expect(analyzed(query.mock.calls)).toEqual([]);
	});

	test('does not analyze the parents while note and note_reaction are plain tables', async () => {
		const longQuery = vi.spyOn(dbLong, 'query');
		const [{ relkind }]: { relkind: string }[] = await db.query('SELECT relkind FROM pg_class WHERE oid = \'note\'::regclass');
		expect(relkind).toBe('r');

		await service.process();

		expect(analyzed(longQuery.mock.calls)).toEqual([]);
	});

	test('does not analyze the parents before PostgreSQL 18', async () => {
		const longQuery = catalogAs({ relkind: 'p', version: 170000 });

		await service.process();

		expect(analyzed(longQuery.mock.calls)).toEqual([]);
	});

	test('a failed analyze is logged and leaves the other steps and the other parent done', async () => {
		const target = await createUser({ isDeleted: true });
		const longQuery = catalogAs({ relkind: 'p' }, 'ANALYZE ONLY "note"');
		const logger = (service as unknown as { logger: { warn: (message: string) => void; succ: (message: string) => void } }).logger;
		const warn = vi.spyOn(logger, 'warn');
		const succ = vi.spyOn(logger, 'succ');

		await service.process();

		expect(analyzed(longQuery.mock.calls)).toEqual(['ANALYZE ONLY "note"', 'ANALYZE ONLY "note_reaction"']);
		expect(warn).toHaveBeenCalledWith('ANALYZE ONLY note failed: Error: ANALYZE ONLY "note" failed');
		expect(succ).toHaveBeenCalledWith('Cleaned.');
		expect((await jobsOf([target])).map(job => job.id)).toEqual([`purgeAccount-${target.id}`]);
	});
});
