/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { nextPrefix, prefixOf } from '@/misc/partition.js';
import { readPgLog } from '../lib/autoexplain.js';
import { budgeted } from '../lib/budget.js';
import { copyState, existingObjects, objectNames, snapshot } from '../lib/catalog.js';
import { baseFileProblems, c10DeletedIds, c11NoteUri, c12Results, c13Errors, c14aReplay, c14bAutoExplain, c14cLocks, c14dGenericPlans, c14eCoverage, c14fConnections, c15CheckMigrations, c17ThreadKeys, c18PendingRows, c19ThreadMutes, c1CopyState, c20RelationCopies, c21RepliesCount, c22UnlinkMutes, c23JoinWindows, c2Phases, c3RowEquality, c4Schema, c5Indexes, c6Constraints, c7ForeignKeyDeltas, c7ForeignKeys, c8Triggers, c9Locator, catalogHash, childErrors, childIndexCount, copyTableNames, expectedCopies, inspectCopies, jobLogOrder, lockClassOf, oldestJoins, pendingLeftovers, prefixCounts, probeReference, probeResult, probeTargets, readOplogs, rowEquality, unjoinedChildren } from '../lib/checks.js';
import { Child } from '../lib/children.js';
import { Cluster, databases } from '../lib/cluster.js';
import { backendDir, createRun, discardRun, loadEnv } from '../lib/env.js';
import { backfillPhases, checkMigrationsAfterDeploy, checkMigrationsPartitioned, checkMigrationsPlain, createdByOurs, deployedCopies, driftRefusal, droppedByOurs, expectedJobLogs, fixtures, foreignKeysAddedByDeploy, foreignKeysReferencingNote, jobRunBudgetMs, oldestThreadsPerStage, ours, outwardForeignKeys, phases, schedulerJobId, schedulerPeriodMs, schedulerRegistrationIntervalMs, selfForeignKeys, stageExpectations, startupJobId, switchedUniqueConstraints, upstreamSelfForeignKeyRemoval } from '../lib/expected.js';
import { readCaptures, readThreadEvents, replay, statementShape } from '../lib/explain.js';
import { LegacyWriter } from '../lib/legacy-writer.js';
import { Fleet, LockSampler, Monitor, explainEverything, migrationStatus } from '../lib/monitor.js';
import { RedisServer } from '../lib/redis.js';
import { HarnessRoot, repoConfigState } from '../lib/root.js';
import { aid, generateSeed, insertSeed, mulberry32 } from '../lib/seed.js';
import type { Snapshot } from '../lib/catalog.js';
import type { CheckResult, FixtureWindow, OplogEntry, PendingLeftover, ProbeOutput, ProbeTargets, ProcessInfo, StageContext, UnjoinedChild } from '../lib/checks.js';
import type { ChildEvent } from '../lib/children.js';
import type { Database } from '../lib/cluster.js';
import type { HarnessEnv, Run } from '../lib/env.js';
import type { RecordedThreadEvent } from '../lib/explain.js';
import type { DeployProbe, KillRecord, LockPeak, MigrationStatus, RunStart, StagePlan, StageReport } from '../lib/monitor.js';
import type { RedisLoss } from '../lib/redis.js';
import type { Seed } from '../lib/seed.js';
import type { PartitionMigrationSource } from '../lib/source-config.js';
import type pg from 'pg';

type Fixture = { file: string; name: string };

type StageTools = { client: pg.Client; probe: pg.Client; fleet: Fleet; results: CheckResult[]; pending: Promise<unknown>[]; children: Child[]; connect: (name: string) => Promise<pg.Client> };

type QueueRun = RunStart & { endedAt: number | null; holder: boolean | null; logs: string[] };

type ThreadContext = { events: RecordedThreadEvent[]; processes: ProcessInfo[]; leftovers: PendingLeftover[]; unjoined: UnjoinedChild[]; live: 'partitioned' | 'plain' };

type QueueSegment = {
	startedAt: number;
	endedAt: number | null;
	childIndexes: Record<string, number>;
	runs: QueueRun[];
	roles: Record<string, string>;
	kill: KillRecord | null;
	recovery: { afterKillMs: number; kind: string } | null;
	redisLoss: RedisLoss | null;
	pause: { from: number; to: number | null } | null;
	registration: { t: number; afterReadyMs: number } | null;
	keys: { afterLoss: string[]; afterRegistration: string[] };
	problems: string[];
};

type StageSummary = {
	durationMs: number;
	targetMs: number | null;
	kills: Record<string, number>;
	writerKills: number;
	redisLosses: { at: string; afterStartMs: number; downMs: number }[];
	fastForwards: { row: string; attempts: unknown; byMs: number }[];
	notExercised: string[];
	deployProbes: { name: string; outcome: string; ms: number | null; code: string | null; holderQuery: string | null }[];
	errors: Record<string, number>;
	problems: string[];
	locks: Record<string, unknown>;
	pruning: Record<string, unknown>;
	connections: Record<string, unknown>;
	checkMigrations: { asserted: boolean; up: string[]; down: string[] } | null;
	threads: Record<string, unknown>;
	writerOps: number;
	latencies: Record<string, unknown>;
	error: string | null;
};

type StageSpec = {
	stage: string;
	database: Database;
	partitionMigration: PartitionMigrationSource;
	plan: Omit<StagePlan, 'stage' | 'sample' | 'sampleEveryMs' | 'blocker' | 'hooks' | 'deployProbes'>;
	blocker?: { table: string; release: (status: MigrationStatus) => boolean };
	hooks?: (tools: StageTools) => NonNullable<StagePlan['hooks']>;
	deployProbes?: { name: string; phase: string; pattern: RegExp; after: string[]; fixture: Fixture }[];
	afterTarget?: (tools: StageTools) => Promise<void>;
	live: 'partitioned' | 'plain';
	standby: boolean;
	checkMigrations: { up: string[]; down: string[] } | null;
	foreignStages?: string[];
};

const insertNoteSql = 'INSERT INTO "note" ("id", "userId", "visibility") VALUES ($1, $2, \'public\')';

const insertNullPageCountSql = 'INSERT INTO "note" ("id", "userId", "visibility", "pageCount") VALUES ($1, $2, \'public\', NULL)';

const insertReactionSql = 'INSERT INTO "note_reaction" ("id", "noteId", "userId", "reaction") VALUES ($1, $2, $3, $4)';

const minute = 60 * 1000;

const deployAttempts = 3;

const queuePlan = { startAfterChildIndexes: 1500, progress: 300, whileRedisIsDown: 100, runTimeoutMs: 6 * minute };

