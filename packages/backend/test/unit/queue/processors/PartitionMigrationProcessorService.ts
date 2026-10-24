/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import Fastify, { type FastifyInstance } from 'fastify';
import { DataSource, type EntityManager, type QueryRunner } from 'typeorm';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { IdService } from '@/core/IdService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { PARTITION_COUNT } from '@/misc/partition.js';
import { alterPartitionCopies, assertPartitionCopiesMatch } from '@/misc/partition-copies.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { PartitionMigrationProcessorService } from '@/queue/processors/PartitionMigrationProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import UsersReactions from '@/server/api/endpoints/users/reactions.js';
import type { Config } from '@/config.js';
import type { MiMeta, MiNote, MiNoteReaction, MiUser, NoteReactionsRepository, NotesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import { NoteReactionLocator1792429514524 } from '../../../../migration/1792429514524-noteReactionLocator.js';
import type * as Bull from 'bullmq';

vi.mock('@/misc/partition.js', async importOriginal => {
	const original = await importOriginal<typeof import('@/misc/partition.js')>();
	const count = 4;
	const last = original.ordinalToPrefix(count - 1);
	return {
		...original,
		PARTITION_COUNT: count,
		ordinalToPrefix: (ord: number) => {
			if (ord >= count) throw new Error(`ordinal out of range: ${ord}`);
			return original.ordinalToPrefix(ord);
		},
		nextPrefix: (prefix: string) => original.prefixToOrdinal(prefix) + 1 >= count ? null : original.nextPrefix(prefix),
		prefixesAscending: (fromPrefix?: string, toPrefix?: string) => original.prefixesAscending(fromPrefix, toPrefix ?? last),
		prefixesDescending: (fromPrefix?: string, toPrefix?: string) => original.prefixesDescending(fromPrefix ?? last, toPrefix),
	};
});

const prePhases = [
	'reactionNoteIdIdIndex',
	'noteUriBackfill',
	'noteInvertedRelationUnlink',
	'noteRelationBackfill',
	'notePendingParentBackfill',
	'userNoteIdFloorIndex',
	'userNoteIdFloorBackfill',
];

const syncFunctions = ['note_sync_to_p', 'note_sync_to_old', 'note_reaction_sync_to_p', 'note_reaction_sync_to_old'];

const locatorFunctions = ['note_reaction_locator_insert', 'note_reaction_locator_delete', 'note_reaction_locator_update'];

const lookupIndexes = ['IDX_NOTE_REACTION_ID', 'IDX_NOTE_REACTION_USER_ID_ID'];

const parentOrderPhases = ['noteParentOrderPlain', 'noteParentOrderPartitioned'];

const parentOrderTriggers = ['note_parent_order_insert', 'note_parent_order_update'];

const parentOrderViolation = 'refers to a parent that is not older than itself';

type IndexStatement = { kind: string; name: string; prefix: string | null };

function createJob(logs: string[] = []): Bull.Job {
	return { log: async (row: string) => logs.push(row) } as unknown as Bull.Job;
}

function inspector(db: DataSource) {
	return {
		async relkind(name: string): Promise<string | null> {
			const rows: { relkind: string }[] = await db.query('SELECT relkind FROM pg_class WHERE oid = to_regclass($1)', [name]);
			return rows.length > 0 ? rows[0].relkind : null;
		},
		async indexNames(table: string): Promise<string[]> {
			const rows: { indexname: string }[] = await db.query('SELECT indexname FROM pg_indexes WHERE schemaname = \'public\' AND tablename = $1 ORDER BY indexname', [table]);
			return rows.map(row => row.indexname);
		},
		async index(name: string): Promise<{ table: string; unique: boolean; valid: boolean; attached: boolean; body: string } | null> {
			const rows: { table: string; unique: boolean; valid: boolean; attached: boolean; body: string }[] = await db.query(`
				SELECT i.indrelid::regclass::text AS "table", i.indisunique AS "unique", i.indisvalid AS "valid",
					EXISTS (SELECT 1 FROM pg_inherits inh WHERE inh.inhrelid = i.indexrelid) AS "attached",
					substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') AS "body"
				FROM pg_index i
				JOIN pg_class c ON c.oid = i.indexrelid
				WHERE c.relname = $1 AND c.relnamespace = 'public'::regnamespace
			`, [name]);
			return rows.length > 0 ? rows[0] : null;
		},
		async primaryKey(table: string): Promise<string> {
			const [{ conname }]: { conname: string }[] = await db.query('SELECT conname FROM pg_constraint WHERE conrelid = $1::regclass AND contype = \'p\'', [table]);
			return conname;
		},
		async syncFunction(table: string): Promise<string | null> {
			const rows: { proname: string }[] = await db.query(
				'SELECT p.proname FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::regclass AND t.tgname = $2',
				[table, `${table}_sync`],
			);
			return rows.length > 0 ? rows[0].proname : null;
		},
		async syncTriggers(): Promise<string[]> {
			const rows: { tbl: string }[] = await db.query('SELECT tgrelid::regclass::text AS "tbl" FROM pg_trigger WHERE tgname IN (\'note_sync\', \'note_reaction_sync\') ORDER BY 1');
			return rows.map(row => row.tbl);
		},
		async functions(): Promise<string[]> {
			const rows: { proname: string }[] = await db.query('SELECT proname FROM pg_proc WHERE proname = ANY($1) ORDER BY proname', [syncFunctions]);
			return rows.map(row => row.proname);
		},
		async located(): Promise<{ id: string; noteId: string; userId: string }[]> {
			return await db.query('SELECT "id", "noteId", "userId" FROM "note_reaction_locator" ORDER BY "id"');
		},
		async crossPrefixReactions(table: string): Promise<{ id: string; noteId: string; userId: string }[]> {
			return await db.query(`SELECT "id", "noteId", "userId" FROM "${table}" WHERE left("id", 2) <> left("noteId", 2) ORDER BY "id"`);
		},
		async locatorTriggers(): Promise<string[]> {
			const rows: { name: string }[] = await db.query('SELECT tgrelid::regclass::text || \'.\' || tgname AS "name" FROM pg_trigger WHERE tgname LIKE \'note\\_reaction\\_locator\\_%\' AND tgparentid = 0 ORDER BY 1');
			return rows.map(row => row.name);
		},
		async parentOrderTriggers(): Promise<string[]> {
			const rows: { name: string }[] = await db.query('SELECT tgrelid::regclass::text || \'.\' || tgname AS "name" FROM pg_trigger WHERE tgname = ANY($1)', [parentOrderTriggers]);
			return rows.map(row => row.name).sort();
		},
		async indexesWithBody(body: string): Promise<string[]> {
			const rows: { name: string }[] = await db.query(`
				SELECT c.relname AS "name"
				FROM pg_index i
				JOIN pg_class c ON c.oid = i.indexrelid
				WHERE c.relnamespace = 'public'::regnamespace AND substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') = $1
			`, [body]);
			return rows.map(row => row.name).sort();
		},
		async indexesOn(table: string, bodies: string[]): Promise<string[]> {
			const rows: { name: string }[] = await db.query(`
				SELECT c.relname AS "name"
				FROM pg_index i
				JOIN pg_class c ON c.oid = i.indexrelid
				WHERE i.indrelid = $1::regclass AND substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') = ANY($2)
			`, [table, bodies]);
			return rows.map(row => row.name).sort();
		},
		async state(name: string): Promise<Record<string, unknown>> {
			const rows: { state: Record<string, unknown> }[] = await db.query('SELECT "state" FROM "partition_migration_state" WHERE "name" = $1', [name]);
			return rows.length > 0 ? rows[0].state : {};
		},
	};
}

async function leaveState(db: DataSource, name: string, state: Record<string, unknown>): Promise<void> {
	await db.query('INSERT INTO "partition_migration_state" ("name", "state") VALUES ($1, $2) ON CONFLICT ("name") DO UPDATE SET "state" = EXCLUDED."state"', [name, state]);
}

async function waitUntilBlockedBy(db: DataSource, holder: QueryRunner, statement: RegExp): Promise<void> {
	const [{ pid }]: { pid: number }[] = await holder.query('SELECT pg_backend_pid() AS "pid"');
	for (let i = 0; i < 100; i++) {
		const blocked: { query: string }[] = await db.query('SELECT "query" FROM "pg_stat_activity" WHERE $1 = ANY(pg_blocking_pids("pid"))', [pid]);
		if (blocked.some(row => statement.test(row.query))) return;
		await setTimeout(50);
	}
	throw new Error('timed out');
}

type Phase = (job: Bull.Job, deadline: number) => Promise<boolean>;

async function whileBuilding(db: DataSource, build: string, run: Phase): Promise<boolean | 'waiting'> {
	const holder = db.createQueryRunner();
	const builder = db.createQueryRunner();
	await holder.connect();
	await builder.connect();
	let running: Promise<boolean> | null = null;
	try {
		await holder.startTransaction('REPEATABLE READ');
		await holder.query('SELECT count(*) FROM "user"');
		const building = builder.query(build);
		for (let i = 0; ; i++) {
			const builds: unknown[] = await db.query('SELECT 1 FROM pg_stat_progress_create_index WHERE phase = \'waiting for old snapshots\'');
			if (builds.length > 0) break;
			if (i > 200) throw new Error('the build did not start');
			await setTimeout(25);
		}
		running = run(createJob(), Date.now() + 60_000);
		const during = await Promise.race([running, setTimeout(3000).then(() => 'waiting' as const)]);
		await holder.commitTransaction();
		await building;
		return during;
	} finally {
		if (holder.isTransactionActive) await holder.rollbackTransaction();
		await running;
		await holder.release();
		await builder.release();
	}
}

async function createShadows(db: DataSource): Promise<void> {
	await db.query('CREATE TABLE "note_p" (LIKE "note" INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING COMMENTS) PARTITION BY RANGE ("id")');
	await db.query('ALTER TABLE "note_p" ADD PRIMARY KEY ("id")');
	await db.query('CREATE TABLE "note_reaction_p" (LIKE "note_reaction" INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING COMMENTS) PARTITION BY RANGE ("noteId")');
	await db.query('ALTER TABLE "note_reaction_p" ADD PRIMARY KEY ("noteId", "id")');
	await new NoteReactionLocator1792429514524().up(db);
	for (const name of prePhases) {
		await db.query('INSERT INTO "partition_migration_state" ("name", "finishedAt") VALUES ($1, now())', [name]);
	}
}

async function addOutwardForeignKeys(db: DataSource, note = 'note', noteReaction = 'note_reaction'): Promise<void> {
	await db.query(`ALTER TABLE "${note}" ADD CONSTRAINT "FK_5b87d9d19127bd5d92026017a7b" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	await db.query(`ALTER TABLE "${note}" ADD CONSTRAINT "FK_f22169eb10657bded6d875ac8f9" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	await db.query(`ALTER TABLE "${note}" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9" FOREIGN KEY ("anonymouslySendToUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	await db.query(`ALTER TABLE "${noteReaction}" ADD CONSTRAINT "FK_13761f64257f40c5636d0ff95ee" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
}

async function outwardForeignKeys(db: DataSource): Promise<string[]> {
	const rows: { name: string }[] = await db.query(
		'SELECT conrelid::regclass::text || \'.\' || conname AS "name" FROM pg_constraint WHERE contype = \'f\' AND conrelid IN (SELECT oid FROM pg_class WHERE relname IN (\'note\', \'note_old\', \'note_reaction\', \'note_reaction_old\')) AND confrelid IN (\'user\'::regclass, \'channel\'::regclass) ORDER BY 1',
	);
	return rows.map(row => row.name);
}

async function inheritedStatistics(db: DataSource, table: string): Promise<number> {
	const [{ count }]: { count: number }[] = await db.query('SELECT count(*)::int AS "count" FROM pg_stats WHERE schemaname = \'public\' AND tablename = $1 AND inherited', [table]);
	return count;
}

async function locksOn(em: EntityManager, table: string): Promise<string[]> {
	const rows: { name: string }[] = await em.query(`
		WITH tables AS (
			SELECT $1::regclass::oid AS "oid"
			UNION ALL
			SELECT inhrelid FROM pg_inherits WHERE inhparent = $1::regclass
		)
		SELECT l.relation::regclass::text AS "name"
		FROM pg_locks l
		WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
			AND l.relation IN (SELECT "oid" FROM tables UNION ALL SELECT i.indexrelid FROM pg_index i WHERE i.indrelid IN (SELECT "oid" FROM tables))
		ORDER BY 1
	`, [table]);
	return rows.map(row => row.name);
}

async function dropSyncFunctions(db: DataSource): Promise<void> {
	await db.query('DROP FUNCTION IF EXISTS "test_noop"() CASCADE');
	for (const name of [...syncFunctions, ...locatorFunctions, 'note_parent_order']) {
		await db.query(`DROP FUNCTION IF EXISTS ${name}() CASCADE`);
	}
}

async function expectParentOrderEnforced(db: DataSource, live: string, standby: string, userId: string, [early, middle, late]: string[]): Promise<void> {
	const [{ sync }]: { sync: string }[] = await db.query('SELECT p.proname AS "sync" FROM pg_trigger t JOIN pg_proc p ON p.oid = t.tgfoid WHERE t.tgrelid = $1::regclass AND t.tgname = \'note_sync\'', [live]);
	const insert = async (table: string, id: string, replyId: string | null, renoteId: string | null) => await db.query(`INSERT INTO "${table}" ("id", "userId", "visibility", "replyId", "renoteId") VALUES ($1, $2, 'public', $3, $4)`, [id, userId, replyId, renoteId]);
	const update = async (table: string, id: string, column: string, value: string) => await db.query(`UPDATE "${table}" SET "${column}" = $2 WHERE "id" = $1`, [id, value]);
	const copiesOf = async (id: string) => ({
		live: await db.query(`SELECT "replyId", "renoteId", "text" FROM "${live}" WHERE "id" = $1`, [id]),
		standby: await db.query(`SELECT "replyId", "renoteId", "text" FROM "${standby}" WHERE "id" = $1`, [id]),
	});
	const toggle = async (tables: string[], action: 'ENABLE' | 'DISABLE', triggers: string[]) => {
		for (const table of tables) {
			for (const trigger of triggers) await db.query(`ALTER TABLE "${table}" ${action} TRIGGER "${trigger}"`);
		}
	};
	const throughSync = { message: expect.stringContaining(parentOrderViolation), driverError: expect.objectContaining({ where: expect.stringContaining(`PL/pgSQL function ${sync}()`) }) };

	await insert(live, early, UNREFERENCEABLE_NOTE_ID, null);
	await expect(insert(live, middle, middle, null)).rejects.toThrow(parentOrderViolation);
	await expect(insert(live, middle, null, late)).rejects.toThrow(parentOrderViolation);
	await expect(insert(standby, middle, late, null)).rejects.toThrow(parentOrderViolation);
	await expect(update(live, early, 'replyId', early)).rejects.toThrow(parentOrderViolation);
	await expect(update(standby, early, 'renoteId', late)).rejects.toThrow(parentOrderViolation);

	await toggle([live], 'DISABLE', parentOrderTriggers);
	try {
		await expect(insert(live, middle, null, middle)).rejects.toMatchObject(throughSync);
		await expect(update(live, early, 'replyId', late)).rejects.toMatchObject(throughSync);
	} finally {
		await toggle([live], 'ENABLE', parentOrderTriggers);
	}
	expect(await copiesOf(early)).toEqual({ live: [{ replyId: UNREFERENCEABLE_NOTE_ID, renoteId: null, text: null }], standby: [{ replyId: UNREFERENCEABLE_NOTE_ID, renoteId: null, text: null }] });
	expect(await copiesOf(middle)).toEqual({ live: [], standby: [] });

	await toggle([live, standby], 'DISABLE', ['note_parent_order_insert']);
	try {
		await insert(live, middle, middle, null);
	} finally {
		await toggle([live, standby], 'ENABLE', ['note_parent_order_insert']);
	}
	await update(live, middle, 'text', 'edited');
	await update(live, middle, 'replyId', middle);
	await expect(update(live, middle, 'renoteId', late)).rejects.toThrow(parentOrderViolation);
	expect(await copiesOf(middle)).toEqual({ live: [{ replyId: middle, renoteId: null, text: 'edited' }], standby: [{ replyId: middle, renoteId: null, text: 'edited' }] });
	await update(live, middle, 'replyId', UNREFERENCEABLE_NOTE_ID);
	expect(await copiesOf(middle)).toEqual({ live: [{ replyId: UNREFERENCEABLE_NOTE_ID, renoteId: null, text: 'edited' }], standby: [{ replyId: UNREFERENCEABLE_NOTE_ID, renoteId: null, text: 'edited' }] });

	await db.query(`DELETE FROM "${live}" WHERE "id" = ANY($1)`, [[early, middle]]);
	expect(await copiesOf(middle)).toEqual({ live: [], standby: [] });
}

function queueLoggerServiceMock() {
	return {
		provide: QueueLoggerService,
		useFactory: () => ({
			logger: {
				createSubLogger: () => ({ info: vi.fn(), warn: vi.fn(), succ: vi.fn(), error: vi.fn() }),
			},
		}),
	};
}

describe('PartitionMigrationProcessorService', () => {
	let app: TestingModule;
	let fastify: FastifyInstance;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let apResolverService: ApResolverService;
	let usersReactions: UsersReactions;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let notesRepository: NotesRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let catalog: ReturnType<typeof inspector>;
	let originalIndexes: { note: string[]; note_reaction: string[] };
	let originalPrimaryKeys: { note: string; note_reaction: string };
	let coveredReactionIndexes: string[];
	let reactor: MiUser;
	let author: MiUser;
	const earlyReactions: MiNoteReaction[] = [];

	async function createUser(): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase() });
		await userProfilesRepository.insert({ userId: id, publicReactions: true });
		return await usersRepository.findOneByOrFail({ id });
	}

	function idInPrefix(ord: number): string {
		return idService.gen(946684800000 + ord * 36 ** 6 + 1000 + Math.floor(Math.random() * 1000000));
	}

	async function createNote(id = idService.gen()): Promise<MiNote> {
		await notesRepository.insert({ id, text: `note_${id}`, userId: author.id, userHost: null, visibility: 'public' });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function createReaction(note: MiNote, user: MiUser, reaction = '👍'): Promise<MiNoteReaction> {
		const id = idService.gen();
		await noteReactionsRepository.insert({ id, noteId: note.id, userId: user.id, reaction });
		return await noteReactionsRepository.findOneByOrFail({ id });
	}

	async function runJob(logs: string[] = []): Promise<string[]> {
		await service.process(createJob(logs));
		return logs;
	}

	async function oldFormatLookups(reaction: MiNoteReaction) {
		const listed: { id: string }[] = await usersReactions.exec({ userId: reactor.id, limit: 100 }, null, null);
		const served = await fastify.inject({
			method: 'GET',
			url: `/likes/${reaction.id}`,
			headers: { accept: 'application/activity+json' },
		});
		const resolver = await apResolverService.createResolver();
		const resolved = await resolver.resolve(`${config.url}/likes/${reaction.id}`).then(object => object.id, () => null);
		return { listed: listed.map(x => x.id), status: served.statusCode, resolved };
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				PartitionMigrationProcessorService,
				ActivityPubServerService,
				{ provide: 'ep:users/reactions', useClass: UsersReactions },
				queueLoggerServiceMock(),
			],
		}).compile();
		await app.init();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		apResolverService = app.get(ApResolverService);
		usersReactions = app.get('ep:users/reactions');
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		notesRepository = app.get(DI.notesRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		catalog = inspector(db);

		app.get<MiMeta>(DI.meta).federation = 'all';
		fastify = Fastify();
		await fastify.register(app.get(ActivityPubServerService).createServer);
		await fastify.ready();

		await dropSyncFunctions(db);
		await createShadows(db);
		await addOutwardForeignKeys(db);
		originalIndexes = { note: await catalog.indexNames('note'), note_reaction: await catalog.indexNames('note_reaction') };
		originalPrimaryKeys = { note: await catalog.primaryKey('note'), note_reaction: await catalog.primaryKey('note_reaction') };
		coveredReactionIndexes = await catalog.indexesOn('note_reaction', ['USING btree ("userId")', 'USING btree ("noteId")']);

		author = await createUser();
		reactor = await createUser();
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await fastify.close();
		await app.close();
	});

	test('the configuration defaults to the partitioned copies and keeps the other copies', () => {
		expect(config.partitionMigration).toEqual({ liveTable: 'partitioned', dropOldTables: false });
	});

	test('the phases run in order without restoring the foreign keys to note', async () => {
		const names: string[] = [];
		const finished = vi.spyOn(service as unknown as { isFinished: (name: string) => Promise<boolean> }, 'isFinished').mockImplementation(async name => {
			names.push(name);
			return true;
		});
		const switchCopies = vi.spyOn(service as unknown as { switchCopies: () => Promise<boolean> }, 'switchCopies').mockResolvedValue(false);

		await runJob();

		expect(switchCopies).toHaveBeenCalledTimes(2);
		finished.mockRestore();
		expect(names.slice(names.indexOf('reactionNoteIdIdIndex'))).toEqual([
			'reactionNoteIdIdIndex',
			'noteUriBackfill',
			'noteInvertedRelationUnlink',
			'noteParentOrderPlain',
			'noteRelationBackfill',
			'notePendingParentBackfill',
			'userNoteIdFloorIndex',
			'userNoteIdFloorBackfill',
			'notePrepare',
			'noteBackfill',
			'noteParentOrderPartitioned',
			'outwardForeignKeysDrop',
			'noteIndexes',
			'noteCutover',
			'noteAnalyze',
			'reactionPrepare',
			'reactionBackfill',
			'reactionIndexes',
			'reactionLocatorFill',
			'reactionLookupIndexes',
			'noteReactionCutover',
			'reactionForeignKeys',
			'reactionAnalyze',
		]);
	});

	test('a job log that fails once Redis is lost does not surface as an unhandled rejection', async () => {
		const rejections: unknown[] = [];
		const onRejection = (reason: unknown) => rejections.push(reason);
		const logs: string[] = [];
		const job = {
			log: (row: string) => {
				logs.push(row);
				return Promise.reject(new Error('Missing key for job partitionMigration. addLog'));
			},
		} as unknown as Bull.Job;
		const holder = db.createQueryRunner();
		await holder.connect();
		process.on('unhandledRejection', onRejection);
		try {
			await holder.query('SELECT pg_advisory_lock($1)', [1787152817411]);
			await service.process(job);
			await holder.query('SELECT pg_advisory_unlock($1)', [1787152817411]);

			vi.spyOn(service as unknown as { isFinished: (name: string) => Promise<boolean> }, 'isFinished').mockResolvedValue(false);
			vi.spyOn(service as unknown as { runReactionNoteIdIdIndex: Phase }, 'runReactionNoteIdIdIndex').mockResolvedValue(false);
			await service.process(job);
			await setTimeout(100);
		} finally {
			process.off('unhandledRejection', onRejection);
			await holder.query('SELECT pg_advisory_unlock_all()');
			await holder.release();
		}

		expect(logs).toEqual(['another run is in progress', 'suspended at reactionNoteIdIdIndex']);
		expect(rejections).toEqual([]);
	});

	test('old reaction ids are read from the plain copy before the cutover', async () => {
		const note = await createNote();
		earlyReactions.push(await createReaction(note, reactor));
		earlyReactions.push(await createReaction(await createNote(idInPrefix(1)), reactor));

		expect(await catalog.locatorTriggers()).toEqual(locatorFunctions.map(name => `note_reaction_p.${name}`).sort());
		expect(await oldFormatLookups(earlyReactions[0])).toEqual({
			listed: [earlyReactions[1].id, earlyReactions[0].id],
			status: 200,
			resolved: `${config.url}/likes/${earlyReactions[0].noteId}/${earlyReactions[0].id}`,
		});
	});

	test('the first run builds the partitioned copies without the indexes that another index of the copy covers and switches both tables to them on DI.dbLong except for the switches', async () => {
		for (const ord of [0, 1, 2]) {
			const note = await createNote(idInPrefix(ord));
			await createReaction(note, author);
		}
		const notes = await notesRepository.count();
		const reactions = await noteReactionsRepository.count();
		expect(await outwardForeignKeys(db)).toEqual([
			'note.FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9',
			'note.FK_5b87d9d19127bd5d92026017a7b',
			'note.FK_f22169eb10657bded6d875ac8f9',
			'note_reaction.FK_13761f64257f40c5636d0ff95ee',
		]);
		const query = vi.spyOn(db, 'query');
		const transaction = vi.spyOn(db, 'transaction');
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		expect(query.mock.calls.filter(([, , runner]) => runner == null)).toEqual([]);
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(longQuery.mock.calls.some(([sql]) => sql.includes('CREATE INDEX CONCURRENTLY'))).toBe(true);
		expect(longQuery.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('ANALYZE ONLY'))).toEqual(['ANALYZE ONLY "note"', 'ANALYZE ONLY "note_reaction"']);
		expect(logs).toContain('note switched to the partitioned copy');
		expect(logs).toContain('note_reaction switched to the partitioned copy');
		expect(logs.indexOf('phase outwardForeignKeysDrop finished')).toBeLessThan(logs.indexOf('note switched to the partitioned copy'));
		expect(logs.indexOf('phase noteParentOrderPlain finished')).toBeLessThan(logs.indexOf('phase noteParentOrderPartitioned finished'));
		expect(logs.indexOf('phase noteParentOrderPartitioned finished')).toBeLessThan(logs.indexOf('note switched to the partitioned copy'));
		expect(await catalog.parentOrderTriggers()).toEqual(['note', 'note_old', 'note_p_00', 'note_p_01', 'note_p_02', 'note_p_03'].flatMap(table => parentOrderTriggers.map(name => `${table}.${name}`)));
		expect(await outwardForeignKeys(db)).toEqual([]);
		expect(await inheritedStatistics(db, 'note')).toBeGreaterThan(0);
		expect(await inheritedStatistics(db, 'note_reaction')).toBeGreaterThan(0);
		expect(coveredReactionIndexes).toHaveLength(2);
		expect(logs.filter(row => row.startsWith('adding') || row.startsWith('dropping'))).toEqual([]);
		const liveIndexes = { note: originalIndexes.note, note_reaction: [...originalIndexes.note_reaction.filter(name => !coveredReactionIndexes.includes(name)), ...lookupIndexes].sort() };
		for (const table of ['note', 'note_reaction'] as const) {
			expect(await catalog.relkind(table)).toBe('p');
			expect(await catalog.relkind(`${table}_old`)).toBe('r');
			expect(await catalog.relkind(`${table}_p`)).toBe(null);
			expect(await catalog.syncFunction(table)).toBe(`${table}_sync_to_old`);
			expect(await catalog.indexNames(table)).toEqual(liveIndexes[table]);
			expect(await catalog.indexNames(`${table}_old`)).toEqual(originalIndexes[table].map(name => `${name}_old`).sort());
			expect(await catalog.primaryKey(table)).toBe(originalPrimaryKeys[table]);
		}
		for (const name of lookupIndexes) {
			const parent = await catalog.index(name);
			expect(parent).toMatchObject({ table: 'note_reaction', unique: false, valid: true });
			for (const prefix of ['00', '01', '02', '03']) {
				expect(await catalog.index(`${name}_mig_${prefix}`)).toEqual({ ...parent, table: `note_reaction_p_${prefix}`, attached: true });
			}
		}
		expect(logs.indexOf('phase reactionLookupIndexes finished')).toBeLessThan(logs.indexOf('note_reaction switched to the partitioned copy'));
		expect(await catalog.locatorTriggers()).toEqual(locatorFunctions.map(name => `note_reaction.${name}`).sort());
		expect((await catalog.crossPrefixReactions('note_reaction_old')).length).toBe(4);
		expect(await catalog.located()).toEqual(await catalog.crossPrefixReactions('note_reaction_old'));
		expect(await catalog.syncTriggers()).toEqual([
			'note', 'note_p_00', 'note_p_01', 'note_p_02', 'note_p_03',
			'note_reaction', 'note_reaction_p_00', 'note_reaction_p_01', 'note_reaction_p_02', 'note_reaction_p_03',
		]);
		expect(await db.query('SELECT 1 FROM pg_constraint WHERE contype = \'f\' AND confrelid IN (\'note\'::regclass, \'note_old\'::regclass)')).toHaveLength(0);
		expect(await db.query('SELECT to_regclass(\'note_swap_pending_fk\')::text AS "pending"')).toEqual([{ pending: null }]);
		expect(await notesRepository.count()).toBe(notes);
		expect(await noteReactionsRepository.count()).toBe(reactions);
		expect(await db.query('SELECT count(*)::int AS "count" FROM "note_old"')).toEqual([{ count: notes }]);
		expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_old"')).toEqual([{ count: reactions }]);
		expect(await assertPartitionCopiesMatch(db)).toBeUndefined();
	}, 180_000);

	test('the locator fill adds the rows the locator lacks, resumes where a run was cut short and changes nothing when it runs again', async () => {
		const expected = await catalog.crossPrefixReactions('note_reaction_old');
		await db.query('DELETE FROM "note_reaction_locator"');
		await leaveState(db, 'reactionLocatorFill', {});
		const fill = (service as unknown as { runReactionLocatorFill: (job: Bull.Job, deadline: number) => Promise<boolean> }).runReactionLocatorFill;
		const longQuery = vi.spyOn(dbLong, 'query');
		const fills = () => longQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO "note_reaction_locator"')).length;
		const realNow = Date.now;
		const now = vi.spyOn(Date, 'now').mockImplementation(() => fills() >= 2 ? Number.MAX_SAFE_INTEGER : realNow());

		expect(await fill(createJob(), realNow() + 60_000)).toBe(false);
		now.mockRestore();

		expect(fills()).toBe(2);
		expect(await catalog.state('reactionLocatorFill')).toEqual({ ord: 2 });
		expect(await catalog.located()).toEqual(expected.filter(row => row.noteId < '02'));

		expect(await fill(createJob(), Date.now() + 60_000)).toBe(true);
		expect(fills()).toBe(PARTITION_COUNT);
		expect(await catalog.located()).toEqual(expected);

		await leaveState(db, 'reactionLocatorFill', {});
		expect(await fill(createJob(), Date.now() + 60_000)).toBe(true);
		expect(await catalog.located()).toEqual(expected);
	});

	test('writes on the partitioned copies are mirrored into the plain copies', async () => {
		const note = await createNote(idInPrefix(2));
		const reaction = await createReaction(note, reactor);
		expect(await db.query('SELECT "text" FROM "note_old" WHERE "id" = $1', [note.id])).toEqual([{ text: note.text }]);
		expect(await db.query('SELECT "reaction" FROM "note_reaction_old" WHERE "id" = $1', [reaction.id])).toEqual([{ reaction: '👍' }]);

		await notesRepository.update({ id: note.id }, { text: 'edited' });
		await noteReactionsRepository.update({ noteId: note.id, id: reaction.id }, { reaction: '🎉' });
		expect(await db.query('SELECT "text" FROM "note_old" WHERE "id" = $1', [note.id])).toEqual([{ text: 'edited' }]);
		expect(await db.query('SELECT "reaction" FROM "note_reaction_old" WHERE "id" = $1', [reaction.id])).toEqual([{ reaction: '🎉' }]);

		expect(await db.query('SELECT "noteId", "userId" FROM "note_reaction_locator" WHERE "id" = $1', [reaction.id])).toEqual([{ noteId: note.id, userId: reactor.id }]);
		await noteReactionsRepository.delete({ noteId: note.id, id: reaction.id });
		await notesRepository.delete({ id: note.id });
		expect(await db.query('SELECT 1 FROM "note_old" WHERE "id" = $1', [note.id])).toHaveLength(0);
		expect(await db.query('SELECT 1 FROM "note_reaction_old" WHERE "id" = $1', [reaction.id])).toHaveLength(0);
		expect(await db.query('SELECT 1 FROM "note_reaction_locator" WHERE "id" = $1', [reaction.id])).toHaveLength(0);
	});

	test('the parent order triggers of the live partitioned copy and the plain copy reject a parent that is not older than the note, also through the sync, and let the other updates of such a note through', async () => {
		const t = Date.now();
		await expectParentOrderEnforced(db, 'note', 'note_old', author.id, [t, t + 1, t + 2].map(time => idService.gen(time)));
	});

	test('a type change of the columns that the parent order and locator triggers read succeeds on every copy with the triggers in place, except on a partition key', async () => {
		const triggers = { parentOrder: await catalog.parentOrderTriggers(), locator: await catalog.locatorTriggers() };
		const runner = db.createQueryRunner();
		await runner.connect();
		try {
			await runner.startTransaction();
			for (const column of ['replyId', 'renoteId', 'userId']) await alterPartitionCopies(runner, 'note', `ALTER COLUMN "${column}" TYPE varchar(64)`);
			await runner.query('ALTER TABLE "note_old" ALTER COLUMN "id" TYPE varchar(64)');
			for (const column of ['id', 'userId']) await alterPartitionCopies(runner, 'note_reaction', `ALTER COLUMN "${column}" TYPE varchar(64)`);
			await runner.query('ALTER TABLE "note_reaction_old" ALTER COLUMN "noteId" TYPE varchar(64)');
			const types: { name: string }[] = await runner.query(`
				SELECT attrelid::regclass::text || '.' || attname || ' ' || format_type(atttypid, atttypmod) AS "name"
				FROM pg_attribute
				WHERE attrelid = ANY($1::regclass[]) AND attname = ANY($2) AND NOT attisdropped
			`, [['note', 'note_old', 'note_reaction', 'note_reaction_old'], ['id', 'replyId', 'renoteId', 'userId', 'noteId']]);
			expect(types.map(row => row.name).sort()).toEqual([
				'note.id character varying(32)',
				...['note.renoteId', 'note.replyId', 'note.userId', 'note_old.id', 'note_old.renoteId', 'note_old.replyId', 'note_old.userId'].map(name => `${name} character varying(64)`),
				'note_reaction.id character varying(64)',
				'note_reaction.noteId character varying(32)',
				...['note_reaction.userId', 'note_reaction_old.id', 'note_reaction_old.noteId', 'note_reaction_old.userId'].map(name => `${name} character varying(64)`),
			]);
		} finally {
			await runner.rollbackTransaction();
			await runner.release();
		}
		for (const [table, column] of [['note', 'id'], ['note_reaction', 'noteId']] as const) {
			const keyed = db.createQueryRunner();
			await keyed.connect();
			try {
				await keyed.startTransaction();
				await expect(alterPartitionCopies(keyed, table, `ALTER COLUMN "${column}" TYPE varchar(64)`)).rejects.toThrow(`cannot alter column "${column}" because it is part of the partition key of relation "${table}"`);
			} finally {
				await keyed.rollbackTransaction();
				await keyed.release();
			}
		}
		expect({ parentOrder: await catalog.parentOrderTriggers(), locator: await catalog.locatorTriggers() }).toEqual(triggers);
		expect(triggers.parentOrder).toHaveLength(2 * (2 + PARTITION_COUNT));
		expect(triggers.locator).toEqual(locatorFunctions.map(name => `note_reaction.${name}`).sort());
	});

	test('the outward foreign keys of plain copies that are no longer live are dropped before any switch runs', async () => {
		await addOutwardForeignKeys(db, 'note_old', 'note_reaction_old');
		await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'outwardForeignKeysDrop\'');
		expect(await outwardForeignKeys(db)).toEqual([
			'note_old.FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9',
			'note_old.FK_5b87d9d19127bd5d92026017a7b',
			'note_old.FK_f22169eb10657bded6d875ac8f9',
			'note_reaction_old.FK_13761f64257f40c5636d0ff95ee',
		]);
		const switchCopies = vi.spyOn(service as unknown as { switchCopies: () => Promise<boolean> }, 'switchCopies');
		config.partitionMigration.liveTable = 'plain';
		let logs: string[] = [];
		try {
			logs = await runJob();
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
		}

		expect(logs).toContain('phase outwardForeignKeysDrop finished');
		expect(switchCopies).not.toHaveBeenCalled();
		expect(await outwardForeignKeys(db)).toEqual([]);
		for (const table of ['note', 'note_reaction'] as const) {
			expect(await catalog.relkind(table)).toBe('p');
			expect(await catalog.relkind(`${table}_old`)).toBe('r');
			expect(await catalog.syncFunction(table)).toBe(`${table}_sync_to_old`);
		}
	});

	test('old reaction ids are read from the partitioned copy after the cutover, including reactions made after it', async () => {
		const late = await createReaction(await createNote(), reactor);

		expect(await oldFormatLookups(late)).toEqual({
			listed: [late.id, earlyReactions[1].id, earlyReactions[0].id],
			status: 200,
			resolved: `${config.url}/likes/${late.noteId}/${late.id}`,
		});
		expect((await oldFormatLookups(earlyReactions[0])).status).toBe(200);
	});

	test('alterPartitionCopies changes every copy and the sync functions in one transaction', async () => {
		const runner = db.createQueryRunner();
		await runner.connect();
		try {
			await runner.startTransaction();
			await alterPartitionCopies(runner, 'note', 'ADD "testColumn" integer');
			await alterPartitionCopies(runner, 'note_reaction', 'ADD "testColumn" integer');
			await runner.commitTransaction();
		} finally {
			await runner.release();
		}
		await assertPartitionCopiesMatch(db);

		const note = await createNote(idInPrefix(1));
		const reaction = await createReaction(note, reactor);
		await db.query('UPDATE "note" SET "testColumn" = 7 WHERE "id" = $1', [note.id]);
		await db.query('UPDATE "note_reaction" SET "testColumn" = 8 WHERE "noteId" = $1 AND "id" = $2', [note.id, reaction.id]);
		expect(await db.query('SELECT "testColumn" FROM "note_old" WHERE "id" = $1', [note.id])).toEqual([{ testColumn: 7 }]);
		expect(await db.query('SELECT "testColumn" FROM "note_reaction_old" WHERE "id" = $1', [reaction.id])).toEqual([{ testColumn: 8 }]);
		expect(await catalog.located()).toEqual(await catalog.crossPrefixReactions('note_reaction_old'));

		const reverter = db.createQueryRunner();
		await reverter.connect();
		try {
			await reverter.startTransaction();
			await alterPartitionCopies(reverter, 'note_reaction', 'DROP COLUMN "testColumn"');
			await alterPartitionCopies(reverter, 'note', 'DROP COLUMN "testColumn"');
			await reverter.commitTransaction();
		} finally {
			await reverter.release();
		}
		await assertPartitionCopiesMatch(db);
		await createReaction(await createNote(), reactor);
		expect(await db.query('SELECT 1 FROM pg_attribute WHERE attrelid IN (\'note_reaction_old\'::regclass, \'note_old\'::regclass) AND attname = \'testColumn\'')).toHaveLength(0);
	});

	test('copies whose columns differ fail the writes, the startup check and every switch', async () => {
		await db.query('ALTER TABLE "note_reaction" ADD "testColumn" integer');
		try {
			await expect(assertPartitionCopiesMatch(db)).rejects.toThrow('The columns of note_reaction and note_reaction_old differ (testColumn)');
			const note = await createNote();
			await expect(noteReactionsRepository.insert({ id: idService.gen(), noteId: note.id, userId: reactor.id, reaction: '👍' })).rejects.toThrow();

			config.partitionMigration.liveTable = 'plain';
			const logs = await runJob();
			expect(logs).toContain('schema mismatch between note_reaction and note_reaction_old: testColumn');
			expect(await catalog.relkind('note_reaction')).toBe('p');
			expect(await catalog.relkind('note')).toBe('p');
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
			await db.query('ALTER TABLE "note_reaction" DROP COLUMN "testColumn"');
		}
		await assertPartitionCopiesMatch(db);
	});

	test('a switch waits until every prefix of the two copies holds the same number of rows', async () => {
		const strayNoteId = idInPrefix(1);
		const strayId = idService.gen();
		await db.query('INSERT INTO "note_reaction_old" ("id", "noteId", "userId", "reaction") VALUES ($1, $2, $3, \'👍\')', [strayId, strayNoteId, reactor.id]);
		const [{ count }]: { count: number }[] = await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_p_01"');
		config.partitionMigration.liveTable = 'plain';
		try {
			const logs = await runJob();

			expect(logs).toContain(`parity mismatch at note_reaction_p_01: note_reaction_old=${count + 1} note_reaction_p_01=${count}`);
			expect(logs).toContain('note is switched to the plain copy after note_reaction');
			expect(await catalog.relkind('note_reaction')).toBe('p');
			expect(await catalog.relkind('note')).toBe('p');
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
			await db.query('DELETE FROM "note_reaction_old" WHERE "id" = $1', [strayId]);
		}
	});

	test('liveTable plain switches note_reaction and then note back to the plain copies under their original names, after installing the parent order triggers again on both note copies that lost them', async () => {
		for (const table of ['note', 'note_old']) {
			for (const name of parentOrderTriggers) await db.query(`DROP TRIGGER "${name}" ON "${table}"`);
		}
		expect(await catalog.parentOrderTriggers()).toEqual([]);
		config.partitionMigration.liveTable = 'plain';
		const logs = await runJob();

		expect(logs.indexOf('note_reaction switched to the plain copy')).toBeGreaterThanOrEqual(0);
		expect(logs.indexOf('note switched to the plain copy')).toBeGreaterThan(logs.indexOf('note_reaction switched to the plain copy'));
		expect(logs.filter(row => row.startsWith('adding'))).toEqual([]);
		expect(logs.filter(row => row.startsWith('dropping'))).toEqual([]);
		const reinstalled = ['note', 'note_old'].map(table => `installing the parent order triggers on ${table} again before switching note`);
		expect(logs.filter(row => row.startsWith('installing'))).toEqual(reinstalled);
		expect(logs.indexOf(reinstalled[1])).toBeLessThan(logs.indexOf('note switched to the plain copy'));
		expect(await catalog.parentOrderTriggers()).toEqual(['note', 'note_p', 'note_p_00', 'note_p_01', 'note_p_02', 'note_p_03'].flatMap(table => parentOrderTriggers.map(name => `${table}.${name}`)));
		const liveIndexes = { note: originalIndexes.note, note_reaction: originalIndexes.note_reaction };
		const standbyIndexes = { note: originalIndexes.note, note_reaction: [...originalIndexes.note_reaction.filter(name => !coveredReactionIndexes.includes(name)), ...lookupIndexes] };
		expect(await catalog.indexesOn('note_reaction', ['USING btree ("userId", id)'])).toEqual([]);
		for (const table of ['note', 'note_reaction'] as const) {
			expect(await catalog.relkind(table)).toBe('r');
			expect(await catalog.relkind(`${table}_p`)).toBe('p');
			expect(await catalog.relkind(`${table}_old`)).toBe(null);
			expect(await catalog.syncFunction(table)).toBe(`${table}_sync_to_p`);
			expect(await catalog.indexNames(table)).toEqual(liveIndexes[table]);
			expect(await catalog.indexNames(`${table}_p`)).toEqual(standbyIndexes[table].map(name => `${name}_mig`).sort());
			expect(await catalog.primaryKey(table)).toBe(originalPrimaryKeys[table]);
		}
		expect(await catalog.functions()).toEqual(['note_reaction_sync_to_p', 'note_sync_to_p']);
		expect(await catalog.locatorTriggers()).toEqual(locatorFunctions.map(name => `note_reaction_p.${name}`).sort());
		const lookups = await oldFormatLookups(earlyReactions[1]);
		expect(lookups.status).toBe(200);
		expect(lookups.listed).toEqual((await db.query('SELECT "id" FROM "note_reaction" WHERE "userId" = $1 ORDER BY "id" DESC', [reactor.id])).map((row: { id: string }) => row.id));
	});

	test('writes on the plain copies are mirrored into the partitioned copies', async () => {
		const note = await createNote(idInPrefix(0));
		const reaction = await createReaction(note, reactor);
		expect(await db.query('SELECT "text" FROM "note_p_00" WHERE "id" = $1', [note.id])).toEqual([{ text: note.text }]);
		expect(await db.query('SELECT "reaction" FROM "note_reaction_p_00" WHERE "id" = $1', [reaction.id])).toEqual([{ reaction: '👍' }]);
		expect(await db.query('SELECT "noteId", "userId" FROM "note_reaction_locator" WHERE "id" = $1', [reaction.id])).toEqual([{ noteId: note.id, userId: reactor.id }]);

		await notesRepository.update({ id: note.id }, { text: 'edited' });
		await noteReactionsRepository.update({ id: reaction.id }, { reaction: '🎉' });
		expect(await db.query('SELECT "text" FROM "note_p" WHERE "id" = $1', [note.id])).toEqual([{ text: 'edited' }]);
		expect(await db.query('SELECT "reaction" FROM "note_reaction_p" WHERE "noteId" = $1 AND "id" = $2', [note.id, reaction.id])).toEqual([{ reaction: '🎉' }]);

		await noteReactionsRepository.delete({ id: reaction.id });
		await notesRepository.delete({ id: note.id });
		expect(await db.query('SELECT 1 FROM "note_p" WHERE "id" = $1', [note.id])).toHaveLength(0);
		expect(await db.query('SELECT 1 FROM "note_reaction_p" WHERE "noteId" = $1 AND "id" = $2', [note.id, reaction.id])).toHaveLength(0);
		expect(await db.query('SELECT 1 FROM "note_reaction_locator" WHERE "id" = $1', [reaction.id])).toHaveLength(0);
	});

	test('an index that the live plain copy no longer has is dropped from the partitioned copy before the switch together with the children that no parent will attach, while the lookup indexes stay and the indexes covered by another one are neither added nor missed', async () => {
		const align = (service as unknown as { alignStandby: (job: Bull.Job, deadline: number, table: string, standby: string, toPartitioned: boolean) => Promise<boolean> }).alignStandby;
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		const coveredBodies = ['USING btree ("userId")', 'USING btree ("noteId")'];
		const standbyIndexes = await catalog.indexNames('note_reaction_p');
		expect(standbyIndexes).toEqual(expect.arrayContaining(lookupIndexes.map(name => `${name}_mig`)));
		expect(await catalog.indexesOn('note_reaction', coveredBodies)).toEqual(coveredReactionIndexes);
		expect(await catalog.indexesOn('note_reaction_p', coveredBodies)).toEqual([]);
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_DROPPED" ON "note_reaction" ("noteId", "reaction")');
		try {
			const added: string[] = [];
			expect(await align(createJob(added), Date.now() + 60_000, 'note_reaction', 'note_reaction_p', true)).toBe(true);
			expect(added).toEqual(['adding IDX_TEST_DROPPED of note_reaction to note_reaction_p']);
			expect(await catalog.index('IDX_TEST_DROPPED_mig')).toMatchObject({ table: 'note_reaction_p', unique: true, valid: true });

			await db.query('DROP INDEX "IDX_TEST_DROPPED"');
			await db.query('CREATE INDEX "IDX_TEST_PENDING" ON "note_reaction" ("noteId", "userId", "reaction")');
			await db.query('CREATE INDEX "IDX_TEST_PENDING_mig_01" ON "note_reaction_p_01" ("noteId", "userId", "reaction")');
			await db.query('CREATE UNIQUE INDEX "IDX_TEST_LEFTOVER_mig_01" ON "note_reaction_p_01" ("noteId", "reaction")');
			await expect(db.transaction(async em => await assertAligned(em, 'note_reaction', 'note_reaction_p', true))).rejects.toThrow('note_reaction_p is not aligned with note_reaction: note_reaction_p lacks IDX_TEST_PENDING, note_reaction_p has IDX_TEST_DROPPED_mig, which note_reaction does not have, note_reaction_p has IDX_TEST_LEFTOVER_mig_01, which note_reaction does not have');
			const longQuery = vi.spyOn(dbLong, 'query');
			const logs: string[] = [];

			expect(await align(createJob(logs), Date.now() + 60_000, 'note_reaction', 'note_reaction_p', true)).toBe(true);

			expect(logs).toEqual([
				'dropping IDX_TEST_DROPPED_mig, IDX_TEST_LEFTOVER_mig_01 of note_reaction_p, which note_reaction does not have',
				'adding IDX_TEST_PENDING of note_reaction to note_reaction_p',
			]);
			expect(longQuery.mock.calls.filter(([sql]) => sql.startsWith('DROP INDEX')).map(([sql, , runner]) => [sql, runner != null])).toEqual([
				['DROP INDEX IF EXISTS "IDX_TEST_DROPPED_mig"', true],
				['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_LEFTOVER_mig_01"', false],
			]);
			expect(longQuery.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('IDX_TEST_PENDING_mig_01'))).toEqual(['ALTER INDEX "IDX_TEST_PENDING_mig" ATTACH PARTITION "IDX_TEST_PENDING_mig_01"']);
			expect(await catalog.indexesWithBody('USING btree ("noteId", reaction)')).toEqual([]);
			expect(await catalog.index('IDX_TEST_PENDING_mig_01')).toMatchObject({ table: 'note_reaction_p_01', valid: true, attached: true });
			expect(await catalog.indexNames('note_reaction_p')).toEqual([...standbyIndexes, 'IDX_TEST_PENDING_mig'].sort());
			expect(await catalog.indexesOn('note_reaction_p', coveredBodies)).toEqual([]);
			await db.transaction(async em => await assertAligned(em, 'note_reaction', 'note_reaction_p', true));

			const note = await createNote(idInPrefix(1));
			for (const user of [author, await createUser()]) {
				await noteReactionsRepository.insert({ id: idService.gen(), noteId: note.id, userId: user.id, reaction: '👍' });
			}
			expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_p" WHERE "noteId" = $1', [note.id])).toEqual([{ count: 2 }]);
		} finally {
			for (const name of ['IDX_TEST_DROPPED', 'IDX_TEST_DROPPED_mig', 'IDX_TEST_LEFTOVER_mig_01', 'IDX_TEST_PENDING', 'IDX_TEST_PENDING_mig', 'IDX_TEST_PENDING_mig_01']) {
				await db.query(`DROP INDEX IF EXISTS "${name}"`);
			}
		}
		expect(await catalog.indexNames('note_reaction_p')).toEqual(standbyIndexes);
	});

	test('a switch that fails part way leaves both copies as they were and keeps no parity progress for the retry', async () => {
		config.partitionMigration.liveTable = 'partitioned';
		await db.query('CREATE FUNCTION "test_noop"() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NULL; END $$');
		await db.query('CREATE TRIGGER "note_sync" AFTER INSERT ON "note_p" FOR EACH ROW EXECUTE FUNCTION "test_noop"()');

		const failed = await runJob();

		expect(failed.some(row => row.startsWith('switching note to the partitioned copy: attempt 1 failed:') && row.includes('already exists'))).toBe(true);
		expect(failed).toContain('note_reaction is switched to the partitioned copy after note');
		expect(await catalog.relkind('note')).toBe('r');
		expect(await catalog.relkind('note_p')).toBe('p');
		expect(await catalog.syncFunction('note')).toBe('note_sync_to_p');
		expect(await catalog.indexNames('note')).toEqual(originalIndexes.note);
		expect(await catalog.indexNames('note_p')).toEqual(originalIndexes.note.map(name => `${name}_mig`).sort());
		expect(await catalog.functions()).toEqual(['note_reaction_sync_to_p', 'note_sync_to_p']);
		expect(await catalog.relkind('note_reaction')).toBe('r');
		expect(await catalog.state('noteSwitch')).toMatchObject({ attempts: 1 });
		expect(await catalog.state('noteParity')).toEqual({});

		await db.query('DROP TRIGGER "note_sync" ON "note_p"');
		const waiting = await runJob();
		expect(waiting).not.toContain('note switched to the partitioned copy');
		expect(await catalog.relkind('note')).toBe('r');
	});

	test('a retry after the backoff counts every prefix again and stops on a row written into the standby since the failure', async () => {
		const strayId = idInPrefix(1);
		const [{ count }]: { count: number }[] = await db.query('SELECT count(*)::int AS "count" FROM "note_p_01"');
		await db.query('INSERT INTO "note_p" ("id", "userId", "visibility") VALUES ($1, $2, \'public\')', [strayId, author.id]);
		try {
			await db.query('UPDATE "partition_migration_state" SET "state" = jsonb_set("state", \'{nextAttemptAt}\', \'0\') WHERE "name" = \'noteSwitch\'');
			const logs = await runJob();

			expect(logs).toContain(`parity mismatch at note_p_01: note=${count} note_p_01=${count + 1}`);
			expect(logs).not.toContain('note switched to the partitioned copy');
			expect(await catalog.relkind('note')).toBe('r');
			expect(await catalog.relkind('note_reaction')).toBe('r');
		} finally {
			await db.query('DELETE FROM "note_p" WHERE "id" = $1', [strayId]);
		}
	});

	test('a retried switch whose job dies right after the commit leaves no parity or switch progress behind', async () => {
		const states = (service as unknown as { partitionMigrationStatesRepository: { upsert: (...args: unknown[]) => Promise<unknown> } }).partitionMigrationStatesRepository;
		const upsert = vi.spyOn(states, 'upsert');
		const transaction = db.transaction.bind(db) as unknown as (...args: unknown[]) => Promise<unknown>;
		vi.spyOn(db as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }, 'transaction').mockImplementationOnce(async (...args) => {
			const result = await transaction(...args);
			upsert.mockRejectedValue(new Error('the job died'));
			return result;
		});
		const died: string[] = [];

		await expect(runJob(died)).rejects.toThrow('the job died');
		upsert.mockRestore();

		expect(died).toContain('note switched to the partitioned copy');
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('r');
		expect(await catalog.state('noteSwitch')).toEqual({});
		expect(await catalog.state('noteParity')).toEqual({});

		const retried = await runJob();

		expect(retried).toContain('note_reaction switched to the partitioned copy');
		const liveIndexes = { note: originalIndexes.note, note_reaction: [...originalIndexes.note_reaction.filter(name => !coveredReactionIndexes.includes(name)), ...lookupIndexes].sort() };
		const standbyIndexes = { note: originalIndexes.note, note_reaction: originalIndexes.note_reaction };
		expect(await catalog.indexesOn('note_reaction_old', ['USING btree ("userId", id)'])).toEqual([]);
		for (const table of ['note', 'note_reaction'] as const) {
			expect(await catalog.relkind(table)).toBe('p');
			expect(await catalog.relkind(`${table}_old`)).toBe('r');
			expect(await catalog.syncFunction(table)).toBe(`${table}_sync_to_old`);
			expect(await catalog.indexNames(table)).toEqual(liveIndexes[table]);
			expect(await catalog.indexNames(`${table}_old`)).toEqual(standbyIndexes[table].map(name => `${name}_old`).sort());
			expect(await catalog.primaryKey(table)).toBe(originalPrimaryKeys[table]);
		}
		expect(await catalog.state('noteSwitch')).toEqual({});
		expect(await catalog.located()).toEqual(await catalog.crossPrefixReactions('note_reaction_old'));
	});

	test('a run after a switch whose state was left behind settles it without switching again', async () => {
		await leaveState(db, 'noteParity', { ord: 2 });
		await leaveState(db, 'reactionSwitch', { attempts: 2, nextAttemptAt: Date.now() + 1000 * 60 * 60 });

		const logs = await runJob();

		expect(logs.filter(row => row.includes('switched'))).toEqual([]);
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('p');
		expect(await catalog.state('noteParity')).toEqual({});
		expect(await catalog.state('reactionSwitch')).toEqual({});
	});

	test('a switch back after a switch whose parity progress was left behind still counts every prefix', async () => {
		await leaveState(db, 'noteParity', { ord: PARTITION_COUNT });
		await leaveState(db, 'reactionParity', { ord: PARTITION_COUNT });
		const strayId = idService.gen();
		await db.query('INSERT INTO "note_reaction_old" ("id", "noteId", "userId", "reaction") VALUES ($1, $2, $3, \'👍\')', [strayId, idInPrefix(1), reactor.id]);
		const [{ count }]: { count: number }[] = await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_p_01"');
		config.partitionMigration.liveTable = 'plain';
		try {
			const logs = await runJob();

			expect(logs).toContain(`parity mismatch at note_reaction_p_01: note_reaction_old=${count + 1} note_reaction_p_01=${count}`);
			expect(logs).not.toContain('note_reaction switched to the plain copy');
			expect(await catalog.relkind('note_reaction')).toBe('p');
			expect(await catalog.relkind('note')).toBe('p');
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
			await db.query('DELETE FROM "note_reaction_old" WHERE "id" = $1', [strayId]);
		}
	});

	test('dropOldTables removes the sync in a short transaction, and a job that dies before the plain copy is dropped leaves a copy that no switch accepts', async () => {
		config.partitionMigration.dropOldTables = true;
		const transaction = vi.spyOn(db, 'transaction');
		const query = vi.spyOn(db, 'query');
		const states = (service as unknown as { partitionMigrationStatesRepository: { upsert: (...args: unknown[]) => Promise<unknown> } }).partitionMigrationStatesRepository;
		const upsert = vi.spyOn(states, 'upsert');
		const longTransaction = dbLong.transaction.bind(dbLong) as unknown as (...args: unknown[]) => Promise<unknown>;
		const statements: string[] = [];
		vi.spyOn(dbLong as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }, 'transaction')
			.mockImplementationOnce(async (...args) => await longTransaction(...args))
			.mockImplementationOnce(async () => {
				statements.push(...query.mock.calls.filter(([, , runner]) => runner != null).map(([sql]) => sql));
				upsert.mockRejectedValue(new Error('the job died'));
				throw new Error('the job died');
			});
		const died: string[] = [];

		await expect(runJob(died)).rejects.toThrow('the job died');
		upsert.mockRestore();

		expect(query.mock.calls.filter(([, , runner]) => runner == null)).toEqual([]);
		expect(transaction).toHaveBeenCalledTimes(2);
		expect(statements.filter(sql => sql.startsWith('DROP'))).toEqual([
			'DROP TRIGGER IF EXISTS "note_sync" ON "note"',
			'DROP FUNCTION IF EXISTS note_sync_to_old()',
			'DROP TRIGGER IF EXISTS "note_reaction_sync" ON "note_reaction"',
			'DROP FUNCTION IF EXISTS note_reaction_sync_to_old()',
		]);
		expect(died).toContain('note_old dropped');
		expect(died).not.toContain('note_reaction_old dropped');
		expect(await catalog.relkind('note_old')).toBe(null);
		expect(await catalog.relkind('note_reaction_old')).toBe('r');
		expect(await catalog.syncTriggers()).toEqual([]);
		expect(await catalog.functions()).toEqual([]);
		expect(await catalog.locatorTriggers()).toEqual(locatorFunctions.map(name => `note_reaction.${name}`).sort());
		expect(await catalog.state('reactionDrop')).toEqual({});

		const logs: string[] = [];
		const switchCopies = (service as unknown as { switchCopies: (job: Bull.Job, deadline: number, table: string) => Promise<boolean> }).switchCopies;
		expect(await switchCopies(createJob(logs), Date.now() + 60_000, 'note_reaction')).toBe(false);
		expect(logs).toEqual(['cannot switch note_reaction: note_reaction_old is not synchronized']);
		expect(await catalog.relkind('note_reaction')).toBe('p');
	});

	test('the next run drops the plain copy on DI.dbLong without locking the live table', async () => {
		const note = await createNote(idInPrefix(0));
		const transaction = vi.spyOn(db, 'transaction');
		const runInTransaction = dbLong.transaction.bind(dbLong) as unknown as (run: (em: EntityManager) => Promise<unknown>) => Promise<unknown>;
		const held: string[][] = [];
		const longTransaction = vi.spyOn(dbLong as unknown as { transaction: (run: (em: EntityManager) => Promise<unknown>) => Promise<unknown> }, 'transaction').mockImplementation(async run => await runInTransaction(async em => {
			const result = await run(em);
			held.push(await locksOn(em, 'note_reaction'));
			return result;
		}));
		const reader = db.createQueryRunner();
		const writer = db.createQueryRunner();
		const writtenId = idService.gen();
		let logs: string[] = [];
		await reader.connect();
		await writer.connect();
		try {
			await reader.startTransaction();
			await reader.query('SELECT count(*) FROM "note_reaction_old"');
			const running = runJob();
			await waitUntilBlockedBy(db, reader, /^DROP TABLE "note_reaction_old"$/);

			await writer.startTransaction();
			await writer.query('SET LOCAL lock_timeout = \'1s\'');
			await writer.query('INSERT INTO "note_reaction" ("id", "noteId", "userId", "reaction") VALUES ($1, $2, $3, \'👍\')', [writtenId, note.id, reactor.id]);
			await writer.commitTransaction();

			await reader.commitTransaction();
			logs = await running;
		} finally {
			if (writer.isTransactionActive) await writer.rollbackTransaction();
			if (reader.isTransactionActive) await reader.rollbackTransaction();
			await writer.release();
			await reader.release();
		}

		expect(logs).toContain('note_reaction_old dropped');
		expect(transaction).not.toHaveBeenCalled();
		expect(longTransaction).toHaveBeenCalledTimes(1);
		expect(held).toEqual([[]]);
		expect(await noteReactionsRepository.existsBy({ noteId: note.id, id: writtenId })).toBe(true);
		expect(await catalog.relkind('note_reaction_old')).toBe(null);
		expect(await catalog.state('reactionDrop')).toEqual({});
		await assertPartitionCopiesMatch(db);

		await createReaction(await createNote(idInPrefix(0)), reactor);
		expect(await runJob()).not.toEqual(expect.arrayContaining([expect.stringContaining('dropped')]));
		const dropForeignKeys = (service as unknown as { runOutwardForeignKeysDrop: (job: Bull.Job, deadline: number) => Promise<boolean> }).runOutwardForeignKeysDrop;
		expect(await dropForeignKeys(createJob(), Date.now() + 60_000)).toBe(true);
	});

	test('old reaction ids are still found after the plain copies are dropped', async () => {
		for (const reaction of earlyReactions) {
			const lookups = await oldFormatLookups(reaction);
			expect(lookups.status).toBe(200);
			expect(lookups.resolved).toBe(`${config.url}/likes/${reaction.noteId}/${reaction.id}`);
			expect(lookups.listed).toEqual(expect.arrayContaining(earlyReactions.map(x => x.id)));
		}
		const missing = await fastify.inject({
			method: 'GET',
			url: `/likes/${idService.gen()}`,
			headers: { accept: 'application/activity+json' },
		});
		expect(missing.statusCode).toBe(404);

		const current = await fastify.inject({
			method: 'GET',
			url: `/likes/${earlyReactions[0].noteId}/${earlyReactions[0].id}`,
			headers: { accept: 'application/activity+json' },
		});
		expect(current.statusCode).toBe(200);
	});
});