describe('partition migration', () => {
	let env: HarnessEnv;
	let run: Run;
	let cluster: Cluster;
	let redis: RedisServer;
	let root: HarnessRoot;
	let seed: Seed;
	let baseline: Snapshot;
	let fleet: Fleet | null = null;
	let fleetDatabase: Database | null = null;
	let failed = true;
	let partitionMigration: PartitionMigrationSource = { liveTable: 'partitioned', dropOldTables: false };
	const fleets: Fleet[] = [];
	const fixtureWindows: FixtureWindow[] = [];
	const deployReports: DeployProbe[] = [];
	const deployRetries: { child: string; failedAfterMs: number; error: string }[] = [];
	const legacyDeadlocks: { op: string; message: string }[] = [];
	const repoConfig = repoConfigState();
	const timings: Record<string, number> = {};
	const failures: Record<string, string> = {};
	const stageSummaries: Record<string, StageSummary> = {};
	const checkMigrationsSeen: Record<string, { up: string[]; down: string[] }> = {};
	const queueSegments: QueueSegment[] = [];
	const startedAt = Date.now();
	let probeRuns = 0;

	function useDatabase(database: Database): void {
		root.writeConfig({ pgPort: env.pgPort, database, user: cluster.user, redisPort: env.redisPort, partitionMigration });
	}

	function schemaChild(database: Database, task: string, arg?: string, childEnv?: Record<string, string>): Child {
		useDatabase(database);
		return new Child(run, root.bundleDir, {
			role: 'schema',
			args: arg != null ? [task, arg] : [task],
			env: childEnv,
			expect: { root: root.dir, pgPort: env.pgPort, database, clusterName: cluster.name, redisPort: env.redisPort, redisRunId: redis.runId },
		});
	}

	async function finish(child: Child, result: ChildEvent): Promise<ChildEvent> {
		const code = await child.exited;
		if (code !== 0) throw new Error(`${child.name} exited with ${code} (see ${child.logPath})`);
		const errors = childErrors(child, redis.losses);
		if (errors.length > 0) throw new Error(`${errors.join('; ')} (see ${child.logPath})`);
		return result;
	}

	async function schema(database: Database, task: string, arg?: string): Promise<ChildEvent> {
		const child = schemaChild(database, task, arg);
		return await finish(child, await child.waitFor(event => event.type === 'result', 30 * 60 * 1000));
	}

	function fixturePath(fixture: Fixture): string {
		return join(backendDir, 'test', 'migration', 'fixtures', fixture.file);
	}

	async function applyFixture(database: Database, fixture: Fixture): Promise<void> {
		expect((await schema(database, 'fixture', fixturePath(fixture))).executed).toEqual([fixture.name]);
	}

	async function fixtureWindow(name: string, task: () => Promise<void>): Promise<void> {
		const window = { name, from: Date.now(), to: Infinity };
		fixtureWindows.push(window);
		try {
			await task();
		} finally {
			window.to = Date.now();
		}
	}

	async function stopAll(tools: StageTools): Promise<void> {
		await tools.fleet.stopRunners();
		await tools.fleet.stopWriters();
		await tools.fleet.waitOrphans(tools.client);
	}

	async function restartAndWait(tools: StageTools, log: RegExp): Promise<void> {
		const after = Date.now();
		await tools.fleet.restartRunners(tools.fleet.clockOffsetMs);
		await tools.fleet.waitJobLog(log, after, 10 * minute, true);
	}

	function afterTheJob(tools: StageTools, name: string, log: RegExp, task: () => Promise<void>): void {
		const after = Date.now();
		tools.pending.push(fixtureWindow(name, async () => {
			await tools.fleet.waitJobLog(log, after, 10 * minute);
			await task();
		}).then(() => null, (e: unknown) => e));
	}

	async function eventually(task: () => Promise<unknown>, rejection: string, timeoutMs = 2 * minute): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			try {
				await task();
				return;
			} catch (e) {
				if ((e as { code?: string }).code !== rejection || Date.now() > deadline) throw e;
			}
			await setTimeout(200);
		}
	}

	async function expectRejection(client: pg.Client, sql: string, values: unknown[], code: string, raisedIn: string): Promise<void> {
		const error = await client.query(sql, values).then(() => null, (e: unknown) => e as { code?: string; where?: string; message: string });
		expect({ code: error?.code, message: error?.message ?? `${sql} ${JSON.stringify(values)} succeeded`, raisedIn: error?.where?.includes(`${raisedIn}()`) ?? false }).toMatchObject({ code, raisedIn: true });
	}

	async function rowsOf(client: pg.Client, table: string, key: string, id: string, columns = '1 AS "found"'): Promise<Record<string, unknown>[]> {
		return await budgeted(client, 'data', `SELECT ${columns} FROM "${table}_p_${prefixOf(key)}" WHERE "id" = $1`, [id]);
	}

	function probeNoteId(length: number): string {
		return `zz${Date.now().toString(36).slice(-(length - 2)).padStart(length - 2, '0')}`;
	}

	async function expectRunnerRefusal(tools: StageTools, message: string): Promise<void> {
		const child = new Child(run, root.bundleDir, { role: 'runner', env: { MK_E2E_CLOCK_OFFSET_MS: String(tools.fleet.clockOffsetMs) }, expect: tools.fleet.expectation() });
		tools.children.push(child);
		await child.waitFor(event => event.type === 'ready', 5 * minute).catch(() => null);
		child.kill('SIGKILL');
		const code = await child.exited;
		expect({ code: code === 0 ? 0 : 'failed', ready: child.events.some(event => event.type === 'ready'), message: child.events.filter(event => event.type === 'error').map(event => String(event.message)).join('; ') }).toMatchObject({ code: 'failed', ready: false, message: expect.stringContaining(message) });
		for (let i = 0; (await tools.client.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1', [`mk-e2e-${child.name}`])).rows.length > 0; i++) {
			if (i > 600) throw new Error(`the backend of ${child.name} remains`);
			await setTimeout(100);
		}
	}

	function processes(): ProcessInfo[] {
		return fleets.flatMap(other => other.children).map(child => ({ name: child.name, alive: child.alive, killedAt: child.killedAt }));
	}

	async function waitOldestJoins(stage: string, from: number, timeoutMs: number): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const joins = oldestJoins(readThreadEvents(run, from, Date.now()), readOplogs(run).filter(entry => entry.stage === stage && entry.t >= from));
			const searched = joins.filter(join => join.partitioned && join.complete > 0).length;
			if (searched >= oldestThreadsPerStage) return;
			if (Date.now() > deadline) throw new Error(`${stage}: ${searched} of ${oldestThreadsPerStage} oldest-partition children were joined with the partitioned copy live and searched every partition within ${timeoutMs} ms: ${JSON.stringify(joins)}`);
			await setTimeout(1000);
		}
	}

	async function dailyClean(database: Database): Promise<ChildEvent> {
		useDatabase(database);
		const child = new Child(run, root.bundleDir, {
			role: 'clean',
			entry: 'runner',
			env: { MK_E2E_RUNNER_MODE: 'clean' },
			expect: { root: root.dir, pgPort: env.pgPort, database, clusterName: cluster.name, redisPort: env.redisPort, redisRunId: redis.runId },
		});
		return await finish(child, await child.waitFor(event => event.type === 'result', 10 * minute));
	}

	function artifact(name: string, value: unknown): void {
		writeFileSync(run.path('artifacts', name), JSON.stringify(value, null, '\t'));
	}

	function latencies(entries: OplogEntry[]): Record<string, { count: number; errors: number; p50: number; p95: number; max: number }> {
		const result: Record<string, { count: number; errors: number; p50: number; p95: number; max: number }> = {};
		for (const [op, group] of Map.groupBy(entries, entry => entry.op)) {
			const sorted = group.map(entry => entry.latencyMs).sort((a, b) => a - b);
			const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]);
			result[op] = { count: group.length, errors: group.filter(entry => entry.error != null).length, p50: at(0.5), p95: at(0.95), max: at(1) };
		}
		return result;
	}

	async function quietRuns(current: Fleet, count: number, timeoutMs: number): Promise<void> {
		const begin = current.runEnds.length;
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const ends = current.runEnds.slice(begin).filter(end => end.holder);
			if (ends.some(end => end.logs.length > 0)) throw new Error(`a holder run logged after the target: ${ends.filter(end => end.logs.length > 0).map(end => end.logs.join(' | ')).join('; ')}`);
			if (ends.length >= count) return;
			if (Date.now() > deadline) throw new Error(`only ${ends.length} of ${count} holder runs ended within ${timeoutMs} ms`);
			await setTimeout(200);
		}
	}

	async function probe(stage: string, database: Database, client: pg.Client, foreignStages: string[], label: string): Promise<{ result: CheckResult; targets: ProbeTargets }> {
		const index = probeRuns++;
		const targets = probeTargets(seed, stage, index, readOplogs(run).filter(entry => !foreignStages.includes(entry.stage)), run.path('artifacts', `probe-${stage}-${index}.json`));
		const reference = await probeReference(client, targets);
		const targetsPath = run.path('artifacts', `probe-targets-${stage}-${index}.json`);
		writeFileSync(targetsPath, JSON.stringify({ ...targets, reference }, null, '\t'));
		useDatabase(database);
		const child = new Child(run, root.bundleDir, {
			role: 'probe',
			env: { MK_E2E_PROBE_TARGETS: targetsPath, PGOPTIONS: explainEverything },
			expect: { root: root.dir, pgPort: env.pgPort, database, clusterName: cluster.name, redisPort: env.redisPort, redisRunId: redis.runId },
		});
		await finish(child, await child.waitFor(event => event.type === 'result', 10 * minute));
		const output = JSON.parse(readFileSync(targets.output, 'utf-8')) as ProbeOutput;
		const result = probeResult(output, targets, reference, label);
		const errors = (await readPgLog(run, output.startedAt, output.endedAt)).filter(entry => entry.app === `mk-e2e-${child.name}` && entry.severity !== 'LOG');
		result.problems.push(...errors.map(entry => `${entry.severity} ${entry.sqlState} from ${child.name}: ${entry.message}${entry.statement != null ? ` [${entry.statement.trim().slice(0, 200)}]` : ''}`));
		return { result, targets };
	}

	async function queueSegment(tools: StageTools): Promise<void> {
		const current = tools.fleet;
		const client = await tools.connect('queue');
		const snapshotHolder = await tools.connect('snapshot');
		const random = mulberry32(env.seed ^ 0x2a5e9);
		const segment: QueueSegment = { startedAt: Date.now(), endedAt: null, childIndexes: {}, runs: [], roles: {}, kill: null, recovery: null, redisLoss: null, pause: null, registration: null, keys: { afterLoss: [], afterRegistration: [] }, problems: [] };
		queueSegments.push(segment);
		const children: Child[] = [];
		const count = async (label?: string) => {
			const value = await childIndexCount(client, 'note_p');
			if (label != null) segment.childIndexes[label] = value;
			return value;
		};
		const until = async (what: string, timeoutMs: number, done: () => boolean | Promise<boolean>) => {
			const deadline = Date.now() + timeoutMs;
			for (;;) {
				if (await done()) return;
				if (current.unexpected.length > 0) throw new Error(`unexpected exits in S2a: ${current.unexpected.join('; ')}`);
				if (Date.now() > deadline) throw new Error(`S2a: no ${what} within ${timeoutMs} ms`);
				await setTimeout(100);
			}
		};
		const endOf = (start: RunStart) => current.runEnds.find(end => end.child === start.child && end.run === start.run);
		const openRun = (child: Child) => current.runStarts.filter(start => start.child === child.name && endOf(start) == null).at(-1);
		const runningOn = (child: Child) => {
			const start = openRun(child);
			if (start == null) throw new Error(`S2a: ${child.name} has no running job`);
			return start;
		};
		const building = async (child: Child, from: number) => openRun(child) != null && await count() >= from + queuePlan.progress;
		const startRunner = async () => {
			const child = await current.startQueueRunner();
			children.push(child);
			return child;
		};
		const record = (start: RunStart): QueueRun => {
			const end = endOf(start);
			return { ...start, endedAt: end?.t ?? null, holder: end?.holder ?? null, logs: end?.logs ?? [] };
		};
		try {
			await current.stopRunners();
			await current.waitOrphans(client);
			if ((await migrationStatus(client)).finished.has('noteIndexes')) throw new Error('S2a: noteIndexes finished before the queue segment started');
			const begin = await count('start');

			const first = await startRunner();
			await until('queue run building child indexes', queuePlan.runTimeoutMs, () => building(first, begin));
			const killed = runningOn(first);
			segment.roles.killed = `${killed.child}#${killed.run}`;
			const active = (await client.query<{ query: string }>('SELECT left(query, 300) AS "query" FROM pg_stat_activity WHERE application_name = $1 AND state = \'active\'', [`mk-e2e-${first.name}`])).rows.at(0);
			segment.kill = { t: Date.now(), stage: current.stage, trigger: 'S2a', victim: first.name, phase: 'noteIndexes', phaseKill: false, activeQuery: active?.query.trim() ?? null, phaseFinishedAtKill: false, restartDelayMs: 0 };
			current.kills.push(segment.kill);
			await count('killed');
			await current.killQueueRunner();

			const second = await startRunner();
			await current.waitOrphans(client);
			const restarted = await count('restarted');
			await until('queue run building child indexes after the kill (stalled-job recovery or the */5 scheduler)', queuePlan.runTimeoutMs, () => building(second, restarted));
			const recovered = runningOn(second);
			segment.roles.lost = `${recovered.child}#${recovered.run}`;
			segment.recovery = { afterKillMs: recovered.t - segment.kill.t, kind: recovered.jobId === killed.jobId ? 'stalled-job recovery' : recovered.jobId?.startsWith('repeat:') === true ? 'scheduler' : 'other' };

			const lost = await count('redisKilled');
			const loss = redis.lose(2000 + Math.floor(random() * 8001)).then(async result => {
				segment.keys.afterLoss = await redis.keys('*partitionMigration*');
				return result;
			});
			const reappearance = loss.then(async result => {
				while (Date.now() <= result.readyAt + schedulerRegistrationIntervalMs + 30 * 1000) {
					if ((await redis.keys('*:repeat:partitionMigration').catch(() => [])).length > 0) return Date.now();
					await setTimeout(100);
				}
				return null;
			}, () => null);
			await until('child index built while Redis was down', 30 * 1000, async () => await count() >= lost + queuePlan.whileRedisIsDown);
			await snapshotHolder.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
			await snapshotHolder.query('SELECT 1');
			segment.pause = { from: Date.now(), to: null };
			const [{ pid }] = (await snapshotHolder.query<{ pid: number }>('SELECT pg_backend_pid() AS "pid"')).rows;
			await until('CREATE INDEX CONCURRENTLY waiting for the open snapshot', 30 * 1000, async () => (await client.query('SELECT 1 FROM pg_stat_activity WHERE application_name = $1 AND $2 = ANY(pg_blocking_pids(pid))', [`mk-e2e-${second.name}`, pid])).rows.length > 0);
			await count('paused');
			segment.redisLoss = await loss;
			await count('redisReady');
			if (segment.pause.from > segment.redisLoss.readyAt) segment.problems.push(`the run built ${queuePlan.whileRedisIsDown} child indexes only ${segment.pause.from - segment.redisLoss.readyAt} ms after Redis came back`);
			await setTimeout(Math.max(0, recovered.t + jobRunBudgetMs + 2000 - Date.now()));
			await snapshotHolder.query('COMMIT');
			segment.pause.to = Date.now();
			await until('end of the queue run that lost Redis', 2 * minute, () => endOf(recovered) != null);
			const lostEnd = record(recovered).endedAt ?? Date.now();
			await count('ended');

			const ready = segment.redisLoss;
			const registeredAt = await reappearance;
			if (registeredAt == null) throw new Error(`S2a: no registration of the partitionMigration job scheduler again without a restart within ${schedulerRegistrationIntervalMs + 30 * 1000} ms after Redis came back`);
			segment.registration = { t: registeredAt, afterReadyMs: registeredAt - ready.readyAt };
			segment.keys.afterRegistration = await redis.keys('*partitionMigration*');
			const started = [...current.children, ...tools.children].filter(child => child.startedAt >= ready.killedAt).map(child => child.name);
			const registered = await count('registered');
			const due = Math.ceil((registeredAt + 1) / schedulerPeriodMs) * schedulerPeriodMs;
			await until('a run of the registered job scheduler', Math.max(due, lostEnd) + minute - Date.now(), () => current.runStarts.some(start => start.child === second.name && start.t > lostEnd));
			const scheduled = runningOn(second);
			segment.roles.scheduled = `${scheduled.child}#${scheduled.run}`;
			await until('the run of the registered job scheduler building child indexes', queuePlan.runTimeoutMs, () => building(second, registered));
			await count('scheduled');
			await current.killQueueRunner();
			await current.waitOrphans(client);
			await count('end');

			const ended = record(recovered);
			const millis = Number(schedulerJobId.exec(scheduled.jobId ?? '')?.[1] ?? Number.NaN);
			if (killed.jobId !== startupJobId) segment.problems.push(`the first run after the start was the job ${killed.jobId}, not ${startupJobId}`);
			if (!ended.logs.includes('suspended at noteIndexes')) segment.problems.push(`the run that lost Redis logged ${JSON.stringify(ended.logs)}, not "suspended at noteIndexes"`);
			if (ended.endedAt == null || ended.endedAt - recovered.t < jobRunBudgetMs) segment.problems.push(`the run that lost Redis ended ${ended.endedAt == null ? 'never' : `after ${ended.endedAt - recovered.t} ms`}, before its budget of ${jobRunBudgetMs} ms`);
			if (segment.childIndexes.ended <= segment.childIndexes.redisReady) segment.problems.push('the run that lost Redis built no child index after Redis came back');
			if (segment.keys.afterLoss.length > 0) segment.problems.push(`the Redis loss left ${segment.keys.afterLoss.join(', ')}`);
			if (started.length > 0) segment.problems.push(`${started.join(', ')} started after the Redis loss, so the registration of the job scheduler again is not shown to need no restart`);
			if (!(millis % schedulerPeriodMs === 0 && millis >= registeredAt - 1000 && millis <= registeredAt + schedulerPeriodMs + 1000)) segment.problems.push(`the run after the registration was the job ${scheduled.jobId}, not the next run of the scheduler registered at ${new Date(registeredAt).toISOString()}`);
			if ((await migrationStatus(client)).finished.has('noteIndexes')) throw new Error('S2a: the queue segment finished noteIndexes, so the rest of S2 would not run as planned');
		} finally {
			segment.runs = current.runStarts.filter(start => children.some(child => child.name === start.child)).map(record);
			segment.endedAt = Date.now();
			if (segment.pause != null && segment.pause.to == null) await snapshotHolder.query('ROLLBACK').catch(() => {});
		}
		tools.results.push({ check: 'S2a queue', problems: segment.problems, summary: { childIndexes: segment.childIndexes, recovery: segment.recovery, registration: segment.registration, runs: segment.runs.map(other => `${other.child} run ${other.run} ${other.jobId} ${other.holder === false ? 'not holder ' : ''}${other.logs.join(' | ')}`) } });
		await current.restartRunners(current.clockOffsetMs);
	}

	function queueSegmentHook(tools: StageTools): NonNullable<StagePlan['hooks']>[number] {
		let client: pg.Client | null = null;
		return {
			after: 'outwardForeignKeysDrop',
			when: async status => {
				client ??= await tools.connect('queuetrigger');
				return status.finished.has('noteIndexes') || await childIndexCount(client, 'note_p') >= queuePlan.startAfterChildIndexes;
			},
			run: async () => await queueSegment(tools),
		};
	}

	async function c14(stage: string, database: Database, connect: (name: string) => Promise<pg.Client>, client: pg.Client, sampler: LockSampler, window: { from: number; to: number }, foreignStages: string[]): Promise<CheckResult[]> {
		const probeFrom = Date.now();
		const probes: CheckResult[] = [];
		const spans: Record<string, number> = {};
		const partitioned = (await inspectCopies(client, 'note')).live === 'partitioned';
		const span = Math.min(100, seed.model.populatedPrefixes.length);
		for (const flushed of [false, true]) {
			if (flushed) await redis.flushAll();
			const { result, targets } = await probe(stage, database, client, foreignStages, flushed ? 'after FLUSHALL' : 'with Redis');
			probes.push(result);
			if (!partitioned) continue;
			for (const [path, children] of Object.entries({ 'notes/show-partial-bulk': span, 'i/favorites': new Set(targets.favoriteNoteIds.map(prefixOf)).size, 'i/notifications': new Set(targets.notifications.noteIds.map(prefixOf)).size })) spans[path] = Math.max(spans[path] ?? 0, children);
		}
		const statements = await cluster.statementStats(database);
		const peaks = await sampler.stop();
		const probeTo = Date.now();
		const probeCaptures = readCaptures(run, 'probe-', probeFrom, probeTo);
		const captured = [
			...probeCaptures.flatMap(capture => (capture.statements ?? []).map(statement => ({ text: statement.text, values: statement.values, source: `${capture.name} ${statement.tag ?? 'bootstrap'}` }))),
			...readCaptures(run, 'writer-', window.from, window.to).flatMap(capture => capture.shapes.flatMap(shape => [...shape.samples, ...(shape.widest != null ? [shape.widest] : [])].map(sample => ({ text: sample.text, values: sample.values, source: capture.name })))),
		];
		const probeStatements = probeCaptures.flatMap(capture => capture.statements ?? []);
		const transactionPath = (peak: LockPeak) => {
			if (peak.role !== 'probe') return peak.role;
			const sent = probeStatements.filter(statement => statement.processId === peak.pid && statement.t <= peak.t);
			return sent.length > 0 ? sent.reduce((a, b) => (b.t >= a.t ? b : a)).tag ?? 'bootstrap' : 'bootstrap';
		};
		const replays = await replay(await connect('replay'), captured);
		const autoExplain = await c14bAutoExplain(run, window.from, probeTo);
		const results = [
			...probes,
			c14aReplay(replays, cluster.fastPathSlots, spans),
			autoExplain.result,
			c14cLocks(peaks, sampler.maxima, sampler.samples, cluster.fastPathSlots, transactionPath),
			await c14dGenericPlans(await connect('genericplan'), seed.model.users.probe[0], seed.model.populatedPrefixes[Math.floor(seed.model.populatedPrefixes.length / 2)]),
			c14eCoverage(statements, autoExplain.queryIds, autoExplain.texts, replays),
			c14fConnections(readCaptures(run, 'runner-', window.from, window.to)),
		];
		artifact(`c14-${stage}.json`, {
			results,
			replays: replays.filter(other => other.kind === 'replayed').map(other => ({ ...other, text: other.text.replace(/\s+/g, ' ').trim().slice(0, 600), values: JSON.stringify(other.values).slice(0, 300) })),
			notReplayed: [...Map.groupBy(replays.filter(other => other.kind !== 'replayed'), other => `${other.kind} ${statementShape(other.text).slice(0, 200)}`)].map(([shape, group]) => ({ shape, count: group.length })),
			peaks: peaks.toSorted((a, b) => b.relationLocks - a.relationLocks).slice(0, 100),
			maxima: sampler.maxima,
		});
		return results;
	}

	async function failureDiagnostics(client: pg.Client, stage: string): Promise<Record<string, unknown>> {
		const expectation = stageExpectations[stage];
		const attempt = async (task: () => Promise<unknown>) => await task().catch((e: unknown) => `failed: ${String(e)}`);
		return {
			states: await attempt(async () => await budgeted(client, 'catalog', 'SELECT "name", "state", "finishedAt" FROM "partition_migration_state" ORDER BY "name"')),
			activity: await attempt(async () => await budgeted(client, 'catalog', 'SELECT pid, application_name AS "app", state, wait_event_type AS "waitType", wait_event AS "wait", xact_start AS "xactStart", left(query, 500) AS "query" FROM pg_stat_activity WHERE datname = current_database() ORDER BY pid')),
			invalidIndexes: await attempt(async () => await budgeted(client, 'catalog', 'SELECT c.relname AS "name", i.indrelid::regclass::text AS "table" FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relnamespace = \'public\'::regnamespace AND NOT i.indisvalid ORDER BY 1')),
			copies: await attempt(async () => [await c4Schema(client, baseline, expectation), await c5Indexes(client, true, expectation), await c6Constraints(client, baseline, expectation)]),
		};
	}

	async function stageChecks(context: StageContext, expected: ReturnType<typeof expectedCopies>, foreignStages: string[], threads: ThreadContext): Promise<CheckResult[]> {
		const { client } = context;
		const oplogs = readOplogs(context.run).filter(entry => !foreignStages.includes(entry.stage));
		const results: CheckResult[] = [];
		const timed = async (result: Promise<CheckResult>) => {
			const begin = Date.now();
			const value = await result;
			value.summary.ms = Date.now() - begin;
			results.push(value);
		};
		await timed(c1CopyState(client, expected));
		await timed(c2Phases(client));
		await timed(c3RowEquality(client));
		await timed(c4Schema(client, context.baseline, context.expectation));
		await timed(c5Indexes(client, context.partitionedWasLive, context.expectation));
		await timed(c6Constraints(client, context.baseline, context.expectation));
		await timed(c7ForeignKeyDeltas(client, await snapshot(client), context.baseline, [...foreignKeysReferencingNote, ...outwardForeignKeys], [], true));
		await timed(c8Triggers(client, expected));
		await timed(c9Locator(client, oplogs));
		await timed(c10DeletedIds(client, oplogs));
		await timed(c11NoteUri(client));
		await timed(c12Results(client, context.model, oplogs));
		await timed(c17ThreadKeys(client));
		await timed(c18PendingRows(client, threads.leftovers, threads.unjoined));
		await timed(c19ThreadMutes(client, oplogs));
		await timed(c20RelationCopies(client));
		await timed(c21RepliesCount(client, oplogs, threads.processes));
		await timed(c22UnlinkMutes(client, context.model));
		results.push(c23JoinWindows(threads.events, oplogs.filter(entry => entry.stage === context.stage), threads.live, oldestThreadsPerStage));
		results.push(c13Errors(context, oplogs));
		return results;
	}

	function stageSummary(begin: number, report: StageReport | null, results: CheckResult[], c15: { up: string[]; down: string[] } | null, asserted: boolean, oplogs: OplogEntry[], error: string | null): StageSummary {
		const summaryOf = (check: string) => results.find(result => result.check === check)?.summary ?? {};
		const begun = report?.startedAt ?? begin;
		return {
			durationMs: Date.now() - begin,
			targetMs: report?.targetAt != null ? report.targetAt - report.startedAt : null,
			kills: Object.fromEntries([...Map.groupBy(report?.kills ?? [], kill => kill.trigger)].map(([trigger, kills]) => [trigger, kills.length])),
			writerKills: report?.writerKills.length ?? 0,
			redisLosses: (report?.redisLosses ?? []).map(loss => ({ at: new Date(loss.killedAt).toISOString(), afterStartMs: loss.killedAt - begun, downMs: loss.readyAt - loss.killedAt })),
			fastForwards: (report?.fastForwards ?? []).map(other => ({ row: other.row, attempts: other.attempts, byMs: other.toMs - other.fromMs })),
			notExercised: report?.notExercised ?? [],
			deployProbes: (report?.deployProbes ?? []).map(probe => ({ name: probe.name, outcome: probe.outcome, ms: probe.goAt != null && probe.endAt != null ? probe.endAt - probe.goAt : null, code: probe.code, holderQuery: probe.holderQuery })),
			errors: (summaryOf('C13').counts ?? {}) as Record<string, number>,
			problems: results.flatMap(result => result.problems.map(problem => `${result.check}: ${problem}`)),
			locks: summaryOf('C14c lock samples'),
			pruning: { replay: summaryOf('C14a replay'), autoExplain: summaryOf('C14b auto_explain'), genericPlans: summaryOf('C14d generic plans'), coverage: summaryOf('C14e coverage') },
			connections: summaryOf('C14f connection class'),
			checkMigrations: c15 != null ? { asserted, ...c15 } : null,
			threads: Object.fromEntries(['C17 thread keys', 'C18 pending rows', 'C19 thread mutes', 'C20 relation copies', 'C21 repliesCount', 'C22 unlink mutes', 'C23 join windows'].map(check => [check, summaryOf(check)])),
			writerOps: oplogs.length,
			latencies: latencies(oplogs),
			error,
		};
	}

	async function runStage(spec: StageSpec): Promise<Fleet> {
		const { stage, database } = spec;
		const begin = Date.now();
		partitionMigration = spec.partitionMigration;
		if (fleet == null || fleetDatabase !== database) {
			if (fleet != null) {
				await fleet.killWriters();
				await fleet.stopRunners();
			}
			const next = new Fleet({ run, root, cluster, redis, env, database });
			if (fleet != null) next.clockOffsetMs = fleet.clockOffsetMs;
			fleet = next;
			fleetDatabase = database;
			fleets.push(next);
		}
		const current = fleet;
		current.setStage(stage);
		const clients: pg.Client[] = [];
		const children: Child[] = [];
		const connect = async (name: string, options?: string) => {
			const client = await cluster.connect(database, `mk-e2e-harness-${name}`, options);
			clients.push(client);
			return client;
		};
		let sampler: LockSampler | null = null;
		try {
			const client = await connect('main');
			const tools: StageTools = { client, probe: await connect('fixtureprobe', explainEverything), fleet: current, results: [], pending: [], children, connect: async name => await connect(name) };
			await current.killWriters();
			await current.stopRunners();
			await current.waitOrphans(client);
			useDatabase(database);
			await cluster.resetStatementStats();
			sampler = new LockSampler(await connect('locks'), lockClassOf);
			sampler.start();
			let blocker: StagePlan['blocker'];
			if (spec.blocker != null) {
				const blockerClient = await connect('blocker');
				await blockerClient.query('BEGIN');
				await blockerClient.query(`LOCK TABLE ONLY "${spec.blocker.table}" IN ACCESS SHARE MODE`);
				const [{ pid }] = (await blockerClient.query<{ pid: number }>('SELECT pg_backend_pid() AS "pid"')).rows;
				blocker = { client: blockerClient, pid, table: spec.blocker.table, release: spec.blocker.release };
			}
			const deployProbes: NonNullable<StagePlan['deployProbes']> = [];
			for (const probe of spec.deployProbes ?? []) {
				const child = schemaChild(database, 'fixture', fixturePath(probe.fixture), { MK_E2E_SCHEMA_WAIT: '1' });
				children.push(child);
				await child.waitFor(event => event.type === 'ready', 5 * minute);
				deployProbes.push({ name: probe.name, phase: probe.phase, pattern: probe.pattern, after: probe.after, child });
			}
			const from = Date.now();
			await current.startWriters();
			console.log(`${stage}: writers ready after ${Date.now() - from} ms`);
			const monitor = new Monitor(current, { run, root, cluster, redis, env, database }, await connect('monitor'), await connect('state'));
			const sampleClient = await connect('sample');
			const random = mulberry32(env.seed ^ 0x5a3c ^ stage.charCodeAt(1));
			const sampleProblems: string[] = [];
			const sample = async (status: MigrationStatus) => {
				for (const table of copyTableNames) {
					if (!status.finished.has(backfillPhases[table])) continue;
					const prefixes = Array.from({ length: 20 }, () => seed.model.populatedPrefixes[Math.floor(random() * seed.model.populatedPrefixes.length)]);
					try {
						const copies = await inspectCopies(sampleClient, table);
						if (!copies.synced || copies.standby == null) continue;
						sampleProblems.push(...(await rowEquality(sampleClient, copies, prefixes, false)).problems.map(problem => `${new Date().toISOString()} ${problem}`));
					} catch (e) {
						if ((e as { code?: string }).code !== '42P01') throw e;
					}
				}
			};
			let report: StageReport;
			try {
				report = await monitor.run({ ...spec.plan, stage, blocker, hooks: spec.hooks?.(tools), deployProbes, sample, sampleEveryMs: 20 * 1000 });
			} catch (e) {
				const jobLogs = Object.fromEntries([...Map.groupBy(current.jobLogs, log => log.child)].map(([child, logs]) => [child, logs.slice(-200)]));
				artifact(`report-${stage}-failed.json`, { error: String(e), report: (e as { report?: unknown }).report, kills: current.kills, fastForwards: current.fastForwards, unexpected: current.unexpected, runErrors: current.runErrors, jobLogs, ...await failureDiagnostics(client, stage) });
				throw e;
			}
			deployReports.push(...report.deployProbes);
			const pendingErrors = (await Promise.all(tools.pending)).filter(error => error != null);
			if (pendingErrors.length > 0) throw pendingErrors[0];
			console.log(`${stage}: target after ${report.targetAt - report.startedAt} ms, ${report.kills.length} runner kills (${[...new Set(report.kills.map(kill => kill.trigger))].join(', ')}), ${report.writerKills.length} writer kills, ${report.redisLosses.length} Redis losses (${report.redisLosses.map(loss => loss.readyAt - loss.killedAt).join(', ')} ms), ${report.fastForwards.length} fast-forwards${report.blockerReleasedAt != null ? `, blocker released after ${report.blockerReleasedAt - report.startedAt} ms` : ''}, not exercised: ${report.notExercised.join(', ') || 'none'}`);
			for (const probe of report.deployProbes) console.log(`${stage} ${probe.name}: ${probe.outcome}${probe.goAt != null ? ` in ${(probe.endAt ?? probe.goAt) - probe.goAt} ms while the job ran ${probe.holderQuery}` : ''}${probe.error != null ? ` (${probe.code} ${probe.error})` : ''}`);

			if (spec.afterTarget != null) await spec.afterTarget(tools);
			if (spec.live === 'partitioned') await waitOldestJoins(stage, from, 5 * minute);
			const before = await catalogHash(client);
			await quietRuns(current, 3, 10 * minute);
			const after = await catalogHash(client);
			const c16: CheckResult = { check: 'C16', problems: before === after ? [] : [`the catalog changed during three quiet runs (${before} -> ${after})`], summary: { before, after } };

			await current.pauseWriters();
			await current.stopRunners();
			for (const child of children) child.kill('SIGKILL');
			const orphans = await current.waitOrphans(client);
			const quiescent = Date.now();
			const quiescentEvents = readThreadEvents(run, from, quiescent);
			const quiescentLog = await readPgLog(run, from, quiescent);
			const leftovers = await pendingLeftovers(client, quiescentEvents, processes(), quiescentLog);
			const unjoined = await unjoinedChildren(client, readOplogs(run).filter(entry => entry.stage === stage && entry.t >= from), quiescentEvents, processes(), quiescentLog);
			const cleaned = await dailyClean(database);
			console.log(`${stage}: the daily clean ran for ${String(cleaned.ms)} ms after ${leftovers.length} pending rows of linked children were left (${JSON.stringify(leftovers)}) and ${unjoined.length} waiting children were not joined to the parents that arrived (${JSON.stringify(unjoined)})`);
			const to = Date.now();
			const context: StageContext = {
				client,
				run,
				stage,
				baseline,
				model: seed.model,
				from,
				to,
				fleet: current,
				redisLosses: redis.losses.filter(loss => loss.killedAt >= from),
				pgLog: await readPgLog(run, from, to),
				appOf: pid => monitor.appOf(pid),
				pidsOf: app => monitor.pidsOf(app),
				partitionedWasLive: true,
				expectation: stageExpectations[stage],
				fixtureWindows,
				deployProbes: report.deployProbes,
			};
			const results = await stageChecks(context, expectedCopies({ note: spec.live, note_reaction: spec.live }, spec.standby), spec.foreignStages ?? [], { events: readThreadEvents(run, from, to), processes: processes(), leftovers, unjoined, live: spec.live });
			results.push(c16, { check: 'C3 mid-stage', problems: sampleProblems, summary: { samples: report.samples } }, jobLogOrder(stage, current.jobLogs.filter(log => log.t >= from), expectedJobLogs[stage], report.kills.filter(kill => kill.activeQuery === 'COMMIT')), ...tools.results);
			results.push(...await c14(stage, database, connect, client, sampler, { from, to }, spec.foreignStages ?? []));
			const check = await schema(database, 'check');
			artifact(`check-migrations-${stage}.json`, check);
			const c15 = c15CheckMigrations(check);
			if (spec.checkMigrations != null) {
				const expected = c15CheckMigrations(spec.checkMigrations);
				results.push({
					check: 'C15',
					problems: [
						...c15.up.filter(query => !expected.up.includes(query)).map(query => `unexpected up ${query}`),
						...expected.up.filter(query => !c15.up.includes(query)).map(query => `missing up ${query}`),
						...c15.down.filter(query => !expected.down.includes(query)).map(query => `unexpected down ${query}`),
						...expected.down.filter(query => !c15.down.includes(query)).map(query => `missing down ${query}`),
					],
					summary: { up: c15.up.length, down: c15.down.length },
				});
			}
			const partitioned = c15CheckMigrations(checkMigrationsPartitioned);
			const c15Difference = {
				up: [...c15.up.filter(query => !partitioned.up.includes(query)).map(query => `+ ${query}`), ...partitioned.up.filter(query => !c15.up.includes(query)).map(query => `- ${query}`)],
				down: [...c15.down.filter(query => !partitioned.down.includes(query)).map(query => `+ ${query}`), ...partitioned.down.filter(query => !c15.down.includes(query)).map(query => `- ${query}`)],
			};
			const oplogs = readOplogs(run).filter(entry => entry.t >= from && entry.t <= to);
			artifact(`report-${stage}.json`, { report, orphans, checks: results, latencies: latencies(oplogs), writerOps: oplogs.length, checkMigrations: c15, checkMigrationsDifferenceFromPartitioned: c15Difference });
			for (const result of results) console.log(`${stage} ${result.check}: ${result.problems.length === 0 ? 'ok' : `${result.problems.length} problems`} ${JSON.stringify(result.summary).slice(0, 600)}`);
			console.log(`${stage} C15 (${spec.checkMigrations == null ? 'logged' : 'asserted'}): up ${c15.up.length}, down ${c15.down.length}, difference from E_partitioned ${JSON.stringify(c15Difference)}`);
			console.log(`${stage} writer latencies ${JSON.stringify(latencies(oplogs))}`);
			stageSummaries[stage] = stageSummary(begin, report, results, c15, spec.checkMigrations != null, oplogs, null);
			expect(results.flatMap(result => result.problems.map(problem => `${result.check}: ${problem}`))).toEqual([]);
			return current;
		} catch (e) {
			stageSummaries[stage] = { ...stageSummaries[stage] ?? stageSummary(begin, (e as { report?: StageReport }).report ?? null, [], null, false, [], null), error: String(e) };
			throw e;
		} finally {
			await sampler?.stop().catch(() => []);
			for (const child of children) child.kill('SIGKILL');
			for (const client of clients) await client.end().catch(() => {});
		}
	}

	beforeAll(async () => {
		env = await loadEnv();
		run = createRun(env);
		console.log(`run ${run.dir} seed ${env.seed} scale ${env.scale} ${env.pgVersion} ${env.redisVersion}`);
		cluster = new Cluster(env, run);
		await cluster.start();
		redis = new RedisServer(env, run);
		await redis.start();
		root = new HarnessRoot(run);
		root.create();
		failed = false;
	});

	afterEach(({ task }) => {
		timings[task.name] = Date.now() - (task.result?.startTime ?? Date.now());
		if (task.result?.state === 'fail') {
			failed = true;
			failures[task.name] = (task.result.errors ?? []).map(error => error.message).join('; ').slice(0, 4000);
		}
	});

	function runReport(): Record<string, unknown> {
		const kills = fleets.flatMap(other => other.kills);
		return {
			runId: run.id,
			seed: env.seed,
			scale: env.scale,
			postgres: env.pgVersion,
			redis: env.redisVersion,
			queueSegment: env.queue,
			branch: env.branch,
			result: failed ? 'failed' : 'passed',
			startedAt: new Date(startedAt).toISOString(),
			durationMs: Date.now() - startedAt,
			tests: timings,
			failures,
			stages: stageSummaries,
			queue: queueSegments,
			deployProbes: deployReports.map(probe => ({ name: probe.name, outcome: probe.outcome, ms: probe.goAt != null && probe.endAt != null ? probe.endAt - probe.goAt : null, holderQuery: probe.holderQuery, code: probe.code, error: probe.error })),
			deployRetries,
			legacyDeadlocks,
			k3: Object.fromEntries([...Map.groupBy(kills.filter(kill => kill.trigger.startsWith('K3 ')), kill => kill.trigger)].map(([trigger, list]) => [trigger, list.length])),
			checkMigrations: { ...checkMigrationsSeen, ...Object.fromEntries(Object.entries(stageSummaries).flatMap(([stage, summary]) => summary.checkMigrations != null ? [[stage, summary.checkMigrations]] : [])) },
		};
	}

	function summaryLines(report: Record<string, unknown>): string[] {
		const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
		const list = (counts: Record<string, number>) => Object.entries(counts).map(([name, n]) => `${name} ${n}`).join(', ') || 'none';
		const classes = (errors: Record<string, number>) => {
			const byClass: Record<string, number> = {};
			for (const [key, n] of Object.entries(errors)) byClass[key.split(' ')[0]] = (byClass[key.split(' ')[0]] ?? 0) + n;
			return byClass;
		};
		const lines = [`summary of run ${run.id} (seed ${env.seed}, scale ${env.scale}, ${env.pgVersion}, ${env.redisVersion}): ${failed ? 'failed' : 'passed'} in ${seconds(Date.now() - startedAt)}`];
		lines.push(`  tests: ${Object.entries(timings).map(([name, ms]) => `${/^(variant A|S\d+b?)/.exec(name)?.[0] ?? name} ${seconds(ms)}${name in failures ? ' (failed)' : ''}`).join(', ')}`);
		if (deployRetries.length > 0) lines.push(`  S1: the deploy lost a deadlock (40P01), rolled back completely and was run again ${deployRetries.length} times (${deployRetries.map(retry => `${retry.child} after ${seconds(retry.failedAfterMs)}`).join(', ')})`);
		if (legacyDeadlocks.length > 0) lines.push(`  S1: ${legacyDeadlocks.length} legacy writes lost a deadlock (40P01) to the deploy and failed (${legacyDeadlocks.map(deadlock => deadlock.op).join(', ')})`);
		for (const [stage, summary] of Object.entries(stageSummaries)) {
			const windows = (summary.threads['C23 join windows'] ?? {}) as { overlaps?: Record<string, { ops: number; overlapped: number }>; oldest?: { complete: number; partitions: number[] }[]; searchMs?: Record<string, number> | null; paceMs?: Record<string, number> | null };
			lines.push(`  ${stage} threads: overlaps ${Object.entries(windows.overlaps ?? {}).map(([kind, counts]) => `${kind} ${counts.overlapped}/${counts.ops}`).join(', ') || 'none'}; oldest-partition joins ${(windows.oldest ?? []).map(join => `${join.complete} complete rounds of ${join.partitions.join('/')} partitions`).join(', ') || 'none'}; search ms ${JSON.stringify(windows.searchMs ?? null)}; pace ms per partition ${JSON.stringify(windows.paceMs ?? null)}`);
			lines.push(`  ${stage}: ${seconds(summary.durationMs)}${summary.targetMs != null ? `, target after ${seconds(summary.targetMs)}` : ''}; runner kills ${Object.values(summary.kills).reduce((a, b) => a + b, 0)} (${list(summary.kills)}); writer kills ${summary.writerKills}; Redis down ${summary.redisLosses.map(loss => seconds(loss.downMs)).join(', ') || 'never'}; fast-forwards ${summary.fastForwards.map(other => `${other.row} +${seconds(other.byMs)}`).join(', ') || 'none'}; not exercised: ${summary.notExercised.join(', ') || 'none'}; errors by class: ${list(classes(summary.errors))}; check-migrations ${summary.checkMigrations != null ? `up ${summary.checkMigrations.up.length} down ${summary.checkMigrations.down.length} (${summary.checkMigrations.asserted ? 'asserted' : 'logged'})` : '-'}; problems ${summary.problems.length}${summary.error != null ? `; failed: ${summary.error.slice(0, 300)}` : ''}`);
		}
		for (const segment of queueSegments) {
			const c = segment.childIndexes;
			const runOf = (role: string) => segment.runs.find(other => `${other.child}#${other.run}` === segment.roles[role]);
			const killed = runOf('killed');
			const lost = runOf('lost');
			const scheduled = runOf('scheduled');
			lines.push(`  S2a: ${killed != null ? `${killed.jobId} on ${killed.child} killed after +${c.killed - c.start} child indexes` : 'no run was killed'}; ${lost != null ? `${lost.jobId} (${segment.recovery?.kind}) ran ${seconds(segment.recovery?.afterKillMs ?? 0)} after the kill, Redis down ${seconds((segment.redisLoss?.readyAt ?? 0) - (segment.redisLoss?.killedAt ?? 0))} during it with +${c.paused - c.redisKilled} child indexes, ended after ${lost.endedAt != null ? seconds(lost.endedAt - lost.t) : '-'} logging ${lost.logs.join(' | ') || 'nothing'} with +${c.ended - c.redisReady} after Redis came back` : 'no run lost Redis'}; ${segment.registration != null ? `the job scheduler was registered again ${seconds(segment.registration.afterReadyMs)} after Redis came back` : 'the job scheduler was not registered again'}; ${scheduled != null ? `${scheduled.jobId} on ${scheduled.child} started ${seconds(scheduled.t - (segment.registration?.t ?? scheduled.t))} after that and built +${c.scheduled - c.registered}` : 'no run of the registered job scheduler'}; partitionMigration keys after the loss ${segment.keys.afterLoss.length}, after the registration ${segment.keys.afterRegistration.length}; problems ${segment.problems.length}`);
		}
		for (const probe of deployReports) lines.push(`  deploy probe ${probe.name}: ${probe.outcome}${probe.goAt != null && probe.endAt != null ? ` in ${probe.endAt - probe.goAt} ms` : ''}${probe.code != null ? ` (${probe.code})` : ''}`);
		lines.push(`  check-migrations: ${Object.entries(report.checkMigrations as Record<string, { up: string[]; down: string[] }>).map(([stage, check]) => `${stage} up ${check.up.length} down ${check.down.length}`).join(', ')}`);
		lines.push(`  K3 over the run: ${list(report.k3 as Record<string, number>)}`);
		lines.push(`  report: ${run.path('artifacts', 'report.json')}${!failed && !env.keep ? ' (removed with the run directory unless MISSKEY_MIGRATION_E2E_KEEP=1)' : ''}`);
		return lines;
	}

	afterAll(async () => {
		for (const other of fleets) {
			await other.stopWriters().catch(() => {});
			await other.stopRunners().catch(() => {});
		}
		const errors: unknown[] = [];
		const attempt = async (task: () => unknown) => {
			try {
				await task();
			} catch (e) {
				errors.push(e);
			}
		};
		await attempt(async () => await redis?.stop());
		await attempt(() => cluster?.stop());
		console.log(`stage durations (ms): ${JSON.stringify(timings)}`);
		if (run != null) {
			try {
				await attempt(() => artifact('timings.json', timings));
				const report = runReport();
				await attempt(() => artifact('report.json', report));
				console.log(summaryLines(report).join('\n'));
			} finally {
				discardRun(run.dir, !failed && !env.keep && errors.length === 0);
			}
		}
		if (JSON.stringify(repoConfigState()) !== JSON.stringify(repoConfig)) console.warn(`the repository config files changed during the run: ${JSON.stringify(repoConfig)} -> ${JSON.stringify(repoConfigState())}`);
		if (errors.length > 0) throw errors[0];
	});

	test('variant A: the deploy drops the self foreign keys of a database that still has them', async () => {
		const database = databases.selfForeignKeys;
		await cluster.createDatabase(database);
		await schema(database, 'base');
		const client = await cluster.connect(database, 'mk-e2e-harness-variant');
		try {
			expect(await existingObjects(client, { constraints: selfForeignKeys })).toEqual(objectNames({ constraints: selfForeignKeys }));
			await insertSeed(client, generateSeed({ seed: env.seed, scale: 1, now: Date.now(), variant: 'small' }).tables);
			const before = await snapshot(client);
			expect((await schema(database, 'deploy')).executed).toEqual(ours);
			const after = await snapshot(client);
			expect(await existingObjects(client, { constraints: selfForeignKeys })).toEqual([]);
			const fks = c7ForeignKeys(after, before, selfForeignKeys, foreignKeysAddedByDeploy);
			expect(fks.actual).toEqual(fks.expected);
			const check = await schema(database, 'check');
			artifact('check-migrations-variant-a.json', check);
			checkMigrationsSeen['variant A'] = c15CheckMigrations(check);
			expect(c15CheckMigrations(check)).toEqual(c15CheckMigrations(checkMigrationsAfterDeploy));
		} finally {
			await client.end();
		}
		await cluster.dropDatabase(database);
	});

	test('S0 HEAD-shaped database', async () => {
		await cluster.createDatabase(databases.main);
		const base = await schema(databases.main, 'base');
		const files = base.files as string[];
		console.log(`BASE: ${files.length} migrations up to ${basename(files[files.length - 1])}`);
		expect(baseFileProblems(files)).toEqual([]);
		expect((await schema(databases.main, 'self-fk-upstream')).executed).toEqual([upstreamSelfForeignKeyRemoval]);
		const client = await cluster.connect(databases.main, 'mk-e2e-harness-main');
		try {
			seed = generateSeed({ seed: env.seed, scale: env.scale, now: Date.now(), variant: 'main' });
			artifact('seed-model.json', seed.model);
			await insertSeed(client, seed.tables);
			baseline = await snapshot(client);
			artifact('baseline.json', baseline);
			expect(await existingObjects(client, createdByOurs)).toEqual([]);
			expect(await existingObjects(client, droppedByOurs)).toEqual(objectNames({ ...droppedByOurs, constraints: [] }));
			expect(baseline.migrations).toEqual([...base.executed as string[], upstreamSelfForeignKeyRemoval]);
			expect(await prefixCounts(client, 'note', 'id')).toEqual(seed.model.notesPerPrefix);
			expect(await prefixCounts(client, 'note_reaction', 'noteId')).toEqual(seed.model.reactionsPerPrefix);
			console.log(`seed: ${seed.notes.length} notes in ${seed.model.populatedPrefixes.length} prefixes, ${seed.tables.map(([table, rows]) => `${table} ${rows.length}`).join(', ')}, ${seed.model.edgeCases.length} edge cases`);
		} finally {
			await client.end();
		}
	});

	test('S1 deploy with legacy writes', async () => {
		const client = await cluster.connect(databases.main, 'mk-e2e-harness-main');
		const legacyClient = await cluster.connect(databases.main, 'mk-e2e-legacy-1');
		try {
			const legacy = new LegacyWriter(legacyClient, seed, mulberry32(env.seed ^ 0x1e9ac7), run.path('oplog', 'legacy-1.jsonl'), 'S1');
			legacy.start();
			await setTimeout(2000);
			const started = Date.now();
			let child = schemaChild(databases.main, 'deploy');
			let deployed: ChildEvent;
			try {
				for (;;) {
					try {
						deployed = await child.waitFor(event => event.type === 'result', 30 * 60 * 1000);
						break;
					} catch (e) {
						const error = child.events.find(event => event.type === 'error');
						if (error?.code !== '40P01' || deployRetries.length + 1 >= deployAttempts) throw e;
						expect(await snapshot(client), `the deploy that lost a deadlock did not roll back completely: ${String(e)}`).toEqual(baseline);
						deployRetries.push({ child: child.name, failedAfterMs: error.t - child.startedAt, error: String(error.message) });
						console.log(`deploy attempt ${deployRetries.length} (${child.name}) lost a deadlock (40P01) ${error.t - child.startedAt} ms after it started and rolled back completely; deploying again while the legacy writer keeps writing`);
						child = schemaChild(databases.main, 'deploy');
					}
				}
				await setTimeout(2000);
			} finally {
				const writes = await legacy.stop();
				legacyDeadlocks.push(...writes.errors.filter(error => error.code === '40P01').map(error => ({ op: error.op, message: error.message })));
				artifact('legacy-S1.json', { deployStartedAt: started, deployRetries, legacyDeadlocks, ...writes });
				console.log(`legacy writer: ${JSON.stringify(writes.ops)}, ${writes.statements} statements, longest ${Math.round(writes.longestMs)} ms at ${writes.longestAt != null ? writes.longestAt - started : null} ms after the deploy started (${writes.longestSql}), errors ${JSON.stringify(writes.errors)}, ${legacyDeadlocks.length} of them lost a deadlock (40P01) to the deploy`);
				expect(writes.errors.filter(error => error.code !== '40P01')).toEqual([]);
			}
			console.log(`deploy committed ${deployed.t - started} ms after it started${deployRetries.length > 0 ? ` (attempt ${deployRetries.length + 1}, ${deployed.t - child.startedAt} ms after that attempt started)` : ''}`);
			expect((await finish(child, deployed)).executed).toEqual(ours);

			const current = await snapshot(client);
			artifact('deployed.json', current);
			expect(current.migrations).toEqual([...baseline.migrations, ...ours]);
			expect(await existingObjects(client, createdByOurs)).toEqual(objectNames(createdByOurs));
			expect(await existingObjects(client, droppedByOurs)).toEqual([]);
			expect(await copyState(client)).toEqual(deployedCopies);
			const fks = c7ForeignKeys(current, baseline, [], foreignKeysAddedByDeploy);
			expect(fks.actual).toEqual(fks.expected);
			const check = await schema(databases.main, 'check');
			artifact('check-migrations-S1.json', check);
			checkMigrationsSeen.S1 = c15CheckMigrations(check);
			expect(c15CheckMigrations(check)).toEqual(c15CheckMigrations(checkMigrationsAfterDeploy));
		} finally {
			await legacyClient.end();
			await client.end();
		}
	});

	test('S2 job until cutover, with the coexistence fixtures and the deploy probes', async () => {
		const probeUser = seed.model.users.probe[0];
		await runStage({
			stage: 'S2',
			database: databases.main,
			partitionMigration: { liveTable: 'partitioned', dropOldTables: false },
			live: 'partitioned',
			standby: true,
			checkMigrations: null,
			plan: {
				deadlineMs: 120 * minute,
				target: status => phases.every(phase => status.finished.has(phase)) && copyTableNames.every(table => status.copies[table].kind === 'p' && status.copies[table].old && status.copies[table].synced),
				k1MinUnfinished: 8,
				k2: { K2a: 3, K2b: 1, K2c: 2, 'K2d note_p': 1, 'K2d note_reaction_p': 1, K2e: 1, K2f: 1, K2g: 1, 'K2h validate': 1, 'K2h add': 1, K2i: 1, K2j: 1, K2k: 1 },
				k3: ['note', 'note_reaction'],
				scarce: {
					noteInvertedRelationUnlink: ['K2j'],
					notePrepare: ['K2e'],
					noteBackfill: ['K2d note_p'],
					outwardForeignKeysDrop: ['K2k'],
					noteCutover: ['K3 note', 'K2g'],
					noteAnalyze: ['K2i'],
					reactionPrepare: ['K2e'],
					reactionBackfill: ['K2d note_reaction_p'],
					reactionLocatorFill: ['K2f'],
					noteReactionCutover: ['K3 note_reaction', 'K2g'],
					reactionAnalyze: ['K2i'],
				},
				randomKillMeanMs: 20 * 1000,
				writerKills: [{ phase: 'noteRelationBackfill', writer: 'a', delayMs: [500, 5000] }, { phase: 'noteIndexes', writer: 'b', delayMs: [5000, 20 * 1000] }],
				redisLosses: [{ phase: 'noteBackfill', delayMs: [0, 3000] }, { phase: 'reactionPrepare', delayMs: [0, 3000] }],
			},
			deployProbes: [
				{ name: 'D1 during the backfill of note_p', phase: 'noteBackfill', pattern: /INSERT INTO "note_p"\s/, after: ['K2d note_p'], fixture: fixtures.deployDuringBackfill },
				{ name: 'D2 during the index build of note_p', phase: 'noteIndexes', pattern: /^\s*CREATE (UNIQUE )?INDEX CONCURRENTLY .* ON "note_p_/, after: ['K2a', 'K2c'], fixture: fixtures.deployDuringIndexBuild },
			],
			hooks: tools => [
				{
					after: 'notePrepare',
					run: async () => {
						const id = probeNoteId(10);
						await fixtureWindow('U1a U1n', async () => {
							await stopAll(tools);
							await applyFixture(databases.main, fixtures.noteCoexistence);
							await expectRejection(tools.probe, insertNullPageCountSql, [id, probeUser], '23502', 'note_sync_to_p');
							await applyFixture(databases.main, fixtures.noteColumnDrift);
							const driftId = probeNoteId(10).replace(/^zz/, 'zy');
							await expectRejection(tools.probe, insertNoteSql, [driftId, probeUser], '42601', 'note_sync_to_p');
							await expectRunnerRefusal(tools, driftRefusal);
							await applyFixture(databases.main, fixtures.noteColumnDriftFix);
							await tools.probe.query(insertNoteSql, [driftId, probeUser]);
							expect(await rowsOf(tools.client, 'note', driftId, driftId)).toEqual([{ found: 1 }]);
							await tools.probe.query('DELETE FROM "note" WHERE "id" = $1', [driftId]);
							expect(await rowsOf(tools.client, 'note', driftId, driftId)).toEqual([]);
							await expectRejection(tools.probe, insertNullPageCountSql, [id, probeUser], '23502', 'note_sync_to_p');
						});
						afterTheJob(tools, 'U1a after the job', /^note_p rejects writes that note accepts, dropping NOT NULL "pageCount"$/, async () => {
							await eventually(() => tools.probe.query(insertNullPageCountSql, [id, probeUser]), '23502');
							await tools.probe.query('UPDATE "note" SET "e2eAdded" = $2 WHERE "id" = $1', [id, 'x']);
							expect(await rowsOf(tools.client, 'note', id, id, '"e2eAdded", "pageCount"')).toEqual([{ e2eAdded: 'x', pageCount: null }]);
							await tools.probe.query('DELETE FROM "note" WHERE "id" = $1', [id]);
							expect(await rowsOf(tools.client, 'note', id, id)).toEqual([]);
						});
						await tools.fleet.startWriters();
						await tools.fleet.restartRunners(tools.fleet.clockOffsetMs);
					},
				},
				...(env.queue ? [queueSegmentHook(tools)] : []),
				{
					after: 'reactionIndexes',
					run: async () => {
						const prefix = seed.model.populatedPrefixes.reduce((a, b) => ((seed.model.reactionsPerPrefix[a] ?? 0) >= (seed.model.reactionsPerPrefix[b] ?? 0) ? a : b));
						const users = [...seed.model.users.local, ...seed.model.users.remote];
						const values: string[] = [];
						await fixtureWindow('U1b', async () => {
							await stopAll(tools);
							await applyFixture(databases.main, fixtures.reactionCoexistence);
							const [pair] = await budgeted<{ noteId: string; userId: string }>(tools.client, 'data', 'SELECT "noteId", "userId" FROM "note_reaction" WHERE "noteId" >= $1 AND "noteId" < $2 AND "userId" = ANY($3) ORDER BY "id" LIMIT 1', [prefix, nextPrefix(prefix), users]);
							values.push(aid(Date.now(), 1295), pair.noteId, pair.userId, '🎉');
							await expectRejection(tools.probe, insertReactionSql, values, '23505', 'note_reaction_sync_to_p');
						});
						afterTheJob(tools, 'U1b after the job', /^note_reaction_p rejects writes that note_reaction accepts, dropping IDX_ad0c221b25672daf2df320a817_mig$/, async () => {
							const [id, noteId] = values;
							await eventually(() => tools.probe.query(insertReactionSql, values), '23505');
							expect(await rowsOf(tools.client, 'note_reaction', noteId, id)).toEqual([{ found: 1 }]);
							await tools.probe.query('DELETE FROM "note_reaction" WHERE "noteId" = $1 AND "id" = $2', [noteId, id]);
							expect(await rowsOf(tools.client, 'note_reaction', noteId, id)).toEqual([]);
						});
						await tools.fleet.startWriters();
						await tools.fleet.restartRunners(tools.fleet.clockOffsetMs);
					},
				},
			],
		});
	});

	test('S3 switch to the plain copies behind a held lock, then U2', async () => {
		const probeUser = seed.model.users.probe[0];
		await runStage({
			stage: 'S3',
			database: databases.main,
			partitionMigration: { liveTable: 'plain', dropOldTables: false },
			live: 'plain',
			standby: true,
			checkMigrations: null,
			blocker: { table: 'note_reaction', release: status => Number(status.states.get('reactionSwitch')?.attempts ?? 0) >= 1 },
			plan: {
				deadlineMs: 30 * minute,
				target: status => copyTableNames.every(table => status.copies[table].kind === 'r' && status.copies[table].p && status.copies[table].synced),
				k1MinUnfinished: 0,
				k2: { K2g: 1 },
				k3: ['note', 'note_reaction'],
				scarce: {},
				randomKillMeanMs: 20 * 1000,
				writerKills: [{ phase: null, writer: 'a', delayMs: [1000, 4000] }, { phase: null, writer: 'b', delayMs: [6000, 12000] }],
				redisLosses: [{ phase: null, delayMs: [2000, 5000] }],
			},
			afterTarget: async tools => {
				await fixtureWindow('U2', async () => {
					await stopAll(tools);
					const [{ duplicates }] = await budgeted<{ duplicates: number }>(tools.client, 'data', 'SELECT count(*)::int AS "duplicates" FROM (SELECT 1 FROM "note_reaction" GROUP BY "userId", "noteId" HAVING count(*) > 1) d');
					console.log(`S3: U2 removes the reactions of ${duplicates} (userId, noteId) pairs that the writers reacted to twice while IDX_ad0c221b25672daf2df320a817 was gone`);
					await applyFixture(databases.main, fixtures.afterPlainSwitch);
					const id = probeNoteId(9);
					await expectRejection(tools.probe, insertNoteSql, [id, probeUser], '23514', 'note_sync_to_p');
					await restartAndWait(tools, /^note_p rejects writes that note accepts, dropping CHK_e2e_note_id_length$/);
					await tools.probe.query(insertNoteSql, [id, probeUser]);
					expect(await rowsOf(tools.client, 'note', id, id)).toEqual([{ found: 1 }]);
					await tools.probe.query('DELETE FROM "note" WHERE "id" = $1', [id]);
					expect(await rowsOf(tools.client, 'note', id, id)).toEqual([]);
					await tools.fleet.startWriters();
				});
			},
		});
	});

	test('S4 switch to the partitioned copies, then U3, then the clone', async () => {
		const current = await runStage({
			stage: 'S4',
			database: databases.main,
			partitionMigration: { liveTable: 'partitioned', dropOldTables: false },
			live: 'partitioned',
			standby: true,
			checkMigrations: null,
			plan: {
				deadlineMs: 30 * minute,
				target: status => copyTableNames.every(table => status.copies[table].kind === 'p' && status.copies[table].old && status.copies[table].synced),
				k1MinUnfinished: 0,
				k2: { K2a: 3, K2c: 2, K2g: 1, 'K2h add': 1, 'K2h validate': 1 },
				k3: ['note', 'note_reaction'],
				scarce: {},
				randomKillMeanMs: 20 * 1000,
				writerKills: [{ phase: null, writer: 'a', delayMs: [1000, 4000] }, { phase: null, writer: 'b', delayMs: [6000, 12000] }],
				redisLosses: [{ phase: null, delayMs: [2000, 5000] }],
			},
			afterTarget: async tools => {
				const unique = await budgeted<{ table: string; name: string }>(tools.client, 'catalog', 'SELECT conrelid::regclass::text AS "table", conname AS "name" FROM pg_constraint WHERE contype = \'u\' AND conrelid IN (\'note_reaction\'::regclass, \'note_reaction_old\'::regclass) ORDER BY 1, 2');
				const expected = Object.entries(switchedUniqueConstraints).map(([table, name]) => ({ table, name }));
				tools.results.push({ check: 'C6 UNIQUE at the switch', problems: JSON.stringify(unique) === JSON.stringify(expected) ? [] : [`the UNIQUE constraints after the switch are ${JSON.stringify(unique)}, expected ${JSON.stringify(expected)}`], summary: { unique } });
				await fixtureWindow('U3', async () => {
					await stopAll(tools);
					await applyFixture(databases.main, fixtures.afterPartitionedSwitch);
					await restartAndWait(tools, /^note_reaction_old rejects writes that note_reaction accepts, dropping UQ_e2e_reaction_note_user_reaction_old$/);
					await tools.fleet.startWriters();
				});
			},
		});
		await current.killWriters();
		await current.stopRunners();
		if (!env.branch) return;
		const client = await cluster.connect(databases.main, 'mk-e2e-harness-main');
		try {
			await current.waitOrphans(client);
			const [{ size }] = (await client.query<{ size: string }>('SELECT pg_size_pretty(pg_database_size(current_database())) AS "size"')).rows;
			console.log(`S4: ${databases.main} is ${size}`);
		} finally {
			await client.end();
		}
		const begin = Date.now();
		await cluster.cloneDatabase(databases.main, databases.branch);
		console.log(`S4: cloned ${databases.main} into ${databases.branch} in ${Date.now() - begin} ms`);
	});

	test('S5 drop the plain copies behind a held lock', async () => {
		await runStage({
			stage: 'S5',
			database: databases.main,
			partitionMigration: { liveTable: 'partitioned', dropOldTables: true },
			live: 'partitioned',
			standby: false,
			checkMigrations: checkMigrationsPartitioned,
			blocker: { table: 'note_old', release: status => Number(status.states.get('noteDrop')?.attempts ?? 0) >= 1 },
			plan: {
				deadlineMs: 30 * minute,
				target: status => copyTableNames.every(table => status.copies[table].kind === 'p' && !status.copies[table].old && !status.copies[table].p && !status.copies[table].synced),
				k1MinUnfinished: 0,
				k2: {},
				k3: ['note', 'note_reaction'],
				scarce: {},
				randomKillMeanMs: 20 * 1000,
				writerKills: [{ phase: null, writer: 'a', delayMs: [1000, 4000] }, { phase: null, writer: 'b', delayMs: [6000, 12000] }],
				redisLosses: [{ phase: null, delayMs: [2000, 5000] }],
			},
		});
	});

	test('S5b switch the clone back to the plain copies and drop the partitioned ones', async ({ skip }) => {
		skip(!env.branch, 'MISSKEY_MIGRATION_E2E_BRANCH=0');
		await runStage({
			stage: 'S5b',
			database: databases.branch,
			partitionMigration: { liveTable: 'plain', dropOldTables: true },
			live: 'plain',
			standby: false,
			checkMigrations: checkMigrationsPlain,
			foreignStages: ['S5'],
			plan: {
				deadlineMs: 30 * minute,
				target: status => copyTableNames.every(table => status.copies[table].kind === 'r' && !status.copies[table].old && !status.copies[table].p && !status.copies[table].synced),
				k1MinUnfinished: 0,
				k2: { K2a: 1, K2g: 1 },
				k3: ['note', 'note_reaction'],
				scarce: {},
				randomKillMeanMs: 20 * 1000,
				writerKills: [{ phase: null, writer: 'a', delayMs: [1000, 4000] }, { phase: null, writer: 'b', delayMs: [6000, 12000] }],
				redisLosses: [],
			},
		});
	});

	test('K3 over the run', () => {
		const k3 = fleets.flatMap(other => other.kills).filter(kill => kill.trigger.startsWith('K3 '));
		console.log(`K3 over the run: ${JSON.stringify(Object.fromEntries(Map.groupBy(k3, kill => kill.trigger).entries().map(([trigger, kills]) => [trigger, kills.length])))}`);
		artifact('deploy-probes.json', deployReports);
		expect(['K3 note', 'K3 note_reaction'].filter(trigger => !k3.some(kill => kill.trigger === trigger))).toEqual([]);
	});

	test('C23 join windows over the run', () => {
		const overlapped = (kind: string) => Object.values(stageSummaries).reduce((sum, summary) => sum + (((summary.threads['C23 join windows'] ?? {}) as { overlaps?: Record<string, { overlapped: number }> }).overlaps?.[kind]?.overlapped ?? 0), 0);
		const kinds = ['join reply', 'join unmute', 'join delete'];
		console.log(`C23 join windows over the run: ${kinds.map(kind => `${kind} ${overlapped(kind)}`).join(', ')}`);
		expect(kinds.filter(kind => overlapped(kind) === 0)).toEqual([]);
	});
});