describe('PartitionMigrationProcessorService with liveTable plain', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let notesRepository: NotesRepository;
	let catalog: ReturnType<typeof inspector>;
	let author: MiUser;

	async function createNote(): Promise<MiNote> {
		const id = idService.gen();
		await notesRepository.insert({ id, text: `note_${id}`, userId: author.id, userHost: null, visibility: 'public' });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function runJob(logs: string[] = []): Promise<string[]> {
		await service.process(createJob(logs));
		return logs;
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		notesRepository = app.get(DI.notesRepository);
		catalog = inspector(db);

		await dropSyncFunctions(db);
		await createShadows(db);
		const id = idService.gen();
		await app.get<UsersRepository>(DI.usersRepository).insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		author = await app.get<UsersRepository>(DI.usersRepository).findOneByOrFail({ id });
		config.partitionMigration = { liveTable: 'plain', dropOldTables: false };
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await app.close();
	});

	test('the partitioned copy is built and kept in sync without cutting over', async () => {
		await createNote();

		const logs = await runJob();

		expect(logs).toContain('note stays on the plain copy while partitionMigration.liveTable is plain');
		expect(logs).toContain('suspended at noteCutover');
		expect(await catalog.relkind('note')).toBe('r');
		expect(await catalog.relkind('note_p')).toBe('p');
		expect(await catalog.syncFunction('note')).toBe('note_sync_to_p');
		expect(await catalog.syncFunction('note_reaction')).toBe(null);
		expect(await catalog.indexNames('note_p')).toEqual((await catalog.indexNames('note')).map(name => name.startsWith('PK_') ? 'note_p_pkey' : `${name}_mig`).sort());

		const note = await createNote();
		await notesRepository.update({ id: note.id }, { text: 'edited' });
		expect(await db.query('SELECT "text" FROM "note_p" WHERE "id" = $1', [note.id])).toEqual([{ text: 'edited' }]);
		await notesRepository.delete({ id: note.id });
		expect(await db.query('SELECT 1 FROM "note_p" WHERE "id" = $1', [note.id])).toHaveLength(0);
	});

	test('the parent order triggers of the live plain copy and the partitioned copy reject a parent that is not older than the note, also through the sync, and let the other updates of such a note through', async () => {
		expect(await catalog.parentOrderTriggers()).toEqual(['note', 'note_p', 'note_p_00', 'note_p_01', 'note_p_02', 'note_p_03'].flatMap(table => parentOrderTriggers.map(name => `${table}.${name}`)));
		const t = Date.now();
		await expectParentOrderEnforced(db, 'note', 'note_p', author.id, [t, t + 1, t + 2].map(time => idService.gen(time)));
	});

	test('a stale index under the usual name is dropped from the partitioned copy even when another index serves the live one, and fails a switch in its transaction until then', async () => {
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		const align = (service as unknown as { alignStandby: (job: Bull.Job, deadline: number, table: string, standby: string, toPartitioned: boolean) => Promise<boolean> }).alignStandby;
		await db.query('CREATE INDEX "IDX_TEST_COVERED" ON "note" ("renoteUserHost")');
		await db.query('CREATE INDEX "IDX_TEST_COVERED_ELSEWHERE" ON "note_p" ("renoteUserHost")');
		await db.query('CREATE INDEX "IDX_TEST_COVERED_mig" ON "note_p" ("renoteUserHost", "visibility")');
		try {
			await expect(db.transaction(async em => await assertAligned(em, 'note', 'note_p', true))).rejects.toThrow(/^note_p is not aligned with note: note_p has the stale IDX_TEST_COVERED_mig$/);

			const logs: string[] = [];
			expect(await align(createJob(logs), Date.now() + 60_000, 'note', 'note_p', true)).toBe(true);

			expect(logs).toEqual(['dropping the stale IDX_TEST_COVERED_mig of note_p']);
			expect(await catalog.indexesWithBody('USING btree ("renoteUserHost", visibility)')).toEqual([]);
			expect(await catalog.index('IDX_TEST_COVERED_ELSEWHERE')).toMatchObject({ table: 'note_p', valid: true });
			await db.transaction(async em => await assertAligned(em, 'note', 'note_p', true));
		} finally {
			await db.query('DROP INDEX IF EXISTS "IDX_TEST_COVERED_mig"');
			await db.query('DROP INDEX "IDX_TEST_COVERED_ELSEWHERE"');
			await db.query('DROP INDEX "IDX_TEST_COVERED"');
		}
	});

	test('a prepare that runs again keeps a single sync trigger that still mirrors', async () => {
		const prepare = (service as unknown as { runNotePrepare: (job: Bull.Job, deadline: number) => Promise<boolean> }).runNotePrepare;
		expect(await prepare(createJob(), Date.now() + 60_000)).toBe(true);

		expect(await catalog.syncTriggers()).toEqual(['note']);
		const note = await createNote();
		expect(await db.query('SELECT 1 FROM "note_p" WHERE "id" = $1', [note.id])).toHaveLength(1);
	});

	test('a drop of the partitioned copy that fails after its sync trigger is removed leaves a copy that no switch accepts', async () => {
		config.partitionMigration.dropOldTables = true;
		await db.query('CREATE VIEW "test_blocker" AS SELECT * FROM "note_p"');

		const failed = await runJob();

		expect(failed.some(row => row.startsWith('dropping note_p: attempt 1 failed:'))).toBe(true);
		expect(await catalog.relkind('note_p')).toBe('p');
		expect(await catalog.syncFunction('note')).toBe(null);
		expect(await catalog.functions()).toEqual([]);

		config.partitionMigration.liveTable = 'partitioned';
		try {
			expect(await runJob()).toContain('cannot switch note: note_p is not synchronized');
			expect(await catalog.relkind('note')).toBe('r');
			expect(await catalog.relkind('note_p')).toBe('p');
		} finally {
			config.partitionMigration.liveTable = 'plain';
			await db.query('DROP VIEW "test_blocker"');
		}
	});

	test('the retried drop removes the partitioned copy on DI.dbLong while the live table stays writable', async () => {
		await db.query('UPDATE "partition_migration_state" SET "state" = jsonb_set("state", \'{nextAttemptAt}\', \'0\') WHERE "name" = \'noteDrop\'');
		const transaction = vi.spyOn(db, 'transaction');
		const runInTransaction = dbLong.transaction.bind(dbLong) as unknown as (run: (em: EntityManager) => Promise<unknown>) => Promise<unknown>;
		const held: string[][] = [];
		const longTransaction = vi.spyOn(dbLong as unknown as { transaction: (run: (em: EntityManager) => Promise<unknown>) => Promise<unknown> }, 'transaction').mockImplementation(async run => await runInTransaction(async em => {
			const result = await run(em);
			held.push(await locksOn(em, 'note'));
			return result;
		}));
		const reader = db.createQueryRunner();
		const writer = db.createQueryRunner();
		const writtenId = idService.gen();
		let logs: string[] = [];
		await reader.connect();
		await writer.connect();
		try {
			await reader.startTransaction();
			await reader.query('SELECT count(*) FROM "note_p"');
			const running = runJob();
			await waitUntilBlockedBy(db, reader, /^DROP TABLE "note_p"$/);

			await writer.startTransaction();
			await writer.query('SET LOCAL lock_timeout = \'1s\'');
			await writer.query('INSERT INTO "note" ("id", "userId", "visibility") VALUES ($1, $2, \'public\')', [writtenId, author.id]);
			await writer.commitTransaction();

			await reader.commitTransaction();
			logs = await running;
		} finally {
			if (writer.isTransactionActive) await writer.rollbackTransaction();
			if (reader.isTransactionActive) await reader.rollbackTransaction();
			await writer.release();
			await reader.release();
		}

		expect(logs).toContain('note_p dropped');
		expect(transaction).not.toHaveBeenCalled();
		expect(longTransaction).toHaveBeenCalledTimes(1);
		expect(held).toEqual([[]]);
		expect(await notesRepository.existsBy({ id: writtenId })).toBe(true);
		expect(await catalog.relkind('note_p')).toBe(null);
		expect(await catalog.relkind('note_p_00')).toBe(null);
		expect(await catalog.syncTriggers()).toEqual([]);
		expect(await catalog.functions()).toEqual([]);
		expect(await catalog.relkind('note_reaction_p')).toBe('p');
		expect(await catalog.locatorTriggers()).toEqual(locatorFunctions.map(name => `note_reaction_p.${name}`).sort());
		expect(await catalog.state('noteDrop')).toEqual({});

		await createNote();
		await assertPartitionCopiesMatch(db);
	});
});

describe('PartitionMigrationProcessorService around a switch', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let notesRepository: NotesRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let catalog: ReturnType<typeof inspector>;
	let author: MiUser;

	function idInPrefix(ord: number): string {
		return idService.gen(946684800000 + ord * 36 ** 6 + 1000 + Math.floor(Math.random() * 1000000));
	}

	async function createNote(id = idService.gen()): Promise<MiNote> {
		await notesRepository.insert({ id, text: `note_${id}`, userId: author.id, userHost: null, visibility: 'public' });
		return await notesRepository.findOneByOrFail({ id });
	}

	async function runJob(logs: string[] = []): Promise<string[]> {
		await service.process(createJob(logs));
		return logs;
	}

	function serviceMethod(name: string): (job: Bull.Job, deadline: number) => Promise<boolean> {
		return (service as unknown as Record<string, (job: Bull.Job, deadline: number) => Promise<boolean>>)[name];
	}

	function indexStatements(statements: string[]): IndexStatement[] {
		return statements.flatMap((sql): IndexStatement[] => {
			const parent = /^CREATE (?:UNIQUE )?INDEX IF NOT EXISTS "(.+)_mig" ON ONLY "note_p" /.exec(sql);
			if (parent != null) return [{ kind: 'parent', name: parent[1], prefix: null }];
			const child = /^CREATE (?:UNIQUE )?INDEX CONCURRENTLY IF NOT EXISTS "(.+)_mig_(\w\w)" ON "note_p_\2" /.exec(sql);
			if (child != null) return [{ kind: 'child', name: child[1], prefix: child[2] }];
			const attach = /^ALTER INDEX "(.+)_mig" ATTACH PARTITION "\1_mig_(\w\w)"$/.exec(sql);
			if (attach != null) return [{ kind: 'attach', name: attach[1], prefix: attach[2] }];
			const drop = /^DROP INDEX CONCURRENTLY IF EXISTS "(.+)_mig_(\w\w)"$/.exec(sql);
			if (drop != null) return [{ kind: 'drop', name: drop[1], prefix: drop[2] }];
			return [];
		});
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		notesRepository = app.get(DI.notesRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		catalog = inspector(db);

		await dropSyncFunctions(db);
		await createShadows(db);
		await addOutwardForeignKeys(db);
		const id = idService.gen();
		await app.get<UsersRepository>(DI.usersRepository).insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		author = await app.get<UsersRepository>(DI.usersRepository).findOneByOrFail({ id });
		config.partitionMigration = { liveTable: 'plain', dropOldTables: false };
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await app.close();
	});

	test('the outward foreign keys of the plain copies are dropped before any index is built, and a held lock makes the run stop and retry', async () => {
		const reader = db.createQueryRunner();
		await reader.connect();
		let logs: string[] = [];
		try {
			await reader.startTransaction();
			await reader.query('SELECT count(*) FROM "user"');
			logs = await runJob();
		} finally {
			if (reader.isTransactionActive) await reader.rollbackTransaction();
			await reader.release();
		}

		expect(logs.some(row => row.startsWith('dropping the foreign keys of note failed:') && row.includes('lock timeout'))).toBe(true);
		expect(logs).toContain('suspended at outwardForeignKeysDrop');
		expect(await outwardForeignKeys(db)).toEqual([
			'note.FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9',
			'note.FK_5b87d9d19127bd5d92026017a7b',
			'note.FK_f22169eb10657bded6d875ac8f9',
			'note_reaction.FK_13761f64257f40c5636d0ff95ee',
		]);
		expect(await catalog.indexNames('note_p')).toEqual(['note_p_pkey']);

		const drop = serviceMethod('runOutwardForeignKeysDrop');
		expect(await drop(createJob(), Date.now() + 60_000)).toBe(true);
		expect(await outwardForeignKeys(db)).toEqual([]);
		expect(await drop(createJob(), Date.now() + 60_000)).toBe(true);
	});

	test('a write held on the partitioned copy makes the index build stop and retry instead of queueing the writes behind it', async () => {
		const writer = db.createQueryRunner();
		await writer.connect();
		const logs: string[] = [];
		let built: boolean | undefined;
		try {
			await writer.startTransaction();
			await writer.query('INSERT INTO "note" ("id", "userId", "visibility") VALUES ($1, $2, \'public\')', [idInPrefix(0), author.id]);
			built = await serviceMethod('runNoteIndexes')(createJob(logs), Date.now() + 60_000);
		} finally {
			if (writer.isTransactionActive) await writer.rollbackTransaction();
			await writer.release();
		}

		expect(built).toBe(false);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS "\w+_mig" ON ONLY "note_p" .* failed: .*lock timeout/);
		expect(await catalog.indexNames('note_p')).toEqual(['note_p_pkey']);
	});

	test('the indexes are built prefix by prefix with every index of a prefix, and a run cut short resumes at the first missing child and rebuilds an invalid one', async () => {
		await createNote(idInPrefix(1));
		await createNote(idInPrefix(1));
		const indexes = (await catalog.indexNames('note')).filter(name => !name.startsWith('PK_'));
		const longQuery = vi.spyOn(dbLong, 'query');
		const isChild = (sql: string) => /^CREATE (UNIQUE )?INDEX CONCURRENTLY /.test(sql);
		const realNow = Date.now;
		const now = vi.spyOn(Date, 'now').mockImplementation(() => longQuery.mock.calls.filter(([sql]) => isChild(sql)).length > indexes.length ? Number.MAX_SAFE_INTEGER : realNow());

		const cut = await runJob();
		now.mockRestore();

		const first = indexStatements(longQuery.mock.calls.map(([sql]) => sql));
		expect(cut).toContain('phase outwardForeignKeysDrop finished');
		expect(cut).toContain('suspended at noteIndexes');
		expect(first.filter(x => x.kind === 'parent').map(x => x.name)).toEqual(indexes);
		expect(first.findIndex(x => x.kind !== 'parent')).toBe(indexes.length);
		expect(first.filter(x => x.kind === 'child')).toEqual([
			...indexes.map(name => ({ kind: 'child', name, prefix: '00' })),
			{ kind: 'child', name: indexes[0], prefix: '01' },
		]);
		expect(first.filter(x => x.kind === 'attach')).toEqual(first.filter(x => x.kind === 'child').map(x => ({ ...x, kind: 'attach' })));
		const locking = longQuery.mock.calls.filter(([sql]) => / ON ONLY | ATTACH PARTITION /.test(sql));
		expect(locking).toHaveLength(indexes.length * 2 + 1);
		expect(locking.every(([, , runner]) => runner != null)).toBe(true);
		expect(await catalog.index(`${indexes[0]}_mig`)).toMatchObject({ table: 'note_p', valid: false });

		const broken = `${indexes[1]}_mig_01`;
		await expect(db.query(`CREATE UNIQUE INDEX CONCURRENTLY "${broken}" ON "note_p_01" ("visibility")`)).rejects.toThrow();
		expect(await catalog.index(broken)).toMatchObject({ table: 'note_p_01', valid: false, attached: false });
		longQuery.mockClear();

		const resumed = await runJob();

		const second = indexStatements(longQuery.mock.calls.map(([sql]) => sql));
		expect(resumed).toContain('phase noteIndexes finished');
		expect(resumed).toContain('suspended at noteCutover');
		expect(second.filter(x => x.kind === 'parent')).toEqual([]);
		expect(second.filter(x => x.kind !== 'parent')).toEqual([
			...indexes.slice(1).flatMap(name => [
				...(name === indexes[1] ? [{ kind: 'drop', name, prefix: '01' }] : []),
				{ kind: 'child', name, prefix: '01' },
				{ kind: 'attach', name, prefix: '01' },
			]),
			...['02', '03'].flatMap(prefix => indexes.flatMap(name => [{ kind: 'child', name, prefix }, { kind: 'attach', name, prefix }])),
		]);
		for (const name of indexes) {
			const parent = await catalog.index(`${name}_mig`);
			expect(parent).toMatchObject({ table: 'note_p', valid: true });
			for (const prefix of ['00', '01', '02', '03']) {
				expect(await catalog.index(`${name}_mig_${prefix}`)).toEqual({ ...parent, table: `note_p_${prefix}`, attached: true });
			}
		}
	});

	test('a foreign key or a default that only one copy has stops the switch before any index or constraint is added', async () => {
		config.partitionMigration.liveTable = 'partitioned';
		const [{ original }]: { original: string }[] = await db.query('SELECT pg_get_expr(d.adbin, d.adrelid) AS "original" FROM pg_attrdef d JOIN pg_attribute a ON a.attrelid = d.adrelid AND a.attnum = d.adnum WHERE d.adrelid = \'note_p\'::regclass AND a.attname = \'renoteCount\'');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "test_check" CHECK ("renoteCount" >= 0)');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "test_fk" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE');
		await db.query('ALTER TABLE "note_p" ALTER COLUMN "renoteCount" SET DEFAULT 1');
		await db.query('CREATE INDEX "IDX_TEST_ALIGNED" ON "note" ("cw") WHERE "cw" IS NOT NULL');
		try {
			const logs = await runJob();

			expect(logs).toContain(`cannot switch note: only note has FOREIGN KEY ("channelId") REFERENCES channel(id) ON DELETE CASCADE, only note has column "renoteCount" default ${original}, only note_p has column "renoteCount" default 1`);
			expect(logs).toContain('suspended at noteCutover');
			expect(logs.filter(row => row.startsWith('adding'))).toEqual([]);
			expect(await catalog.relkind('note')).toBe('r');
			expect(await catalog.index('IDX_TEST_ALIGNED_mig')).toBe(null);
			expect(await db.query('SELECT 1 FROM pg_constraint WHERE conrelid = \'note_p\'::regclass AND contype = \'c\'')).toHaveLength(0);
		} finally {
			await db.query(`ALTER TABLE "note_p" ALTER COLUMN "renoteCount" SET DEFAULT ${original}`);
			await db.query('ALTER TABLE "note" DROP CONSTRAINT "test_fk"');
			await db.query('ALTER TABLE "note" DROP CONSTRAINT "test_check"');
		}
	});

	test('a foreign key that only the partitioned copy has stops the switch in its transaction as well', async () => {
		await db.query('ALTER TABLE "note_p" ADD CONSTRAINT "test_fk" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE');
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		try {
			await expect(db.transaction(async em => await assertAligned(em, 'note', 'note_p', true))).rejects.toThrow('only note_p has FOREIGN KEY ("channelId") REFERENCES channel(id) ON DELETE CASCADE');
		} finally {
			await db.query('ALTER TABLE "note_p" DROP CONSTRAINT "test_fk"');
		}
	});

	test('note is switched only after the parent order phases ran, a copy that lacks the parent order triggers gets them again before the switch, and the switch transaction refuses a copy without them', async () => {
		const switchCopies = (service as unknown as { switchCopies: (job: Bull.Job, deadline: number, table: string) => Promise<boolean> }).switchCopies;
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		const assertParentOrder = (service as unknown as { assertParentOrder: (em: EntityManager, tables: string[]) => Promise<void> }).assertParentOrder;
		const inspect = (service as unknown as { inspectStandby: (q: DataSource, table: string, standby: string, toPartitioned: boolean) => Promise<{ differences: string[] }> }).inspectStandby;
		const installed = ['note', 'note_p', 'note_p_00', 'note_p_01', 'note_p_02', 'note_p_03'].flatMap(table => parentOrderTriggers.map(name => `${table}.${name}`));
		const insertTrigger = 'CREATE TRIGGER note_parent_order_insert BEFORE INSERT FOR EACH ROW EXECUTE FUNCTION note_parent_order()';
		const reinstalled = (table: string) => `installing the parent order triggers on ${table} again before switching note`;
		const attempt = async (): Promise<string[]> => {
			const logs: string[] = [];
			expect(await switchCopies(createJob(logs), Date.now() + 60_000, 'note')).toBe(false);
			return logs;
		};
		expect(await catalog.parentOrderTriggers()).toEqual(installed);
		await db.query('DELETE FROM "partition_migration_state" WHERE "name" = ANY($1)', [parentOrderPhases]);
		for (const table of ['note', 'note_p']) {
			for (const name of parentOrderTriggers) await db.query(`DROP TRIGGER "${name}" ON "${table}"`);
		}

		expect(await attempt()).toEqual(['note is switched to the partitioned copy after noteParentOrderPlain']);
		expect(await catalog.relkind('note')).toBe('r');

		config.partitionMigration.liveTable = 'plain';
		let logs: string[] = [];
		try {
			logs = await runJob();
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
		}
		expect(logs).toContain('phase noteParentOrderPlain finished');
		expect(logs).toContain('phase noteParentOrderPartitioned finished');
		expect(logs).toContain('suspended at noteCutover');
		expect(await catalog.parentOrderTriggers()).toEqual(installed);

		const align = vi.spyOn(service as unknown as { alignStandby: () => Promise<boolean> }, 'alignStandby').mockResolvedValue(false);
		await db.query('DROP TRIGGER "note_parent_order_insert" ON "note_p"');
		await expect(db.transaction(async em => await assertAligned(em, 'note', 'note_p', true))).rejects.toThrow(`only note has ${insertTrigger}`);
		expect(await attempt()).toEqual([reinstalled('note_p')]);
		expect(await catalog.parentOrderTriggers()).toEqual(installed);

		for (const table of ['note', 'note_p']) await db.query(`DROP TRIGGER "note_parent_order_insert" ON "${table}"`);
		expect((await inspect(db, 'note', 'note_p', true)).differences).toEqual([]);
		await expect(db.transaction(async em => await assertParentOrder(em, ['note', 'note_p']))).rejects.toThrow('the parent order triggers are missing on note, note_p');
		expect(await attempt()).toEqual([reinstalled('note'), reinstalled('note_p')]);
		expect(await catalog.parentOrderTriggers()).toEqual(installed);

		await db.query('ALTER TABLE "note" DISABLE TRIGGER "note_parent_order_update"');
		await db.query('DROP TRIGGER "note_parent_order_update" ON "note_p"');
		await db.query('CREATE TRIGGER "note_parent_order_update" BEFORE UPDATE ON "note_p" FOR EACH ROW WHEN (NEW."replyId" >= NEW."id") EXECUTE FUNCTION note_parent_order()');
		await expect(db.transaction(async em => await assertParentOrder(em, ['note', 'note_p']))).rejects.toThrow('the parent order triggers are missing on note, note_p');
		expect(await attempt()).toEqual([reinstalled('note'), reinstalled('note_p')]);

		await db.query('CREATE OR REPLACE FUNCTION note_parent_order() RETURNS trigger AS $$ BEGIN RETURN NEW; END; $$ LANGUAGE plpgsql');
		expect(await attempt()).toEqual([reinstalled('note'), reinstalled('note_p')]);

		expect(align).toHaveBeenCalledTimes(4);
		expect(await catalog.parentOrderTriggers()).toEqual(installed);
		await db.transaction(async em => await assertParentOrder(em, ['note', 'note_p']));
		expect((await inspect(db, 'note', 'note_p', true)).differences).toEqual([]);
		await expect(db.query('INSERT INTO "note_p" ("id", "userId", "visibility", "replyId") VALUES ($1, $2, \'public\', $1)', [idInPrefix(0), author.id])).rejects.toThrow(parentOrderViolation);
		expect(await catalog.relkind('note')).toBe('r');
		expect(await catalog.index('IDX_TEST_ALIGNED_mig')).toBe(null);
	});

	test('a write held on note makes the parent order phase stop and retry with the triggers left as they were', async () => {
		const installed = await catalog.parentOrderTriggers();
		const writer = db.createQueryRunner();
		await writer.connect();
		const logs: string[] = [];
		let finished: boolean | undefined;
		try {
			await writer.startTransaction();
			await writer.query('INSERT INTO "note" ("id", "userId", "visibility") VALUES ($1, $2, \'public\')', [idInPrefix(0), author.id]);
			finished = await serviceMethod('runNoteParentOrderPartitioned')(createJob(logs), Date.now() + 60_000);
		} finally {
			if (writer.isTransactionActive) await writer.rollbackTransaction();
			await writer.release();
		}

		expect(finished).toBe(false);
		expect(logs).toHaveLength(1);
		expect(logs[0]).toMatch(/^installing the parent order triggers on note_p failed: .*lock timeout/);
		expect(await catalog.parentOrderTriggers()).toEqual(installed);
		expect(await serviceMethod('runNoteParentOrderPartitioned')(createJob(), Date.now() + 60_000)).toBe(true);
		expect(await catalog.parentOrderTriggers()).toEqual(installed);
	});

	test('the lookup indexes of the partitioned reaction copy are built prefix by prefix, and a run cut short resumes without creating the parents again and rebuilds an invalid child', async () => {
		expect(await serviceMethod('runReactionPrepare')(createJob(), Date.now() + 60_000)).toBe(true);
		for (const id of [idInPrefix(1), idInPrefix(1)]) {
			const note = await createNote(id);
			await noteReactionsRepository.insert({ id: idService.gen(), noteId: note.id, userId: author.id, reaction: '👍' });
		}
		const build = serviceMethod('runReactionLookupIndexes');
		const longQuery = vi.spyOn(dbLong, 'query');
		const statements = () => longQuery.mock.calls.flatMap(([sql]): string[] => {
			const child = /^CREATE INDEX CONCURRENTLY IF NOT EXISTS "(IDX_NOTE_REACTION_\w+)_mig_(\w\w)" ON "note_reaction_p_\2" /.exec(sql);
			if (child != null) return [`create ${child[1]} ${child[2]}`];
			const attach = /^ALTER INDEX "(IDX_NOTE_REACTION_\w+)_mig" ATTACH PARTITION "\1_mig_(\w\w)"$/.exec(sql);
			if (attach != null) return [`attach ${attach[1]} ${attach[2]}`];
			const drop = /^DROP INDEX CONCURRENTLY IF EXISTS "(IDX_NOTE_REACTION_\w+)_mig_(\w\w)"$/.exec(sql);
			if (drop != null) return [`drop ${drop[1]} ${drop[2]}`];
			return [];
		});
		const parents = () => longQuery.mock.calls.filter(([sql]) => sql.includes('ON ONLY')).map(([sql, , runner]) => [sql, runner != null]);
		const realNow = Date.now;
		const now = vi.spyOn(Date, 'now').mockImplementation(() => statements().filter(x => x.startsWith('create')).length >= 3 ? Number.MAX_SAFE_INTEGER : realNow());

		expect(await build(createJob(), realNow() + 60_000)).toBe(false);
		now.mockRestore();

		expect(parents()).toEqual(lookupIndexes.map(name => [
			`CREATE INDEX IF NOT EXISTS "${name}_mig" ON ONLY "note_reaction_p" ${name === 'IDX_NOTE_REACTION_ID' ? 'USING btree (id)' : 'USING btree ("userId", id)'}`,
			true,
		]));
		expect(statements()).toEqual([
			'create IDX_NOTE_REACTION_ID 00',
			'attach IDX_NOTE_REACTION_ID 00',
			'create IDX_NOTE_REACTION_USER_ID_ID 00',
			'attach IDX_NOTE_REACTION_USER_ID_ID 00',
			'create IDX_NOTE_REACTION_ID 01',
			'attach IDX_NOTE_REACTION_ID 01',
		]);
		for (const name of lookupIndexes) {
			expect(await catalog.index(`${name}_mig`)).toMatchObject({ table: 'note_reaction_p', valid: false });
		}

		const broken = 'IDX_NOTE_REACTION_USER_ID_ID_mig_01';
		await expect(db.query(`CREATE UNIQUE INDEX CONCURRENTLY "${broken}" ON "note_reaction_p_01" ("reaction")`)).rejects.toThrow();
		expect(await catalog.index(broken)).toMatchObject({ table: 'note_reaction_p_01', valid: false, attached: false });
		longQuery.mockClear();

		expect(await build(createJob(), Date.now() + 60_000)).toBe(true);

		expect(statements()).toEqual([
			'drop IDX_NOTE_REACTION_USER_ID_ID 01',
			'create IDX_NOTE_REACTION_USER_ID_ID 01',
			'attach IDX_NOTE_REACTION_USER_ID_ID 01',
			...['02', '03'].flatMap(prefix => lookupIndexes.flatMap(name => [`create ${name} ${prefix}`, `attach ${name} ${prefix}`])),
		]);
		expect(parents()).toEqual([]);
		for (const name of lookupIndexes) {
			const parent = await catalog.index(`${name}_mig`);
			expect(parent).toMatchObject({ table: 'note_reaction_p', unique: false, valid: true });
			for (const prefix of ['00', '01', '02', '03']) {
				expect(await catalog.index(`${name}_mig_${prefix}`)).toEqual({ ...parent, table: `note_reaction_p_${prefix}`, attached: true });
			}
		}
		longQuery.mockClear();

		expect(await build(createJob(), Date.now() + 60_000)).toBe(true);
		expect(statements()).toEqual([]);
		expect(parents()).toEqual([]);
	});

	test('a live index is left off the partitioned copy only when another index of the copy covers its key columns with the same or a stronger uniqueness', async () => {
		const inspect = (service as unknown as { inspectStandby: (q: DataSource, table: string, standby: string, toPartitioned: boolean) => Promise<{ missing: { index: { name: string } }[] }> }).inspectStandby;
		const created = {
			IDX_TEST_NARROW: 'CREATE INDEX "IDX_TEST_NARROW" ON "note" ("replyUserHost", "renoteUserHost")',
			IDX_TEST_WIDE: 'CREATE INDEX "IDX_TEST_WIDE" ON "note" ("replyUserHost", "renoteUserHost", "renoteUserId")',
			IDX_TEST_KEYED: 'CREATE UNIQUE INDEX "IDX_TEST_KEYED" ON "note" ("id", "replyUserHost")',
			IDX_TEST_KEYED_WIDE: 'CREATE INDEX "IDX_TEST_KEYED_WIDE" ON "note" ("id", "replyUserHost", "renoteUserHost")',
			IDX_TEST_UNKEYED: 'CREATE UNIQUE INDEX "IDX_TEST_UNKEYED" ON "note" ("renoteUserId")',
			IDX_TEST_UNKEYED_WIDE: 'CREATE INDEX "IDX_TEST_UNKEYED_WIDE" ON "note" ("renoteUserId", "replyUserId")',
			IDX_TEST_DESC: 'CREATE INDEX "IDX_TEST_DESC" ON "note" ("renoteChannelId")',
			IDX_TEST_DESC_WIDE: 'CREATE INDEX "IDX_TEST_DESC_WIDE" ON "note" ("renoteChannelId" DESC, "id")',
		};
		try {
			for (const sql of Object.values(created)) await db.query(sql);

			const { missing } = await inspect(db, 'note', 'note_p', true);

			expect(missing.map(({ index }) => index.name).filter(name => name in created)).toEqual(['IDX_TEST_DESC', 'IDX_TEST_DESC_WIDE', 'IDX_TEST_KEYED', 'IDX_TEST_KEYED_WIDE', 'IDX_TEST_UNKEYED_WIDE', 'IDX_TEST_WIDE']);
		} finally {
			for (const name of Object.keys(created)) await db.query(`DROP INDEX IF EXISTS "${name}"`);
		}
	});

	test('the indexes that only the live plain copy has are added to the partitioned copy before the switch, replacing a stale one under the usual name together with its leftover children, and the parents are analyzed after their children', async () => {
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_ALIGNED_UNIQUE" ON "note" ("uri", "id")');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_ALIGNED_KEYLESS" ON "note" ("replyUserHost")');
		await db.query('CREATE INDEX "IDX_TEST_SAME_BODY" ON "note" ("replyUserId")');
		await db.query('CREATE INDEX "IDX_TEST_SAME_BODY_ELSEWHERE" ON "note_p" ("replyUserId")');
		await db.query('CREATE INDEX "IDX_TEST_PK_EQUIVALENT" ON "note_reaction" ("noteId", "id")');
		await db.query('CREATE INDEX "IDX_TEST_TAKEN" ON "note" ("userHost", "id")');
		await db.query('CREATE INDEX "IDX_TEST_TAKEN_mig" ON ONLY "note_p" ("userHost", "visibility")');
		await db.query('CREATE INDEX "IDX_TEST_TAKEN_mig_00" ON "note_p_00" ("userHost", "visibility")');
		await db.query('ALTER INDEX "IDX_TEST_TAKEN_mig" ATTACH PARTITION "IDX_TEST_TAKEN_mig_00"');
		await db.query('CREATE INDEX "IDX_TEST_TAKEN_mig_01" ON "note_p_01" ("userHost", "visibility")');
		const stale = 'USING btree ("userHost", visibility)';
		expect(await catalog.indexesWithBody(stale)).toEqual(['IDX_TEST_TAKEN_mig', 'IDX_TEST_TAKEN_mig_00', 'IDX_TEST_TAKEN_mig_01']);
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		await expect(db.transaction(async em => await assertAligned(em, 'note', 'note_p', true))).rejects.toThrow('note_p has the stale IDX_TEST_TAKEN_mig');
		const note = await createNote(idInPrefix(2));
		await noteReactionsRepository.insert({ id: idService.gen(), noteId: note.id, userId: author.id, reaction: '👍' });
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		const dropped = 'dropping the stale IDX_TEST_TAKEN_mig of note_p';
		const added = 'adding IDX_TEST_ALIGNED, IDX_TEST_ALIGNED_KEYLESS, IDX_TEST_ALIGNED_UNIQUE, IDX_TEST_TAKEN of note to note_p';
		expect(logs.filter(row => row.startsWith('dropping the stale') || row.startsWith('adding'))).toEqual([dropped, added]);
		expect(logs.indexOf(added)).toBeLessThan(logs.indexOf('note switched to the partitioned copy'));
		expect(longQuery.mock.calls.filter(([sql]) => sql.startsWith('DROP INDEX')).map(([sql, , runner]) => [sql, runner != null])).toEqual([
			['DROP INDEX IF EXISTS "IDX_TEST_TAKEN_mig"', true],
			['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_TAKEN_mig_01"', false],
		]);
		expect(logs.filter(row => row.startsWith('cannot switch'))).toEqual([]);
		expect(logs).toContain('note_reaction switched to the partitioned copy');
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('p');
		expect(await catalog.index('IDX_TEST_ALIGNED')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree (cw) WHERE (cw IS NOT NULL)' });
		expect(await catalog.index('IDX_TEST_ALIGNED_old')).toEqual({ table: 'note_old', unique: false, valid: true, attached: false, body: 'USING btree (cw) WHERE (cw IS NOT NULL)' });
		expect(await catalog.index('IDX_TEST_ALIGNED_UNIQUE')).toEqual({ table: 'note', unique: true, valid: true, attached: false, body: 'USING btree (uri, id)' });
		expect(await catalog.index('IDX_TEST_ALIGNED_UNIQUE_old')).toEqual({ table: 'note_old', unique: true, valid: true, attached: false, body: 'USING btree (uri, id)' });
		expect(await catalog.index('IDX_TEST_ALIGNED_UNIQUE_mig_03')).toMatchObject({ table: 'note_p_03', unique: true, valid: true, attached: true });
		expect(await catalog.index('IDX_TEST_ALIGNED_KEYLESS')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree ("replyUserHost")' });
		expect(await catalog.index('IDX_TEST_ALIGNED_KEYLESS_old')).toEqual({ table: 'note_old', unique: true, valid: true, attached: false, body: 'USING btree ("replyUserHost")' });
		expect(await catalog.index('IDX_TEST_SAME_BODY_ELSEWHERE')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree ("replyUserId")' });
		expect(await catalog.index('IDX_TEST_SAME_BODY_old')).toEqual({ table: 'note_old', unique: false, valid: true, attached: false, body: 'USING btree ("replyUserId")' });
		expect(await catalog.index('IDX_TEST_SAME_BODY')).toBe(null);
		expect(await catalog.index('IDX_TEST_SAME_BODY_mig')).toBe(null);
		expect(await catalog.index('IDX_TEST_PK_EQUIVALENT_old')).toEqual({ table: 'note_reaction_old', unique: false, valid: true, attached: false, body: 'USING btree ("noteId", id)' });
		expect(await catalog.index('IDX_TEST_PK_EQUIVALENT')).toBe(null);
		expect(await catalog.index('IDX_TEST_PK_EQUIVALENT_mig')).toBe(null);
		expect(await catalog.index('IDX_TEST_TAKEN')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree ("userHost", id)' });
		expect(await catalog.index('IDX_TEST_TAKEN_old')).toEqual({ table: 'note_old', unique: false, valid: true, attached: false, body: 'USING btree ("userHost", id)' });
		for (const prefix of ['00', '01', '02', '03']) {
			expect(await catalog.index(`IDX_TEST_TAKEN_mig_${prefix}`)).toEqual({ table: `note_p_${prefix}`, unique: false, valid: true, attached: true, body: 'USING btree ("userHost", id)' });
		}
		expect(await catalog.indexesWithBody('USING btree ("userHost", id)')).toEqual(['IDX_TEST_TAKEN', 'IDX_TEST_TAKEN_mig_00', 'IDX_TEST_TAKEN_mig_01', 'IDX_TEST_TAKEN_mig_02', 'IDX_TEST_TAKEN_mig_03', 'IDX_TEST_TAKEN_old']);
		expect(await catalog.indexesWithBody(stale)).toEqual([]);

		const statements = longQuery.mock.calls.map(([sql]) => sql);
		for (const table of ['note', 'note_reaction']) {
			const children = statements.flatMap((sql, i) => new RegExp(`^ANALYZE "${table}_p_\\w\\w"$`).test(sql) ? [i] : []);
			expect(children).toHaveLength(PARTITION_COUNT);
			expect(statements.indexOf(`ANALYZE ONLY "${table}"`)).toBeGreaterThan(Math.max(...children));
			expect(await inheritedStatistics(db, table)).toBeGreaterThan(0);
		}
	});

	test('the parent is not analyzed before PostgreSQL 18', async () => {
		const query = dbLong.query.bind(dbLong) as (...args: unknown[]) => Promise<unknown>;
		const faked = vi.spyOn(dbLong as unknown as { query: (...args: unknown[]) => Promise<unknown> }, 'query').mockImplementation(async (...args) => {
			const rows = await query(...args);
			return String(args[0]).includes('server_version_num') ? (rows as { version: number }[]).map(row => ({ ...row, version: 170000 })) : rows;
		});
		const analyze = serviceMethod('runNoteAnalyze');

		expect(await analyze(createJob(), Date.now() + 60_000)).toBe(true);
		expect(faked.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.startsWith('ANALYZE ONLY'))).toEqual([]);

		faked.mockRestore();
		const longQuery = vi.spyOn(dbLong, 'query');
		expect(await analyze(createJob(), Date.now() + 60_000)).toBe(true);
		expect(longQuery.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('ANALYZE ONLY'))).toEqual(['ANALYZE ONLY "note"']);
	});

	test('the analyze phase finishes only after the parent is analyzed, and a failed parent analyze is retried without the children', async () => {
		await db.query('DELETE FROM "partition_migration_state" WHERE "name" = \'reactionAnalyze\'');
		const query = dbLong.query.bind(dbLong) as (...args: unknown[]) => Promise<unknown>;
		const failing = vi.spyOn(dbLong as unknown as { query: (...args: unknown[]) => Promise<unknown> }, 'query').mockImplementation(async (...args) => {
			if (args[0] === 'ANALYZE ONLY "note_reaction"') throw new Error('the analyze failed');
			return await query(...args);
		});

		await expect(runJob()).rejects.toThrow('the analyze failed');

		expect(failing.mock.calls.map(([sql]) => String(sql)).filter(sql => sql.startsWith('ANALYZE'))).toEqual([
			...['00', '01', '02', '03'].map(prefix => `ANALYZE "note_reaction_p_${prefix}"`),
			'ANALYZE ONLY "note_reaction"',
		]);
		expect(await catalog.state('reactionAnalyze')).toEqual({ ord: PARTITION_COUNT });
		expect(await db.query('SELECT "finishedAt" FROM "partition_migration_state" WHERE "name" = \'reactionAnalyze\'')).toEqual([{ finishedAt: null }]);
		failing.mockRestore();
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		expect(logs).toContain('phase reactionAnalyze finished');
		expect(longQuery.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('ANALYZE'))).toEqual(['ANALYZE ONLY "note_reaction"']);
	});

	test('an index created on the live copy after the alignment fails the switch in its transaction', async () => {
		const runParity = (service as unknown as { runParity: (...args: unknown[]) => Promise<boolean> }).runParity;
		vi.spyOn(service as unknown as { runParity: (...args: unknown[]) => Promise<boolean> }, 'runParity').mockImplementationOnce(async (...args) => {
			await db.query('CREATE INDEX "IDX_TEST_RACE" ON "note_reaction" ("reaction")');
			return await runParity(...args);
		});
		config.partitionMigration.liveTable = 'plain';
		try {
			const logs = await runJob();

			expect(logs).toContain('switching note_reaction to the plain copy: attempt 1 failed: Error: note_reaction_old is not aligned with note_reaction: note_reaction_old lacks IDX_TEST_RACE');
			expect(logs).toContain('note is switched to the plain copy after note_reaction');
			expect(await catalog.relkind('note_reaction')).toBe('p');
			expect(await catalog.relkind('note')).toBe('p');
			expect(await catalog.syncFunction('note_reaction')).toBe('note_reaction_sync_to_old');
			expect(await catalog.index('IDX_TEST_RACE_old')).toBe(null);
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
			await db.query('DROP INDEX "IDX_TEST_RACE"');
			await leaveState(db, 'reactionSwitch', {});
		}
	});

	test('an index that the live partitioned copy no longer has is dropped concurrently from the plain copy before the switch back, while the indexes that the live copy covers stay', async () => {
		const align = (service as unknown as { alignStandby: (job: Bull.Job, deadline: number, table: string, standby: string, toPartitioned: boolean) => Promise<boolean> }).alignStandby;
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		const coveredBodies = ['USING btree ("userId")', 'USING btree ("noteId")', 'USING btree ("noteId", id)'];
		const covered = await catalog.indexesOn('note_reaction_old', coveredBodies);
		expect(covered).toHaveLength(3);
		expect(await catalog.indexesOn('note_reaction', coveredBodies.slice(0, 2))).toEqual([]);
		const id = idService.gen();
		await app.get<UsersRepository>(DI.usersRepository).insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_DROPPED" ON "note_reaction" ("noteId", "reaction")');
		try {
			const added: string[] = [];
			expect(await align(createJob(added), Date.now() + 60_000, 'note_reaction', 'note_reaction_old', false)).toBe(true);
			expect(added).toEqual(['adding IDX_TEST_DROPPED of note_reaction to note_reaction_old']);
			expect(await catalog.index('IDX_TEST_DROPPED_old')).toMatchObject({ table: 'note_reaction_old', unique: true, valid: true });

			await db.query('DROP INDEX "IDX_TEST_DROPPED"');
			await expect(db.transaction(async em => await assertAligned(em, 'note_reaction', 'note_reaction_old', false))).rejects.toThrow('note_reaction_old is not aligned with note_reaction: note_reaction_old has IDX_TEST_DROPPED_old, which note_reaction does not have');
			const longQuery = vi.spyOn(dbLong, 'query');
			const logs: string[] = [];

			expect(await align(createJob(logs), Date.now() + 60_000, 'note_reaction', 'note_reaction_old', false)).toBe(true);

			expect(logs).toEqual(['dropping IDX_TEST_DROPPED_old of note_reaction_old, which note_reaction does not have']);
			expect(longQuery.mock.calls.filter(([sql]) => sql.startsWith('DROP INDEX')).map(([sql, , runner]) => [sql, runner != null])).toEqual([['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_DROPPED_old"', false]]);
			expect(await catalog.index('IDX_TEST_DROPPED_old')).toBe(null);
			expect(await catalog.indexesOn('note_reaction_old', coveredBodies)).toEqual(covered);
			await db.transaction(async em => await assertAligned(em, 'note_reaction', 'note_reaction_old', false));

			const note = await createNote(idInPrefix(1));
			for (const userId of [author.id, id]) {
				await noteReactionsRepository.insert({ id: idService.gen(), noteId: note.id, userId, reaction: '👍' });
			}
			expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_old" WHERE "noteId" = $1', [note.id])).toEqual([{ count: 2 }]);
		} finally {
			for (const name of ['IDX_TEST_DROPPED', 'IDX_TEST_DROPPED_old']) await db.query(`DROP INDEX IF EXISTS "${name}"`);
		}
	});

	test('an index of the plain copy that the live partitioned copy does not have is left alone before the switch back while another backend is still building it, and dropped once the build is done', async () => {
		const align = (service as unknown as { alignStandby: (job: Bull.Job, deadline: number, table: string, standby: string, toPartitioned: boolean) => Promise<boolean> }).alignStandby;
		const name = 'IDX_TEST_EXTRA_old';
		try {
			expect(await whileBuilding(db, `CREATE INDEX CONCURRENTLY "${name}" ON "note_reaction_old" ("reaction")`, (job, deadline) => align(job, deadline, 'note_reaction', 'note_reaction_old', false))).toBe(false);
			expect(await catalog.index(name)).toMatchObject({ table: 'note_reaction_old', valid: true });

			const logs: string[] = [];
			expect(await align(createJob(logs), Date.now() + 60_000, 'note_reaction', 'note_reaction_old', false)).toBe(true);
			expect(logs).toEqual([`dropping ${name} of note_reaction_old, which note_reaction does not have`]);
			expect(await catalog.index(name)).toBe(null);
		} finally {
			await db.query(`DROP INDEX IF EXISTS "${name}"`);
		}
	});

	test('an index that only the live partitioned copy has is left alone on the plain copy before the switch back while another backend is still building it, and serves the switch once the build is done', async () => {
		const align = (service as unknown as { alignStandby: (job: Bull.Job, deadline: number, table: string, standby: string, toPartitioned: boolean) => Promise<boolean> }).alignStandby;
		await db.query('CREATE INDEX "IDX_TEST_BUILDING" ON "note_reaction" ("reaction", "userId")');
		try {
			expect(await whileBuilding(db, 'CREATE INDEX CONCURRENTLY "IDX_TEST_BUILDING_old" ON "note_reaction_old" ("reaction", "userId")', (job, deadline) => align(job, deadline, 'note_reaction', 'note_reaction_old', false))).toBe(false);

			const logs: string[] = [];
			expect(await align(createJob(logs), Date.now() + 60_000, 'note_reaction', 'note_reaction_old', false)).toBe(true);
			expect(logs).toEqual([]);
			expect(await catalog.index('IDX_TEST_BUILDING_old')).toMatchObject({ table: 'note_reaction_old', valid: true, body: 'USING btree (reaction, "userId")' });
		} finally {
			for (const name of ['IDX_TEST_BUILDING', 'IDX_TEST_BUILDING_old']) await db.query(`DROP INDEX IF EXISTS "${name}"`);
		}
	});

	test('an index that only the live partitioned copy has is added to the plain copy before the switch back, replacing the invalid one a cancelled build left and a stale one under the usual name', async () => {
		await db.query('CREATE INDEX "IDX_TEST_BACK" ON "note" ("name")');
		await db.query('DROP INDEX "IDX_TEST_TAKEN"');
		await db.query('CREATE INDEX "IDX_TEST_TAKEN" ON "note" ("userHost", "visibility")');
		expect(await catalog.index('IDX_TEST_TAKEN_old')).toEqual({ table: 'note_old', unique: false, valid: true, attached: false, body: 'USING btree ("userHost", id)' });
		const holder = db.createQueryRunner();
		await holder.connect();
		try {
			await holder.startTransaction('REPEATABLE READ');
			await holder.query('SELECT count(*) FROM "note_old"');
			const building = db.query('CREATE INDEX CONCURRENTLY "IDX_TEST_BACK_old" ON "note_old" ("name")').then(() => null, (e: unknown) => String(e));
			await waitUntilBlockedBy(db, holder, /^CREATE INDEX CONCURRENTLY "IDX_TEST_BACK_old" /);
			await db.query('SELECT pg_cancel_backend("pid") FROM "pg_stat_activity" WHERE "datname" = current_database() AND "query" LIKE \'CREATE INDEX CONCURRENTLY%\'');
			expect(await building).toContain('canceling statement');
		} finally {
			if (holder.isTransactionActive) await holder.rollbackTransaction();
			await holder.release();
		}
		expect(await catalog.index('IDX_TEST_BACK_old')).toMatchObject({ table: 'note_old', valid: false });
		config.partitionMigration.liveTable = 'plain';
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		const dropped = 'dropping the stale IDX_TEST_TAKEN_old of note_old';
		const added = 'adding IDX_TEST_BACK, IDX_TEST_TAKEN of note to note_old';
		expect(logs).toContain('note_reaction switched to the plain copy');
		expect(logs.filter(row => row.endsWith(' of note_old') || row.endsWith(' to note_old'))).toEqual([dropped, added]);
		expect(logs.indexOf(added)).toBeLessThan(logs.indexOf('note switched to the plain copy'));
		expect(longQuery.mock.calls.filter(([sql]) => sql.startsWith('DROP INDEX')).map(([sql, , runner]) => [sql, runner != null])).toEqual([
			['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_TAKEN_old"', false],
			['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_BACK_old"', false],
		]);
		expect(await catalog.relkind('note')).toBe('r');
		expect(await catalog.relkind('note_reaction')).toBe('r');
		expect(await catalog.index('IDX_TEST_BACK')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree (name)' });
		expect(await catalog.index('IDX_TEST_BACK_mig')).toEqual({ table: 'note_p', unique: false, valid: true, attached: false, body: 'USING btree (name)' });
		expect(await catalog.index('IDX_TEST_ALIGNED')).toMatchObject({ table: 'note', valid: true });
		expect(await catalog.index('IDX_TEST_ALIGNED_UNIQUE_mig')).toMatchObject({ table: 'note_p', unique: true, valid: true });
		expect(await catalog.index('IDX_TEST_TAKEN')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree ("userHost", visibility)' });
		expect(await catalog.index('IDX_TEST_TAKEN_mig')).toEqual({ table: 'note_p', unique: false, valid: true, attached: false, body: 'USING btree ("userHost", visibility)' });
		expect(await catalog.indexesWithBody('USING btree ("userHost", visibility)')).toHaveLength(2 + PARTITION_COUNT);
		expect(await catalog.indexesWithBody('USING btree ("userHost", id)')).toEqual([]);
	});

	test('the parent is not analyzed while the live table is plain', async () => {
		const longQuery = vi.spyOn(dbLong, 'query');

		expect(await serviceMethod('runNoteAnalyze')(createJob(), Date.now() + 60_000)).toBe(true);
		expect(longQuery.mock.calls.map(([sql]) => sql).filter(sql => sql.startsWith('ANALYZE'))).toEqual([]);
	});

	test('note_reaction is switched to the partitioned copy only after the locator is filled and the lookup indexes are built', async () => {
		await db.query('DELETE FROM "partition_migration_state" WHERE "name" = ANY($1)', [['reactionLocatorFill', 'reactionLookupIndexes']]);
		config.partitionMigration.liveTable = 'partitioned';

		const first = await runJob();

		expect(first).toContain('note switched to the partitioned copy');
		expect(first).toContain('note_reaction is switched to the partitioned copy after reactionLocatorFill');
		expect(first).not.toContain('note_reaction switched to the partitioned copy');
		expect(first.indexOf('phase reactionLocatorFill finished')).toBeGreaterThan(first.indexOf('note_reaction is switched to the partitioned copy after reactionLocatorFill'));
		expect(first).toContain('phase reactionLookupIndexes finished');
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('r');

		const second = await runJob();

		expect(second).toContain('note_reaction switched to the partitioned copy');
		expect(await catalog.relkind('note_reaction')).toBe('p');
		expect((await catalog.crossPrefixReactions('note_reaction_old')).length).toBeGreaterThan(0);
		expect(await catalog.located()).toEqual(await catalog.crossPrefixReactions('note_reaction_old'));
	});

	test('note is switched back to the plain copy only after the parent order phases ran again, which install the triggers on the plain copy and the live partitioned copy', async () => {
		const partitions = ['note_p_00', 'note_p_01', 'note_p_02', 'note_p_03'];
		await db.query('DELETE FROM "partition_migration_state" WHERE "name" = ANY($1)', [parentOrderPhases]);
		for (const table of ['note', 'note_old']) {
			for (const name of parentOrderTriggers) await db.query(`DROP TRIGGER "${name}" ON "${table}"`);
		}
		expect(await catalog.parentOrderTriggers()).toEqual([]);
		config.partitionMigration.liveTable = 'plain';
		try {
			const first = await runJob();

			const refused = 'note is switched to the plain copy after noteParentOrderPlain';
			expect(first).toContain('note_reaction switched to the plain copy');
			expect(first).toContain(refused);
			expect(first.indexOf(refused)).toBeLessThan(first.indexOf('phase noteParentOrderPlain finished'));
			expect(first).toContain('phase noteParentOrderPartitioned finished');
			expect(first).not.toContain('note switched to the plain copy');
			expect(await catalog.relkind('note')).toBe('p');
			expect(await catalog.parentOrderTriggers()).toEqual(['note', 'note_old', ...partitions].flatMap(table => parentOrderTriggers.map(name => `${table}.${name}`)));

			const second = await runJob();

			expect(second).toContain('note switched to the plain copy');
			expect(await catalog.relkind('note')).toBe('r');
			expect(await catalog.parentOrderTriggers()).toEqual(['note', 'note_p', ...partitions].flatMap(table => parentOrderTriggers.map(name => `${table}.${name}`)));
		} finally {
			config.partitionMigration.liveTable = 'partitioned';
		}
	});

	test('dropping the partitioned copies while the plain copies are live empties the locator in the transaction that drops the partitioned reaction copy, and a job that dies right after that transaction leaves no failed attempt behind', async () => {
		const located = await catalog.located();
		expect(located.length).toBeGreaterThan(0);
		await db.query('CREATE VIEW "test_blocker" AS SELECT * FROM "note_reaction_p"');
		config.partitionMigration = { liveTable: 'plain', dropOldTables: true };
		try {
			const failed = await runJob();

			expect(failed.some(row => row.startsWith('dropping note_reaction_p: attempt 1 failed:'))).toBe(true);
			expect(failed).toContain('note_p dropped');
			expect(await catalog.relkind('note_reaction_p')).toBe('p');
			expect(await catalog.located()).toEqual(located);
			expect(await catalog.state('reactionDrop')).toMatchObject({ attempts: 1 });

			await db.query('DROP VIEW "test_blocker"');
			await db.query('UPDATE "partition_migration_state" SET "state" = jsonb_set("state", \'{nextAttemptAt}\', \'0\') WHERE "name" = \'reactionDrop\'');
			const states = (service as unknown as { partitionMigrationStatesRepository: { upsert: (...args: unknown[]) => Promise<unknown> } }).partitionMigrationStatesRepository;
			const upsert = vi.spyOn(states, 'upsert');
			const longTransaction = dbLong.transaction.bind(dbLong) as unknown as (...args: unknown[]) => Promise<unknown>;
			vi.spyOn(dbLong as unknown as { transaction: (...args: unknown[]) => Promise<unknown> }, 'transaction').mockImplementationOnce(async (...args) => {
				const result = await longTransaction(...args);
				upsert.mockRejectedValue(new Error('the job died'));
				return result;
			});
			const logs: string[] = [];
			await runJob(logs).catch(() => null);
			upsert.mockRestore();

			expect(logs).toContain('note_reaction_p dropped');
			expect(await catalog.state('reactionDrop')).toEqual({});
			expect(await catalog.relkind('note_reaction_p')).toBe(null);
			expect(await catalog.relkind('note_reaction')).toBe('r');
			expect(await catalog.relkind('note_reaction_locator')).toBe('r');
			expect(await catalog.located()).toEqual([]);
			await assertPartitionCopiesMatch(db);
		} finally {
			config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
			await db.query('DROP VIEW IF EXISTS "test_blocker"');
		}
	});
});

describe('PartitionMigrationProcessorService with constraints that only one copy has', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let usersRepository: UsersRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let catalog: ReturnType<typeof inspector>;
	let author: MiUser;
	let reactor: MiUser;
	const written: string[] = [];

	function idInPrefix(ord: number): string {
		return idService.gen(946684800000 + ord * 36 ** 6 + 1000 + Math.floor(Math.random() * 1000000));
	}

	async function createUser(): Promise<MiUser> {
		const id = idService.gen();
		await usersRepository.insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function insertNote(ord: number, values: { text?: string; renoteCount?: number; testColumn?: number | null } = {}): Promise<string> {
		const id = idInPrefix(ord);
		await db.query(
			'INSERT INTO "note" ("id", "userId", "visibility", "text", "renoteCount", "testColumn") VALUES ($1, $2, \'public\', $3, $4, $5)',
			[id, author.id, values.text ?? `note_${id}`, values.renoteCount ?? 0, values.testColumn === undefined ? 0 : values.testColumn],
		);
		written.push(id);
		return id;
	}

	async function react(noteId: string, user: MiUser): Promise<void> {
		await noteReactionsRepository.insert({ id: idService.gen(), noteId, userId: user.id, reaction: '👍' });
	}

	async function removeWritten(): Promise<void> {
		await db.query('DELETE FROM "note_reaction" WHERE "noteId" = ANY($1)', [written]);
		await db.query('DELETE FROM "note" WHERE "id" = ANY($1)', [written]);
		written.length = 0;
	}

	async function runJob(logs: string[] = []): Promise<string[]> {
		await service.process(createJob(logs));
		return logs;
	}

	async function checksOf(table: string): Promise<{ name: string; definition: string; validated: boolean }[]> {
		return await db.query('SELECT conname AS "name", pg_get_constraintdef(oid) AS "definition", convalidated AS "validated" FROM pg_constraint WHERE conrelid = $1::regclass AND contype = \'c\' ORDER BY conname', [table]);
	}

	async function notNullOf(table: string, column: string): Promise<boolean> {
		const [{ notNull }]: { notNull: boolean }[] = await db.query('SELECT attnotnull AS "notNull" FROM pg_attribute WHERE attrelid = $1::regclass AND attname = $2', [table, column]);
		return notNull;
	}

	async function holdingReadLock<T>(table: string, run: () => Promise<T>): Promise<T> {
		const reader = db.createQueryRunner();
		await reader.connect();
		try {
			await reader.startTransaction();
			await reader.query(`SELECT count(*) FROM "${table}"`);
			return await run();
		} finally {
			if (reader.isTransactionActive) await reader.rollbackTransaction();
			await reader.release();
		}
	}

	function constraintStatements(longQuery: { mock: { calls: unknown[][] } }, pattern: RegExp): [string, boolean][] {
		return longQuery.mock.calls.flatMap(([sql, , runner]): [string, boolean][] => typeof sql === 'string' && pattern.test(sql) ? [[sql, runner != null]] : []);
	}

	async function allowSwitchRetry(name: string): Promise<void> {
		await db.query('UPDATE "partition_migration_state" SET "state" = jsonb_set("state", \'{nextAttemptAt}\', \'0\') WHERE "name" = $1', [name]);
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		usersRepository = app.get(DI.usersRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		catalog = inspector(db);

		await dropSyncFunctions(db);
		await createShadows(db);
		await alterPartitionCopies(db, 'note', 'ADD "testColumn" integer DEFAULT 0');
		author = await createUser();
		reactor = await createUser();
		config.partitionMigration = { liveTable: 'plain', dropOldTables: false };
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await app.close();
	});

	test('a NOT NULL that only the partitioned copy has is dropped before its sync starts, so the backfill copies the rows that the live copy accepts', async () => {
		await db.query('ALTER TABLE "note_p" ALTER COLUMN "testColumn" SET NOT NULL');
		const nulled = await insertNote(1, { testColumn: null });

		const logs = await runJob();

		expect(logs.filter(row => row.includes('rejects writes'))).toEqual(['note_p rejects writes that note accepts, dropping NOT NULL "testColumn"']);
		expect(logs.indexOf('note_p rejects writes that note accepts, dropping NOT NULL "testColumn"')).toBeLessThan(logs.indexOf('phase notePrepare finished'));
		expect(logs).toContain('phase noteBackfill finished');
		expect(logs).toContain('suspended at noteCutover');
		expect(await db.query('SELECT "testColumn" FROM "note_p" WHERE "id" = $1', [nulled])).toEqual([{ testColumn: null }]);
		expect(await notNullOf('note_p', 'testColumn')).toBe(false);

		const prepare = (service as unknown as { runReactionPrepare: (job: Bull.Job, deadline: number) => Promise<boolean> }).runReactionPrepare;
		expect(await prepare(createJob(), Date.now() + 60_000)).toBe(true);
		expect(await catalog.syncTriggers()).toEqual(['note', 'note_reaction']);
		await removeWritten();
	});

	test('a unique index, a CHECK and a NOT NULL that only the partitioned standby copies have fail the writes on the live plain copies through the sync until the next run drops them before anything else, which leaves the NOT NULL of a key of the standby', async () => {
		const inspect = (service as unknown as { inspectStandby: (q: DataSource, table: string, standby: string, toPartitioned: boolean) => Promise<{ differences: string[] }> }).inspectStandby;
		const note = await insertNote(1);
		const text = `note_${note}`;
		await db.query('ALTER TABLE "note_p" ADD CONSTRAINT "test_standby_check" CHECK ("text" <> \'rejected\')');
		await db.query('ALTER TABLE "note_p" ALTER COLUMN "testColumn" SET NOT NULL');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_STANDBY_CHILD_mig_01" ON "note_p_01" ("text")');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_STANDBY_UNIQUE_mig" ON "note_reaction_p" ("noteId", "reaction")');
		await db.query('ALTER TABLE "note_reaction" ALTER COLUMN "noteId" DROP NOT NULL');
		await react(note, author);
		try {
			await expect(insertNote(0, { text: 'rejected' })).rejects.toThrow('violates check constraint "test_standby_check"');
			await expect(insertNote(0, { testColumn: null })).rejects.toThrow('null value in column "testColumn" of relation "note_p_00" violates not-null constraint');
			await expect(insertNote(1, { text })).rejects.toThrow('duplicate key value violates unique constraint "IDX_TEST_STANDBY_CHILD_mig_01"');
			await expect(react(note, reactor)).rejects.toThrow('duplicate key value violates unique constraint');
			const longQuery = vi.spyOn(dbLong, 'query');

			const logs = await runJob();

			expect(logs.slice(0, 2)).toEqual([
				'note_p rejects writes that note accepts, dropping IDX_TEST_STANDBY_CHILD_mig_01, test_standby_check, NOT NULL "testColumn"',
				'note_reaction_p rejects writes that note_reaction accepts, dropping IDX_TEST_STANDBY_UNIQUE_mig',
			]);
			expect(logs.slice(2).filter(row => row.includes('rejects writes'))).toEqual([]);
			expect(logs).toContain('suspended at noteCutover');
			expect(constraintStatements(longQuery, /^(ALTER TABLE|DROP INDEX) /)).toEqual([
				['ALTER TABLE "note_p" DROP CONSTRAINT IF EXISTS "test_standby_check"', true],
				['ALTER TABLE "note_p" ALTER COLUMN "testColumn" DROP NOT NULL', true],
				['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_STANDBY_CHILD_mig_01"', false],
				['DROP INDEX IF EXISTS "IDX_TEST_STANDBY_UNIQUE_mig"', true],
			]);

			const accepted = [await insertNote(0, { text: 'rejected' }), await insertNote(0, { testColumn: null }), await insertNote(1, { text })];
			await react(note, reactor);
			for (const id of accepted) {
				expect(await db.query('SELECT "text", "testColumn" FROM "note_p" WHERE "id" = $1', [id])).toEqual(await db.query('SELECT "text", "testColumn" FROM "note" WHERE "id" = $1', [id]));
			}
			expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_p" WHERE "noteId" = $1', [note])).toEqual([{ count: 2 }]);
			expect(await checksOf('note_p')).toEqual([]);
			expect(await notNullOf('note_p', 'testColumn')).toBe(false);
			expect(await notNullOf('note_reaction_p', 'noteId')).toBe(true);
			expect((await inspect(db, 'note_reaction', 'note_reaction_p', true)).differences).toContain('only note_reaction_p has NOT NULL "noteId"');
		} finally {
			await removeWritten();
			await db.query('ALTER TABLE "note_reaction" ALTER COLUMN "noteId" SET NOT NULL');
			await db.query('ALTER TABLE "note_p" DROP CONSTRAINT IF EXISTS "test_standby_check"');
			await db.query('ALTER TABLE "note_p" ALTER COLUMN "testColumn" DROP NOT NULL');
			await db.query('DROP INDEX IF EXISTS "IDX_TEST_STANDBY_CHILD_mig_01"');
			await db.query('DROP INDEX IF EXISTS "IDX_TEST_STANDBY_UNIQUE_mig"');
		}
		expect(await runJob()).not.toEqual(expect.arrayContaining([expect.stringContaining('rejects writes')]));
	});

	test('a held lock makes the run stop when it drops a constraint that only the standby copy has, and the next run drops it', async () => {
		await db.query('ALTER TABLE "note_p" ADD CONSTRAINT "test_standby_check" CHECK ("text" <> \'rejected\')');
		try {
			const logs = await holdingReadLock('note_p', async () => await runJob());

			expect(logs).toHaveLength(2);
			expect(logs[0]).toBe('note_p rejects writes that note accepts, dropping test_standby_check');
			expect(logs[1]).toMatch(/^dropping test_standby_check of note_p failed: .*lock timeout/);
			expect((await checksOf('note_p')).map(check => check.name)).toEqual(['test_standby_check']);

			const retried = await runJob();

			expect(retried[0]).toBe('note_p rejects writes that note accepts, dropping test_standby_check');
			expect(retried).toContain('suspended at noteCutover');
			expect(await checksOf('note_p')).toEqual([]);
		} finally {
			await db.query('ALTER TABLE "note_p" DROP CONSTRAINT IF EXISTS "test_standby_check"');
		}
	});

	test('a CHECK and a NOT NULL that only the live plain copy has are added to the partitioned copy and validated partition by partition before the switch, which a row of the partitioned copy violating them stops with a log until the row is fixed', async () => {
		const assertAligned = (service as unknown as { assertStandbyAligned: (em: EntityManager, table: string, standby: string, toPartitioned: boolean) => Promise<void> }).assertStandbyAligned;
		const addConstraints = (service as unknown as { addLiveConstraints: (job: Bull.Job, deadline: number, table: string, standby: string, toPartitioned: boolean) => Promise<boolean> }).addLiveConstraints;
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "test_live_check" CHECK ("renoteCount" >= 0)');
		await db.query('ALTER TABLE "note" ALTER COLUMN "testColumn" SET NOT NULL');
		const negative = await insertNote(2);
		const nulled = await insertNote(1);
		const adding = 'adding test_live_check, NOT NULL "testColumn" of note to note_p';
		await expect(db.transaction(async em => await assertAligned(em, 'note', 'note_p', true))).rejects.toThrow('note_p is not aligned with note: note_p lacks test_live_check, note_p lacks NOT NULL "testColumn"');

		const held: string[] = [];
		expect(await holdingReadLock('note_p', async () => await addConstraints(createJob(held), Date.now() + 60_000, 'note', 'note_p', true))).toBe(false);
		expect(held).toEqual([adding, expect.stringMatching(new RegExp(`^${adding} failed: .*lock timeout`))]);
		expect(await checksOf('note_p')).toEqual([]);
		expect(await catalog.state('noteSwitch')).toEqual({});

		await db.query('UPDATE "note_p" SET "renoteCount" = -1 WHERE "id" = $1', [negative]);
		config.partitionMigration.liveTable = 'partitioned';
		const longQuery = vi.spyOn(dbLong, 'query');
		const validations = () => longQuery.mock.calls.map(([sql]) => sql).filter(sql => sql.includes('VALIDATE CONSTRAINT'));
		const validationsOf = (name: string, prefixes: string[]) => prefixes.map(prefix => `ALTER TABLE note_p_${prefix} VALIDATE CONSTRAINT "${name}"`);

		const first = await runJob();

		expect(first).toContain(adding);
		expect(first).toContain('switching note to the partitioned copy: attempt 1 failed: QueryFailedError: check constraint "test_live_check" of relation "note_p_02" is violated by some row');
		expect(first).not.toContain('note switched to the partitioned copy');
		expect(validations()).toEqual(validationsOf('test_live_check', ['00', '01', '02']));
		expect(await catalog.relkind('note')).toBe('r');
		expect(await catalog.state('noteSwitch')).toMatchObject({ attempts: 1 });

		await db.query('UPDATE "note_p" SET "renoteCount" = 0 WHERE "id" = $1', [negative]);
		await db.query('UPDATE "note_p" SET "testColumn" = NULL WHERE "id" = $1', [nulled]);
		await allowSwitchRetry('noteSwitch');
		longQuery.mockClear();

		const second = await runJob();

		expect(second).toContain(adding);
		expect(second).toContain('switching note to the partitioned copy: attempt 2 failed: QueryFailedError: check constraint "testColumn_not_null" of relation "note_p_01" is violated by some row');
		expect(validations()).toEqual([
			...validationsOf('test_live_check', ['02', '03']),
			'ALTER TABLE "note_p" VALIDATE CONSTRAINT "test_live_check"',
			...validationsOf('testColumn_not_null', ['00', '01']),
		]);
		expect(await catalog.relkind('note')).toBe('r');

		await db.query('UPDATE "note_p" SET "testColumn" = 0 WHERE "id" = $1', [nulled]);
		await allowSwitchRetry('noteSwitch');
		longQuery.mockClear();

		const third = await runJob();

		expect(third.indexOf('adding NOT NULL "testColumn" of note to note_p')).toBeGreaterThanOrEqual(0);
		expect(third.indexOf('adding NOT NULL "testColumn" of note to note_p')).toBeLessThan(third.indexOf('note switched to the partitioned copy'));
		expect(validations()).toEqual([
			...validationsOf('testColumn_not_null', ['01', '02', '03']),
			'ALTER TABLE "note_p" VALIDATE CONSTRAINT "testColumn_not_null"',
		]);
		const setting = longQuery.mock.calls.filter(([sql]) => /^ALTER TABLE "note_p" (ALTER COLUMN|DROP CONSTRAINT) /.test(sql));
		expect(setting.map(([sql]) => sql)).toEqual(['ALTER TABLE "note_p" ALTER COLUMN "testColumn" SET NOT NULL', 'ALTER TABLE "note_p" DROP CONSTRAINT "testColumn_not_null"']);
		expect(setting[0][2]).not.toBeUndefined();
		expect(setting[1][2]).toBe(setting[0][2]);
		expect(await catalog.relkind('note')).toBe('p');
		for (const table of ['note', 'note_old', 'note_p_01']) {
			expect(await checksOf(table)).toEqual([{ name: 'test_live_check', definition: 'CHECK (("renoteCount" >= 0))', validated: true }]);
			expect(await notNullOf(table, 'testColumn')).toBe(true);
		}
		await removeWritten();
	});

	test('a unique index, a unique constraint, a CHECK and a NOT NULL that the live partitioned copies no longer have are dropped from the plain standby copies by the next run, which keeps the unique indexes that the partitioned copies cannot have', async () => {
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('p');
		await db.query('ALTER TABLE "note" DROP CONSTRAINT "test_live_check"');
		await db.query('ALTER TABLE "note" ALTER COLUMN "testColumn" DROP NOT NULL');
		await db.query('ALTER TABLE "note_old" ADD CONSTRAINT "UQ_TEST_UPSTREAM_old" UNIQUE ("text")');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_UPSTREAM_old" ON "note_reaction_old" ("noteId", "reaction")');
		const note = await insertNote(1);
		const text = `note_${note}`;
		await react(note, author);
		try {
			await expect(insertNote(0, { renoteCount: -1 })).rejects.toThrow('new row for relation "note_old" violates check constraint "test_live_check"');
			await expect(insertNote(0, { testColumn: null })).rejects.toThrow('null value in column "testColumn" of relation "note_old" violates not-null constraint');
			await expect(insertNote(0, { text })).rejects.toThrow('duplicate key value violates unique constraint "UQ_TEST_UPSTREAM_old"');
			await expect(react(note, reactor)).rejects.toThrow('duplicate key value violates unique constraint "IDX_TEST_UPSTREAM_old"');
			const longQuery = vi.spyOn(dbLong, 'query');

			const logs = await runJob();

			expect(logs.slice(0, 2)).toEqual([
				'note_old rejects writes that note accepts, dropping UQ_TEST_UPSTREAM_old, test_live_check, NOT NULL "testColumn"',
				'note_reaction_old rejects writes that note_reaction accepts, dropping IDX_TEST_UPSTREAM_old',
			]);
			expect(constraintStatements(longQuery, /^(ALTER TABLE|DROP INDEX) /)).toEqual([
				['ALTER TABLE "note_old" DROP CONSTRAINT IF EXISTS "UQ_TEST_UPSTREAM_old"', true],
				['ALTER TABLE "note_old" DROP CONSTRAINT IF EXISTS "test_live_check"', true],
				['ALTER TABLE "note_old" ALTER COLUMN "testColumn" DROP NOT NULL', true],
				['DROP INDEX CONCURRENTLY IF EXISTS "IDX_TEST_UPSTREAM_old"', false],
			]);

			const accepted = [await insertNote(0, { renoteCount: -1 }), await insertNote(0, { testColumn: null }), await insertNote(0, { text })];
			await react(note, reactor);
			for (const id of accepted) {
				expect(await db.query('SELECT "text", "renoteCount", "testColumn" FROM "note_old" WHERE "id" = $1', [id])).toEqual(await db.query('SELECT "text", "renoteCount", "testColumn" FROM "note" WHERE "id" = $1', [id]));
			}
			expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_old" WHERE "noteId" = $1', [note])).toEqual([{ count: 2 }]);
			expect(await catalog.index('IDX_153536c67d05e9adb24e99fc2b')).toMatchObject({ table: 'note', unique: false });
			expect(await catalog.index('IDX_153536c67d05e9adb24e99fc2b_old')).toMatchObject({ table: 'note_old', unique: true, valid: true });
			expect(await catalog.index('IDX_ad0c221b25672daf2df320a817_old')).toMatchObject({ table: 'note_reaction_old', unique: true, valid: true });
			expect(await catalog.index('UQ_TEST_UPSTREAM_old')).toBe(null);
			expect(await checksOf('note_old')).toEqual([]);
			expect(await notNullOf('note_old', 'testColumn')).toBe(false);
		} finally {
			await removeWritten();
			await db.query('ALTER TABLE "note_old" DROP CONSTRAINT IF EXISTS "UQ_TEST_UPSTREAM_old"');
			await db.query('DROP INDEX IF EXISTS "IDX_TEST_UPSTREAM_old"');
		}
	});

	test('a CHECK and a NOT NULL that only the live partitioned copy has are added to the plain copy before the switch back, which a row of the plain copy violating them stops with a log until the row is fixed', async () => {
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "test_live_check" CHECK ("renoteCount" >= 0)');
		await db.query('ALTER TABLE "note" ALTER COLUMN "testColumn" SET NOT NULL');
		const negative = await insertNote(2);
		await db.query('UPDATE "note_old" SET "renoteCount" = -1 WHERE "id" = $1', [negative]);
		const adding = 'adding test_live_check, NOT NULL "testColumn" of note to note_old';
		config.partitionMigration.liveTable = 'plain';
		const longQuery = vi.spyOn(dbLong, 'query');

		const first = await runJob();

		expect(first).toContain('note_reaction switched to the plain copy');
		expect(first).toContain(adding);
		expect(first).toContain('switching note to the plain copy: attempt 1 failed: QueryFailedError: check constraint "test_live_check" of relation "note_old" is violated by some row');
		expect(await catalog.relkind('note')).toBe('p');
		expect(await checksOf('note_old')).toEqual([{ name: 'test_live_check', definition: 'CHECK (("renoteCount" >= 0)) NOT VALID', validated: false }]);

		await db.query('UPDATE "note_old" SET "renoteCount" = 0 WHERE "id" = $1', [negative]);
		await allowSwitchRetry('noteSwitch');
		longQuery.mockClear();

		const second = await runJob();

		expect(second.indexOf(adding)).toBeGreaterThanOrEqual(0);
		expect(second.indexOf(adding)).toBeLessThan(second.indexOf('note switched to the plain copy'));
		expect(constraintStatements(longQuery, /^ALTER TABLE "note_old" /)).toEqual([
			['ALTER TABLE "note_old" VALIDATE CONSTRAINT "test_live_check"', true],
			['ALTER TABLE "note_old" ADD CONSTRAINT "testColumn_not_null" CHECK (("testColumn" IS NOT NULL)) NOT VALID', true],
			['ALTER TABLE "note_old" VALIDATE CONSTRAINT "testColumn_not_null"', true],
			['ALTER TABLE "note_old" ALTER COLUMN "testColumn" SET NOT NULL', true],
			['ALTER TABLE "note_old" DROP CONSTRAINT "testColumn_not_null"', true],
		]);
		expect(await catalog.relkind('note')).toBe('r');
		for (const table of ['note', 'note_p', 'note_p_02']) {
			expect(await checksOf(table)).toEqual([{ name: 'test_live_check', definition: 'CHECK (("renoteCount" >= 0))', validated: true }]);
			expect(await notNullOf(table, 'testColumn')).toBe(true);
		}
		await removeWritten();
	});
});

describe('PartitionMigrationProcessorService with unique constraints', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let usersRepository: UsersRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let catalog: ReturnType<typeof inspector>;
	let author: MiUser;
	let reactor: MiUser;
	const prefixes = ['00', '01', '02', '03'];

	type UniqueConstraint = { name: string; definition: string; body: string; parent: string | null };

	function idInPrefix(ord: number): string {
		return idService.gen(946684800000 + ord * 36 ** 6 + 1000 + Math.floor(Math.random() * 1000000));
	}

	async function createUser(): Promise<MiUser> {
		const id = idService.gen();
		await usersRepository.insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		return await usersRepository.findOneByOrFail({ id });
	}

	async function insertNote(ord: number, text?: string): Promise<string> {
		const id = idInPrefix(ord);
		await db.query('INSERT INTO "note" ("id", "userId", "visibility", "text") VALUES ($1, $2, \'public\', $3)', [id, author.id, text ?? `note_${id}`]);
		return id;
	}

	async function react(noteId: string, user: MiUser): Promise<void> {
		await noteReactionsRepository.insert({ id: idService.gen(), noteId, userId: user.id, reaction: '👍' });
	}

	async function runJob(logs: string[] = []): Promise<string[]> {
		await service.process(createJob(logs));
		return logs;
	}

	async function uniquesOf(table: string): Promise<UniqueConstraint[]> {
		return await db.query(`
			SELECT c.conname AS "name", pg_get_constraintdef(c.oid) AS "definition", substring(pg_get_indexdef(c.conindid) FROM ' (USING .*)$') AS "body", p.conname AS "parent"
			FROM pg_constraint c
			LEFT JOIN pg_constraint p ON p.oid = c.conparentid
			WHERE c.conrelid = $1::regclass AND c.contype = 'u'
			ORDER BY c.conname
		`, [table]);
	}

	function statementsOf(longQuery: { mock: { calls: unknown[][] } }, pattern: RegExp): { sql: string; runner: unknown }[] {
		return longQuery.mock.calls.flatMap(([sql, , runner]) => typeof sql === 'string' && pattern.test(sql) ? [{ sql, runner }] : []);
	}

	async function expectDroppable(statements: string[]): Promise<void> {
		const runner = db.createQueryRunner();
		await runner.connect();
		try {
			await runner.startTransaction();
			for (const sql of statements) await runner.query(sql);
		} finally {
			if (runner.isTransactionActive) await runner.rollbackTransaction();
			await runner.release();
		}
	}

	async function cancelBuild(table: string, sql: string): Promise<void> {
		const holder = db.createQueryRunner();
		await holder.connect();
		try {
			await holder.startTransaction('REPEATABLE READ');
			await holder.query(`SELECT count(*) FROM "${table}"`);
			const building = db.query(sql).then(() => null, (e: unknown) => String(e));
			await waitUntilBlockedBy(db, holder, /^CREATE UNIQUE INDEX CONCURRENTLY /);
			await db.query('SELECT pg_cancel_backend("pid") FROM "pg_stat_activity" WHERE "datname" = current_database() AND "query" LIKE \'CREATE UNIQUE INDEX CONCURRENTLY%\'');
			expect(await building).toContain('canceling statement');
		} finally {
			if (holder.isTransactionActive) await holder.rollbackTransaction();
			await holder.release();
		}
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		usersRepository = app.get(DI.usersRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		catalog = inspector(db);

		await dropSyncFunctions(db);
		await createShadows(db);
		author = await createUser();
		reactor = await createUser();
		config.partitionMigration = { liveTable: 'plain', dropOldTables: false };
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await app.close();
	});

	test('a UNIQUE constraint of the live plain copies is added to the partitioned copies as a constraint of the same name and definition, which keeps the name through the switch so that an upstream DROP CONSTRAINT succeeds, while one without the partition key is an index there', async () => {
		const built = await runJob();
		expect(built).toContain('phase noteIndexes finished');
		expect(built).toContain('suspended at noteCutover');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_FORWARD" UNIQUE NULLS NOT DISTINCT ("id", "uri") INCLUDE ("userId") WITH (fillfactor = 90) DEFERRABLE INITIALLY DEFERRED');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_KEYLESS" UNIQUE ("cw")');
		await db.query('ALTER TABLE "note_reaction" ADD CONSTRAINT "UQ_TEST_REACTION" UNIQUE ("noteId", "reaction", "userId")');
		const live = { note: await uniquesOf('note'), note_reaction: await uniquesOf('note_reaction') };
		expect(live.note.map(constraint => constraint.name)).toEqual(['UQ_TEST_FORWARD', 'UQ_TEST_KEYLESS']);
		for (const ord of [0, 1, 2]) await react(await insertNote(ord), reactor);
		config.partitionMigration.liveTable = 'partitioned';
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		const adding = 'adding UQ_TEST_FORWARD, UQ_TEST_KEYLESS of note to note_p';
		expect(logs.indexOf(adding)).toBeGreaterThanOrEqual(0);
		expect(logs.indexOf(adding)).toBeLessThan(logs.indexOf('note switched to the partitioned copy'));
		expect(logs).toContain('note_reaction switched to the partitioned copy');
		const forward = statementsOf(longQuery, /"UQ_TEST_FORWARD_mig/);
		expect(forward.map(({ sql, runner }) => [sql, runner != null])).toEqual([
			['ALTER TABLE ONLY "note_p" ADD CONSTRAINT "UQ_TEST_FORWARD_mig" UNIQUE NULLS NOT DISTINCT (id, uri) INCLUDE ("userId") WITH (fillfactor=\'90\') DEFERRABLE INITIALLY DEFERRED', true],
			...prefixes.flatMap(prefix => [
				[`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_TEST_FORWARD_mig_${prefix}" ON "note_p_${prefix}" USING btree (id, uri) INCLUDE ("userId") NULLS NOT DISTINCT WITH (fillfactor='90')`, false],
				[`ALTER TABLE "note_p_${prefix}" ADD CONSTRAINT "UQ_TEST_FORWARD_mig_${prefix}" UNIQUE USING INDEX "UQ_TEST_FORWARD_mig_${prefix}" DEFERRABLE INITIALLY DEFERRED`, true],
				[`ALTER INDEX "UQ_TEST_FORWARD_mig" ATTACH PARTITION "UQ_TEST_FORWARD_mig_${prefix}"`, true],
			]),
		]);
		for (let i = 2; i < forward.length; i += 3) expect(forward[i].runner).toBe(forward[i + 1].runner);
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('p');
		expect(await uniquesOf('note')).toEqual(live.note.filter(constraint => constraint.name !== 'UQ_TEST_KEYLESS'));
		expect(await uniquesOf('note_reaction')).toEqual(live.note_reaction);
		expect(await uniquesOf('note_old')).toEqual(live.note.map(constraint => ({ ...constraint, name: `${constraint.name}_old` })));
		expect(await uniquesOf('note_reaction_old')).toEqual(live.note_reaction.map(constraint => ({ ...constraint, name: `${constraint.name}_old` })));
		for (const prefix of prefixes) {
			expect(await uniquesOf(`note_p_${prefix}`)).toEqual([{ ...live.note[0], name: `UQ_TEST_FORWARD_mig_${prefix}`, parent: 'UQ_TEST_FORWARD' }]);
			expect(await uniquesOf(`note_reaction_p_${prefix}`)).toEqual([{ ...live.note_reaction[0], name: `UQ_TEST_REACTION_mig_${prefix}`, parent: 'UQ_TEST_REACTION' }]);
		}
		expect(await catalog.index('UQ_TEST_KEYLESS')).toEqual({ table: 'note', unique: false, valid: true, attached: false, body: 'USING btree (cw)' });

		await db.query('ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_FORWARD"');
		await db.query('ALTER TABLE "note_reaction" DROP CONSTRAINT "UQ_TEST_REACTION"');
		expect(await uniquesOf('note')).toEqual([]);
		expect(await uniquesOf('note_p_00')).toEqual([]);

		const next = await runJob();

		expect(next.slice(0, 2)).toEqual([
			'note_old rejects writes that note accepts, dropping UQ_TEST_FORWARD_old',
			'note_reaction_old rejects writes that note_reaction accepts, dropping UQ_TEST_REACTION_old',
		]);
		expect(await uniquesOf('note_old')).toEqual([{ ...live.note[1], name: 'UQ_TEST_KEYLESS_old' }]);
		expect(await uniquesOf('note_reaction_old')).toEqual([]);
	});

	test('a UNIQUE constraint of the live partitioned copy is added to the plain copy as a constraint of the same name and definition before the switch back, which an upstream DROP CONSTRAINT then finds, and the one without the partition key is a constraint of the live plain copy again', async () => {
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_BACKWARD" UNIQUE ("text", "id") DEFERRABLE');
		const [backward] = await uniquesOf('note');
		const [keyless] = await uniquesOf('note_old');
		expect(backward).toMatchObject({ name: 'UQ_TEST_BACKWARD', definition: 'UNIQUE (text, id) DEFERRABLE' });
		config.partitionMigration.liveTable = 'plain';
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		const adding = 'adding UQ_TEST_BACKWARD of note to note_old';
		expect(logs).toContain('note_reaction switched to the plain copy');
		expect(logs.indexOf(adding)).toBeGreaterThanOrEqual(0);
		expect(logs.indexOf(adding)).toBeLessThan(logs.indexOf('note switched to the plain copy'));
		expect(statementsOf(longQuery, /"UQ_TEST_BACKWARD_old"/).map(({ sql, runner }) => [sql, runner != null])).toEqual([
			['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_TEST_BACKWARD_old" ON "note_old" USING btree (text, id)', false],
			['ALTER TABLE "note_old" ADD CONSTRAINT "UQ_TEST_BACKWARD_old" UNIQUE USING INDEX "UQ_TEST_BACKWARD_old" DEFERRABLE', true],
		]);
		expect(await catalog.relkind('note')).toBe('r');
		expect(await uniquesOf('note')).toEqual([backward, { ...keyless, name: 'UQ_TEST_KEYLESS' }]);
		expect(await uniquesOf('note_p')).toEqual([{ ...backward, name: 'UQ_TEST_BACKWARD_mig' }]);
		expect(await catalog.index('UQ_TEST_KEYLESS_mig')).toMatchObject({ table: 'note_p', unique: false, valid: true });

		await db.query('ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_BACKWARD"');
		expect(await uniquesOf('note')).toEqual([{ ...keyless, name: 'UQ_TEST_KEYLESS' }]);
	});

	test('UNIQUE constraints that only the partitioned standby copies or their partitions have are dropped with DROP CONSTRAINT by the next run before anything else, so that the writes on the live plain copies that they failed through the sync succeed', async () => {
		const note = await insertNote(1);
		await db.query('CREATE UNIQUE INDEX "UQ_TEST_STANDBY_mig_01" ON "note_reaction_p_01" ("noteId", "reaction")');
		await db.query('ALTER TABLE "note_reaction_p_01" ADD CONSTRAINT "UQ_TEST_STANDBY_mig_01" UNIQUE USING INDEX "UQ_TEST_STANDBY_mig_01"');
		await react(note, author);
		try {
			await expect(react(note, reactor)).rejects.toThrow('duplicate key value violates unique constraint "UQ_TEST_STANDBY_mig_01"');
			const longQuery = vi.spyOn(dbLong, 'query');

			const logs = await runJob();

			expect(logs.slice(0, 2)).toEqual([
				'note_p rejects writes that note accepts, dropping UQ_TEST_BACKWARD_mig',
				'note_reaction_p rejects writes that note_reaction accepts, dropping UQ_TEST_STANDBY_mig_01',
			]);
			expect(logs.slice(2).filter(row => row.includes('rejects writes') || row.includes('failed'))).toEqual([]);
			expect(statementsOf(longQuery, /UQ_TEST_(BACKWARD|STANDBY)_mig/).map(({ sql, runner }) => [sql, runner != null])).toEqual([
				['ALTER TABLE "note_p" DROP CONSTRAINT IF EXISTS "UQ_TEST_BACKWARD_mig"', true],
				['ALTER TABLE note_reaction_p_01 DROP CONSTRAINT IF EXISTS "UQ_TEST_STANDBY_mig_01"', true],
			]);
			expect(await uniquesOf('note_p')).toEqual([]);
			expect(await uniquesOf('note_p_01')).toEqual([]);
			expect(await uniquesOf('note_reaction_p_01')).toEqual([]);

			await react(note, reactor);
			expect(await db.query('SELECT count(*)::int AS "count" FROM "note_reaction_p" WHERE "noteId" = $1', [note])).toEqual([{ count: 2 }]);
		} finally {
			await db.query('ALTER TABLE "note_reaction_p_01" DROP CONSTRAINT IF EXISTS "UQ_TEST_STANDBY_mig_01"');
		}
	});

	test('a bare unique index of the partitioned copy where the live copy has the constraint is replaced by the constraint, and a constraint that a killed run left partly attached is completed after the child that a cancelled build left invalid is rebuilt', async () => {
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_REPAIRED" UNIQUE ("id", "renoteId")');
		await db.query('CREATE UNIQUE INDEX "UQ_TEST_REPAIRED_mig" ON "note_p" ("id", "renoteId")');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_RESUMED" UNIQUE ("id", "replyId")');
		try {
			await db.query('ALTER TABLE ONLY "note_p" ADD CONSTRAINT "UQ_TEST_RESUMED_mig" UNIQUE ("id", "replyId")');
			await db.query('CREATE UNIQUE INDEX "UQ_TEST_RESUMED_mig_00" ON "note_p_00" ("id", "replyId")');
			await db.query('ALTER TABLE "note_p_00" ADD CONSTRAINT "UQ_TEST_RESUMED_mig_00" UNIQUE USING INDEX "UQ_TEST_RESUMED_mig_00"');
			await db.query('ALTER INDEX "UQ_TEST_RESUMED_mig" ATTACH PARTITION "UQ_TEST_RESUMED_mig_00"');
			await cancelBuild('note_p_01', 'CREATE UNIQUE INDEX CONCURRENTLY "UQ_TEST_RESUMED_mig_01" ON "note_p_01" ("id", "replyId")');
			await db.query('CREATE UNIQUE INDEX "UQ_TEST_RESUMED_mig_02" ON "note_p_02" ("id", "replyId")');
			expect(await catalog.index('UQ_TEST_RESUMED_mig')).toMatchObject({ table: 'note_p', valid: false });
			expect(await catalog.index('UQ_TEST_RESUMED_mig_01')).toMatchObject({ table: 'note_p_01', valid: false, attached: false });
			const live = await uniquesOf('note');
			config.partitionMigration.liveTable = 'partitioned';
			const longQuery = vi.spyOn(dbLong, 'query');

			const logs = await runJob();

			expect(logs.filter(row => row.startsWith('dropping the stale') || row.startsWith('adding'))).toEqual([
				'dropping the stale UQ_TEST_REPAIRED_mig of note_p',
				'adding UQ_TEST_REPAIRED, UQ_TEST_RESUMED of note to note_p',
			]);
			expect(logs).toContain('note switched to the partitioned copy');
			const child = (name: string, prefix: string) => [
				[`ALTER TABLE "note_p_${prefix}" ADD CONSTRAINT "${name}_mig_${prefix}" UNIQUE USING INDEX "${name}_mig_${prefix}"`, true],
				[`ALTER INDEX "${name}_mig" ATTACH PARTITION "${name}_mig_${prefix}"`, true],
			];
			const build = (name: string, columns: string, prefix: string) => [
				[`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${name}_mig_${prefix}" ON "note_p_${prefix}" USING btree (${columns})`, false],
				...child(name, prefix),
			];
			expect(statementsOf(longQuery, /"UQ_TEST_REPAIRED_mig/).map(({ sql, runner }) => [sql, runner != null])).toEqual([
				['DROP INDEX IF EXISTS "UQ_TEST_REPAIRED_mig"', true],
				['ALTER TABLE ONLY "note_p" ADD CONSTRAINT "UQ_TEST_REPAIRED_mig" UNIQUE (id, "renoteId")', true],
				...prefixes.flatMap(prefix => build('UQ_TEST_REPAIRED', 'id, "renoteId"', prefix)),
			]);
			const resumed = statementsOf(longQuery, /"UQ_TEST_RESUMED_mig/);
			expect(resumed.map(({ sql, runner }) => [sql, runner != null])).toEqual([
				['DROP INDEX CONCURRENTLY IF EXISTS "UQ_TEST_RESUMED_mig_01"', false],
				...build('UQ_TEST_RESUMED', 'id, "replyId"', '01'),
				...child('UQ_TEST_RESUMED', '02'),
				...build('UQ_TEST_RESUMED', 'id, "replyId"', '03'),
			]);
			for (const i of [2, 4, 7]) expect(resumed[i].runner).toBe(resumed[i + 1].runner);
			expect(await catalog.relkind('note')).toBe('p');
			expect(await uniquesOf('note')).toEqual(live.filter(constraint => constraint.name !== 'UQ_TEST_KEYLESS'));
			for (const prefix of prefixes) {
				expect((await uniquesOf(`note_p_${prefix}`)).map(constraint => [constraint.name, constraint.parent])).toEqual([
					[`UQ_TEST_REPAIRED_mig_${prefix}`, 'UQ_TEST_REPAIRED'],
					[`UQ_TEST_RESUMED_mig_${prefix}`, 'UQ_TEST_RESUMED'],
				]);
			}
			expect(await catalog.index('UQ_TEST_RESUMED')).toMatchObject({ table: 'note', unique: true, valid: true });
			await expectDroppable(['ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_REPAIRED"', 'ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_RESUMED"']);
		} finally {
			await db.query('ALTER TABLE "note" DROP CONSTRAINT IF EXISTS "UQ_TEST_REPAIRED"');
			await db.query('ALTER TABLE "note" DROP CONSTRAINT IF EXISTS "UQ_TEST_RESUMED"');
		}
	});

	test('a bare unique index of the plain copy where the live copy has the constraint is made the constraint in place, a constraint where the live copy has a bare unique index is replaced by the index, and an index that a cancelled build left invalid is rebuilt as the constraint', async () => {
		config.partitionMigration.liveTable = 'partitioned';
		await runJob();
		expect(await catalog.relkind('note')).toBe('p');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_PROMOTED" UNIQUE ("id", "channelId")');
		await db.query('CREATE UNIQUE INDEX "UQ_TEST_PROMOTED_old" ON "note_old" ("id", "channelId")');
		const oidOf = async (name: string) => (await db.query('SELECT to_regclass($1)::oid::text AS "oid"', [`"${name}"`]) as { oid: string | null }[])[0].oid;
		const promoted = await oidOf('UQ_TEST_PROMOTED_old');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_DEMOTED" ON "note" ("id", "replyUserId")');
		await db.query('ALTER TABLE "note_old" ADD CONSTRAINT "IDX_TEST_DEMOTED_old" UNIQUE ("id", "replyUserId")');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_REBUILT" UNIQUE ("id", "renoteUserId")');
		await cancelBuild('note_old', 'CREATE UNIQUE INDEX CONCURRENTLY "UQ_TEST_REBUILT_old" ON "note_old" ("id", "renoteUserId")');
		expect(await catalog.index('UQ_TEST_REBUILT_old')).toMatchObject({ table: 'note_old', valid: false });
		const live = await uniquesOf('note');
		config.partitionMigration.liveTable = 'plain';
		const longQuery = vi.spyOn(dbLong, 'query');

		const logs = await runJob();

		expect(logs.filter(row => row.endsWith(' of note_old') || row.endsWith(' to note_old'))).toEqual([
			'dropping the stale IDX_TEST_DEMOTED_old of note_old',
			'adding IDX_TEST_DEMOTED, UQ_TEST_PROMOTED, UQ_TEST_REBUILT of note to note_old',
		]);
		expect(logs).toContain('note switched to the plain copy');
		expect(statementsOf(longQuery, /"(IDX_TEST_DEMOTED|UQ_TEST_PROMOTED|UQ_TEST_REBUILT)_old"/).map(({ sql, runner }) => [sql, runner != null])).toEqual([
			['ALTER TABLE "note_old" DROP CONSTRAINT IF EXISTS "IDX_TEST_DEMOTED_old"', true],
			['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "IDX_TEST_DEMOTED_old" ON "note_old" USING btree (id, "replyUserId")', false],
			['ALTER TABLE "note_old" ADD CONSTRAINT "UQ_TEST_PROMOTED_old" UNIQUE USING INDEX "UQ_TEST_PROMOTED_old"', true],
			['DROP INDEX CONCURRENTLY IF EXISTS "UQ_TEST_REBUILT_old"', false],
			['CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_TEST_REBUILT_old" ON "note_old" USING btree (id, "renoteUserId")', false],
			['ALTER TABLE "note_old" ADD CONSTRAINT "UQ_TEST_REBUILT_old" UNIQUE USING INDEX "UQ_TEST_REBUILT_old"', true],
		]);
		expect(await catalog.relkind('note')).toBe('r');
		expect(await uniquesOf('note')).toEqual([{ name: 'UQ_TEST_KEYLESS', definition: 'UNIQUE (cw)', body: 'USING btree (cw)', parent: null }, ...live]);
		expect(await oidOf('UQ_TEST_PROMOTED')).toBe(promoted);
		expect(await catalog.index('IDX_TEST_DEMOTED')).toEqual({ table: 'note', unique: true, valid: true, attached: false, body: 'USING btree (id, "replyUserId")' });
		await expectDroppable(['ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_PROMOTED"', 'ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_REBUILT"', 'DROP INDEX "IDX_TEST_DEMOTED"']);
	});
});

describe('PartitionMigrationProcessorService with indexes that the live copy redefines during the index build', () => {
	let app: TestingModule;
	let db: DataSource;
	let dbLong: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let catalog: ReturnType<typeof inspector>;
	const prefixes = ['00', '01', '02', '03'];

	async function runJob(logs: string[] = []): Promise<string[]> {
		await service.process(createJob(logs));
		return logs;
	}

	async function uniqueConstraintsOf(table: string): Promise<string[]> {
		const rows: { name: string }[] = await db.query('SELECT conname AS "name" FROM pg_constraint WHERE conrelid = $1::regclass AND contype = \'u\' ORDER BY conname', [table]);
		return rows.map(row => row.name);
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		dbLong = app.get(DI.dbLong);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		catalog = inspector(db);

		await dropSyncFunctions(db);
		await createShadows(db);
		config.partitionMigration = { liveTable: 'plain', dropOldTables: false };
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await app.close();
	});

	test('a parent that a run cut short left with the definition that an upstream migration has since changed under the same name is dropped and built again with its children, so that the build finishes and the switch keeps the names that the upstream migrations drop', async () => {
		await db.query('CREATE INDEX "IDX_TEST_REDEFINED" ON "note" ("cw")');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_CONSTRAINED" ON "note" ("id", "url")');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "UQ_TEST_UNCONSTRAINED" UNIQUE ("id", "threadId")');
		const indexes = (await catalog.indexNames('note')).filter(name => !name.startsWith('PK_'));
		const longQuery = vi.spyOn(dbLong, 'query');
		const isChild = (sql: string) => /^CREATE (UNIQUE )?INDEX CONCURRENTLY /.test(sql);
		const realNow = Date.now;
		const now = vi.spyOn(Date, 'now').mockImplementation(() => longQuery.mock.calls.filter(([sql]) => isChild(sql)).length >= indexes.length ? Number.MAX_SAFE_INTEGER : realNow());

		const cut = await runJob();
		now.mockRestore();

		expect(cut).toContain('suspended at noteIndexes');
		expect(await catalog.index('IDX_TEST_REDEFINED_mig')).toEqual({ table: 'note_p', unique: false, valid: false, attached: false, body: 'USING btree (cw)' });
		expect(await catalog.index('IDX_TEST_REDEFINED_mig_00')).toEqual({ table: 'note_p_00', unique: false, valid: true, attached: true, body: 'USING btree (cw)' });
		expect(await catalog.index('IDX_TEST_REDEFINED_mig_01')).toBe(null);
		expect(await uniqueConstraintsOf('note_p')).toEqual(['UQ_TEST_UNCONSTRAINED_mig']);
		expect(await uniqueConstraintsOf('note_p_00')).toEqual(['UQ_TEST_UNCONSTRAINED_mig_00']);
		expect(await catalog.index('IDX_TEST_CONSTRAINED_mig_00')).toMatchObject({ unique: true, attached: true });

		await db.query('DROP INDEX "IDX_TEST_REDEFINED"');
		await db.query('CREATE UNIQUE INDEX "IDX_TEST_REDEFINED" ON "note" ("id", "cw")');
		await db.query('DROP INDEX "IDX_TEST_CONSTRAINED"');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "IDX_TEST_CONSTRAINED" UNIQUE ("id", "url")');
		await db.query('ALTER TABLE "note" DROP CONSTRAINT "UQ_TEST_UNCONSTRAINED"');
		await db.query('CREATE UNIQUE INDEX "UQ_TEST_UNCONSTRAINED" ON "note" ("id", "threadId")');
		longQuery.mockClear();

		const resumed = await runJob();

		expect(resumed.filter(row => row.includes('rejects writes') || row.includes('failed'))).toEqual([]);
		expect(resumed).toContain('dropping the stale IDX_TEST_CONSTRAINED_mig, IDX_TEST_REDEFINED_mig, UQ_TEST_UNCONSTRAINED_mig of note_p');
		expect(resumed).toContain('phase noteIndexes finished');
		const statements = longQuery.mock.calls.flatMap(([sql, , runner]) => typeof sql === 'string' && /"(IDX_TEST_CONSTRAINED|IDX_TEST_REDEFINED|UQ_TEST_UNCONSTRAINED)_mig/.test(sql) ? [[sql, runner != null]] : []);
		expect(statements).toEqual([
			['DROP INDEX IF EXISTS "IDX_TEST_CONSTRAINED_mig"', true],
			['DROP INDEX IF EXISTS "IDX_TEST_REDEFINED_mig"', true],
			['ALTER TABLE "note_p" DROP CONSTRAINT IF EXISTS "UQ_TEST_UNCONSTRAINED_mig"', true],
			['ALTER TABLE ONLY "note_p" ADD CONSTRAINT "IDX_TEST_CONSTRAINED_mig" UNIQUE (id, url)', true],
			['CREATE UNIQUE INDEX IF NOT EXISTS "IDX_TEST_REDEFINED_mig" ON ONLY "note_p" USING btree (id, cw)', true],
			['CREATE UNIQUE INDEX IF NOT EXISTS "UQ_TEST_UNCONSTRAINED_mig" ON ONLY "note_p" USING btree (id, "threadId")', true],
			...prefixes.flatMap(prefix => [
				[`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "IDX_TEST_CONSTRAINED_mig_${prefix}" ON "note_p_${prefix}" USING btree (id, url)`, false],
				[`ALTER TABLE "note_p_${prefix}" ADD CONSTRAINT "IDX_TEST_CONSTRAINED_mig_${prefix}" UNIQUE USING INDEX "IDX_TEST_CONSTRAINED_mig_${prefix}"`, true],
				[`ALTER INDEX "IDX_TEST_CONSTRAINED_mig" ATTACH PARTITION "IDX_TEST_CONSTRAINED_mig_${prefix}"`, true],
				[`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "IDX_TEST_REDEFINED_mig_${prefix}" ON "note_p_${prefix}" USING btree (id, cw)`, false],
				[`ALTER INDEX "IDX_TEST_REDEFINED_mig" ATTACH PARTITION "IDX_TEST_REDEFINED_mig_${prefix}"`, true],
				[`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "UQ_TEST_UNCONSTRAINED_mig_${prefix}" ON "note_p_${prefix}" USING btree (id, "threadId")`, false],
				[`ALTER INDEX "UQ_TEST_UNCONSTRAINED_mig" ATTACH PARTITION "UQ_TEST_UNCONSTRAINED_mig_${prefix}"`, true],
			]),
		]);
		for (const [name, body] of [['IDX_TEST_CONSTRAINED', 'USING btree (id, url)'], ['IDX_TEST_REDEFINED', 'USING btree (id, cw)'], ['UQ_TEST_UNCONSTRAINED', 'USING btree (id, "threadId")']]) {
			expect(await catalog.index(`${name}_mig`)).toEqual({ table: 'note_p', unique: true, valid: true, attached: false, body });
			for (const prefix of prefixes) {
				expect(await catalog.index(`${name}_mig_${prefix}`)).toEqual({ table: `note_p_${prefix}`, unique: true, valid: true, attached: true, body });
			}
		}
		expect(await uniqueConstraintsOf('note_p')).toEqual(['IDX_TEST_CONSTRAINED_mig']);
		for (const prefix of prefixes) expect(await uniqueConstraintsOf(`note_p_${prefix}`)).toEqual([`IDX_TEST_CONSTRAINED_mig_${prefix}`]);

		config.partitionMigration.liveTable = 'partitioned';
		const switched = await runJob();

		expect(switched).toContain('note switched to the partitioned copy');
		expect(switched.filter(row => row.startsWith('dropping the stale'))).toEqual([]);
		expect(await catalog.relkind('note')).toBe('p');
		const runner = db.createQueryRunner();
		await runner.connect();
		try {
			await runner.startTransaction();
			await runner.query('ALTER TABLE "note" DROP CONSTRAINT "IDX_TEST_CONSTRAINED"');
			await runner.query('DROP INDEX "IDX_TEST_REDEFINED"');
			await runner.query('DROP INDEX "UQ_TEST_UNCONSTRAINED"');
		} finally {
			if (runner.isTransactionActive) await runner.rollbackTransaction();
			await runner.release();
		}
	});
});

describe('PartitionMigrationProcessorService with outward foreign keys under other names', () => {
	let app: TestingModule;
	let db: DataSource;
	let config: Config;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let notesRepository: NotesRepository;
	let noteReactionsRepository: NoteReactionsRepository;
	let catalog: ReturnType<typeof inspector>;
	let author: MiUser;
	const unrelated = 'FOREIGN KEY ("replyUserId") REFERENCES "user"(id) ON DELETE SET NULL';

	async function foreignKeysOf(tables: string[]): Promise<string[]> {
		const rows: { name: string }[] = await db.query('SELECT conrelid::regclass::text || \'.\' || conname || \' \' || pg_get_constraintdef(oid) AS "name" FROM pg_constraint WHERE contype = \'f\' AND conrelid::regclass::text = ANY($1) ORDER BY 1', [tables]);
		return rows.map(row => row.name);
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		config = app.get(DI.config);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		notesRepository = app.get(DI.notesRepository);
		noteReactionsRepository = app.get(DI.noteReactionsRepository);
		catalog = inspector(db);

		await dropSyncFunctions(db);
		await createShadows(db);
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "FK_TEST_NOTE_USER" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "FK_TEST_NOTE_CHANNEL" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE');
		await db.query('ALTER TABLE "note" ADD CONSTRAINT "FK_b1ce5693f9dbf090360f27c475b" FOREIGN KEY ("anonymouslySendToUserId") REFERENCES "user"("id") ON DELETE CASCADE');
		await db.query('ALTER TABLE "note_reaction" ADD CONSTRAINT "FK_TEST_REACTION_USER" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE');
		for (const table of ['note', 'note_p']) {
			await db.query(`ALTER TABLE "${table}" ADD CONSTRAINT "FK_TEST_UNRELATED" ${unrelated}`);
		}
		const id = idService.gen();
		await app.get<UsersRepository>(DI.usersRepository).insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		author = await app.get<UsersRepository>(DI.usersRepository).findOneByOrFail({ id });
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
	});

	afterAll(async () => {
		config.partitionMigration = { liveTable: 'partitioned', dropOldTables: false };
		await dropSyncFunctions(db);
		await app.close();
	});

	test('the outward foreign keys are found by their copy, column and referenced table whatever their names, so both tables switch, while another foreign key of the copies stays', async () => {
		const id = idService.gen(946684800000 + 36 ** 6 + 1000);
		await notesRepository.insert({ id, text: `note_${id}`, userId: author.id, userHost: null, visibility: 'public' });
		await noteReactionsRepository.insert({ id: idService.gen(), noteId: id, userId: author.id, reaction: '👍' });

		const logs: string[] = [];
		await service.process(createJob(logs));

		expect(logs).toContain('phase outwardForeignKeysDrop finished');
		expect(logs).toContain('note switched to the partitioned copy');
		expect(logs).toContain('note_reaction switched to the partitioned copy');
		expect(await catalog.relkind('note')).toBe('p');
		expect(await catalog.relkind('note_reaction')).toBe('p');
		expect(await foreignKeysOf(['note', 'note_old', 'note_reaction', 'note_reaction_old'])).toEqual([
			`note.FK_TEST_UNRELATED ${unrelated}`,
			`note_old.FK_TEST_UNRELATED ${unrelated}`,
		]);
	}, 180_000);
});

describe('PartitionMigrationProcessorService dropping the outward foreign keys while a writer holds the user row', () => {
	let app: TestingModule;
	let db: DataSource;
	let service: PartitionMigrationProcessorService;
	let idService: IdService;
	let notesRepository: NotesRepository;
	let author: MiUser;

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		service = app.get(PartitionMigrationProcessorService);
		idService = app.get(IdService);
		notesRepository = app.get(DI.notesRepository);
		await dropSyncFunctions(db);
		const id = idService.gen();
		await app.get<UsersRepository>(DI.usersRepository).insert({ id, username: `u${id}`, usernameLower: `u${id}` });
		author = await app.get<UsersRepository>(DI.usersRepository).findOneByOrFail({ id });
	});

	afterAll(async () => {
		await dropSyncFunctions(db);
		await app.close();
	});

	test.each([
		['note', async (writer: QueryRunner) => {
			const id = idService.gen();
			await writer.query('INSERT INTO "note" ("id", "userId", "userHost", "visibility", "text") VALUES ($1, $2, NULL, \'public\', $3)', [id, author.id, `note_${id}`]);
		}],
		['note_reaction', async (writer: QueryRunner, noteId: MiNote['id']) => {
			await writer.query('WITH "target" AS (SELECT "id" FROM "note" WHERE "id" = $4 FOR KEY SHARE) INSERT INTO "note_reaction" ("id", "noteId", "userId", "reaction") SELECT $1, "id", $2, $3 FROM "target" RETURNING "id"', [idService.gen(), author.id, '👍', noteId]);
		}],
	] as [string, (writer: QueryRunner, noteId: MiNote['id']) => Promise<void>][])('a writer that locked the user row first writes %s while the job waits, and the job then drops the foreign keys', async (_, write) => {
		await addOutwardForeignKeys(db);
		const noteId = idService.gen();
		await notesRepository.insert({ id: noteId, text: `note_${noteId}`, userId: author.id, userHost: null, visibility: 'public' });
		const logs: string[] = [];
		const writer = db.createQueryRunner();
		await writer.connect();
		try {
			await writer.startTransaction('READ COMMITTED');
			await writer.query('SELECT 1 FROM "user" WHERE "id" = $1 FOR KEY SHARE', [author.id]);

			const dropping = (service as unknown as { runOutwardForeignKeysDrop: (job: Bull.Job, deadline: number) => Promise<boolean> }).runOutwardForeignKeysDrop(createJob(logs), Date.now() + 60_000);
			await waitUntilBlockedBy(db, writer, /^LOCK TABLE "user" IN EXCLUSIVE MODE$/);

			await writer.query('SET LOCAL lock_timeout = \'500ms\'');
			await write(writer, noteId);
			await writer.commitTransaction();

			expect(await dropping).toBe(true);
		} finally {
			if (writer.isTransactionActive) await writer.rollbackTransaction();
			await writer.release();
		}
		expect(logs).toEqual([]);
		expect(await outwardForeignKeys(db)).toEqual([]);
	});
});

describe('PartitionMigrationProcessorService with an index that another backend is still building', () => {
	let app: TestingModule;
	let db: DataSource;
	let service: PartitionMigrationProcessorService;
	let catalog: ReturnType<typeof inspector>;

	function phase(name: string): Phase {
		return (service as unknown as Record<string, Phase>)[name];
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule],
			providers: [PartitionMigrationProcessorService, IdService, queueLoggerServiceMock()],
		}).compile();
		app.enableShutdownHooks();

		db = app.get(DI.db);
		service = app.get(PartitionMigrationProcessorService);
		catalog = inspector(db);
		await dropSyncFunctions(db);
		await createShadows(db);
	});

	afterAll(async () => {
		await dropSyncFunctions(db);
		await app.close();
	});

	test('a phase leaves an index alone while another backend is still building it, and finishes once the build is done', async () => {
		const run = phase('runReactionNoteIdIdIndex');

		expect(await whileBuilding(db, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_NOTE_REACTION_NOTE_ID_ID" ON "note_reaction" ("noteId", "id")', run)).toBe(false);

		expect(await run(createJob(), Date.now() + 60_000)).toBe(true);
		expect(await catalog.index('IDX_NOTE_REACTION_NOTE_ID_ID')).toMatchObject({ table: 'note_reaction', valid: true });
	});

	test('the index sync leaves a partition index alone while another backend is still building it, and attaches it once the build is done', async () => {
		const logs: string[] = [];
		expect(await phase('runReactionPrepare')(createJob(logs), Date.now() + 60_000)).toBe(true);
		const [{ name }]: { name: string }[] = await db.query('SELECT c.relname AS "name" FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE i.indrelid = \'note_reaction\'::regclass AND i.indisunique AND NOT i.indisprimary');
		const child = `${name}_mig_00`;
		const run = phase('runReactionIndexes');

		expect(await whileBuilding(db, `CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS "${child}" ON "note_reaction_p_00" USING btree ("userId", "noteId")`, run)).toBe(false);

		expect(await run(createJob(logs), Date.now() + 60_000)).toBe(true);
		expect(await catalog.index(child)).toMatchObject({ table: 'note_reaction_p_00', valid: true, attached: true, unique: true });
		expect(logs).toEqual([]);
	});

	test('the floor index phase leaves the index alone while another backend is still building it, and finishes once the build is done', async () => {
		const run = phase('runUserNoteIdFloorIndex');

		expect(await whileBuilding(db, 'CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_USER_NOTE_ID_FLOOR" ON "user" ("noteIdFloor") WHERE "noteIdFloor" IS NOT NULL', run)).toBe(false);

		expect(await run(createJob(), Date.now() + 60_000)).toBe(true);
		expect(await catalog.index('IDX_USER_NOTE_ID_FLOOR')).toMatchObject({ table: '"user"', valid: true });
	});

	test('the lookup index build leaves a partition index alone while another backend is still building it, and attaches it once the build is done', async () => {
		const child = 'IDX_NOTE_REACTION_ID_mig_00';
		const run = phase('runReactionLookupIndexes');
		const logs: string[] = [];

		expect(await whileBuilding(db, `CREATE INDEX CONCURRENTLY IF NOT EXISTS "${child}" ON "note_reaction_p_00" USING btree (id)`, run)).toBe(false);

		expect(await run(createJob(logs), Date.now() + 60_000)).toBe(true);
		expect(await catalog.index(child)).toMatchObject({ table: 'note_reaction_p_00', valid: true, attached: true, unique: false });
		expect(logs).toEqual([]);
	});

	test('a unique index of a partition of the standby that another backend is still building is left alone, and dropped as rejecting once the build is done', async () => {
		const name = 'IDX_TEST_REJECTING_00';
		const drop = (service as unknown as { dropRejectingConstraints: (job: Bull.Job, table: string, standby: string, partitioned: boolean) => Promise<boolean> }).dropRejectingConstraints;

		expect(await whileBuilding(db, `CREATE UNIQUE INDEX CONCURRENTLY "${name}" ON "note_reaction_p_00" ("userId", "reaction")`, job => drop(job, 'note_reaction', 'note_reaction_p', true))).toBe(false);
		expect(await catalog.index(name)).toMatchObject({ table: 'note_reaction_p_00', unique: true, valid: true, attached: false });

		const logs: string[] = [];
		expect(await drop(createJob(logs), 'note_reaction', 'note_reaction_p', true)).toBe(true);
		expect(logs).toEqual([`note_reaction_p rejects writes that note_reaction accepts, dropping ${name}`]);
		expect(await catalog.index(name)).toBe(null);
	});
});
