/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import { Child } from './children.js';
import { mulberry32 } from './seed.js';
import type { ChildExpectation, LogLine } from './children.js';
import type { Cluster, Database } from './cluster.js';
import type { HarnessEnv, Run } from './env.js';
import type { RedisLoss, RedisServer } from './redis.js';
import type { HarnessRoot } from './root.js';
import type pg from 'pg';

export const advisoryLockKey = 1787152817411;

export const explainEverything = '-c auto_explain.sample_rate=1';

export type Writer = 'a' | 'b';

export type KillRecord = { t: number; stage: string; trigger: string; victim: string; phase: string | null; phaseKill: boolean; activeQuery: string | null; phaseFinishedAtKill: boolean | null; restartDelayMs: number };

export type JobLog = { t: number; child: string; run: number; row: string };

export type RunStart = { t: number; child: string; run: number; jobId: string | null; attemptsStarted: number | null; stalledCounter: number | null };

type RunEnd = { t: number; child: string; run: number; holder: boolean; logs: string[] };

type RunError = { t: number; child: string; run: number; message: string };

type FastForward = { t: number; stage: string; row: string; attempts: unknown; lastError: unknown; fromMs: number; toMs: number };

type WriterKill = { t: number; stage: string; victim: string };

type ProcessError = { t: number; child: string; kind: string; message: string; stack: string | null };

type LockWait = { t: number; app: string; pid: number; query: string; blockers: { pid: number; app: string | null }[] };

export type DeployProbe = { name: string; phase: string; app: string; goAt: number | null; endAt: number | null; holderQuery: string | null; outcome: 'committed' | 'failed' | 'not exercised'; error: string | null; code: string | null };

type Blocker = { client: pg.Client; pid: number; table: string; release: (status: MigrationStatus) => boolean };

type CopyStatus = { kind: string; old: boolean; p: boolean; synced: boolean };

export type MigrationStatus = {
	t: number;
	finished: Set<string>;
	states: Map<string, Record<string, unknown>>;
	copies: Record<string, CopyStatus>;
};

type FleetContext = {
	run: Run;
	root: HarnessRoot;
	cluster: Cluster;
	redis: RedisServer;
	env: HarnessEnv;
	database: Database;
};

type Backend = { pid: number; app: string; state: string | null; waitType: string | null; query: string; holder: boolean; exclusive: string[]; blockers: number[] | null };

const restartDelays = [0, 200, 1000, 3000];

const activitySql = `
	SELECT a.pid, a.application_name AS "app", a.state, a.wait_event_type AS "waitType", left(a.query, 2000) AS "query",
		coalesce(bool_or(l.locktype = 'advisory' AND l.granted AND l.objsubid = 1 AND ((l.classid::bigint << 32) | l.objid::bigint) = $1), false) AS "holder",
		coalesce(array_agg(DISTINCT c.relname::text) FILTER (WHERE l.locktype = 'relation' AND l.granted AND c.relname = ANY($2)), '{}') AS "exclusive",
		CASE WHEN a.wait_event_type = 'Lock' THEN pg_blocking_pids(a.pid) END AS "blockers"
	FROM pg_stat_activity a
	LEFT JOIN pg_locks l ON l.pid = a.pid AND (l.locktype = 'advisory' OR (l.locktype = 'relation' AND l.mode = 'AccessExclusiveLock'))
	LEFT JOIN pg_class c ON c.oid = l.relation
	WHERE a.datname = current_database() AND a.application_name LIKE 'mk-e2e-%' AND a.pid <> pg_backend_pid()
	GROUP BY a.pid, a.application_name, a.state, a.wait_event_type, a.query
`;

const copiesSql = `
	SELECT c.relname AS "table", c.relkind AS "kind", to_regclass(c.relname || '_old') IS NOT NULL AS "old", to_regclass(c.relname || '_p') IS NOT NULL AS "p",
		EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = c.relname || '_sync') AS "synced"
	FROM pg_class c
	WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('note', 'note_reaction')
`;

export async function migrationStatus(client: pg.Client): Promise<MigrationStatus> {
	const rows = (await client.query<{ name: string; state: Record<string, unknown>; finished: boolean }>('SELECT "name", "state", "finishedAt" IS NOT NULL AS "finished" FROM "partition_migration_state"')).rows;
	const copies = (await client.query<CopyStatus & { table: string }>(copiesSql)).rows;
	return {
		t: Date.now(),
		finished: new Set(rows.filter(row => row.finished).map(row => row.name)),
		states: new Map(rows.map(row => [row.name, row.state])),
		copies: Object.fromEntries(copies.map(({ table, ...copy }) => [table, copy])),
	};
}

export class Fleet {
	public readonly runners: (Child | null)[] = [null, null];
	public readonly writers: Partial<Record<Writer, Child>> = {};
	public readonly children: Child[] = [];
	public readonly kills: KillRecord[] = [];
	public readonly writerKills: WriterKill[] = [];
	public readonly fastForwards: FastForward[] = [];
	public readonly jobLogs: JobLog[] = [];
	public readonly runStarts: RunStart[] = [];
	public readonly runEnds: RunEnd[] = [];
	public readonly runErrors: RunError[] = [];
	public readonly processErrors: ProcessError[] = [];
	public readonly unexpected: string[] = [];
	public readonly lineListeners = new Set<(child: Child, line: LogLine) => void>();
	public clockOffsetMs = 0;
	public stage = 'S0';
	private queueRunner: Child | null = null;
	private readonly pool: Child[] = [];
	private restarts = 0;
	private halted = false;
	private readonly expectedExits = new Set<Child>();
	private readonly pending = new Set<Promise<void>>();
	private readonly random: () => number;

	constructor(private ctx: FleetContext) {
		this.random = mulberry32(ctx.env.seed ^ 0x5eed5 ^ [...ctx.database].reduce((hash, char) => Math.imul(hash ^ char.charCodeAt(0), 16777619) >>> 0, 2166136261));
	}

	public expectation(): ChildExpectation {
		return { root: this.ctx.root.dir, pgPort: this.ctx.env.pgPort, database: this.ctx.database, clusterName: this.ctx.cluster.name, redisPort: this.ctx.env.redisPort, redisRunId: this.ctx.redis.runId };
	}

	public get starting(): boolean {
		return this.children.some(child => child.alive && !child.ready && child.role !== 'schema');
	}

	public get activeRunners(): Child[] {
		return this.runners.filter((child): child is Child => child != null);
	}

	public isActive(child: Child | null): boolean {
		return child != null && child.alive && child.events.some(event => event.type === 'started');
	}

	private adopt(child: Child): void {
		this.children.push(child);
		child.onEvent(event => {
			if (event.type === 'process-error') this.processErrors.push({ t: event.t, child: child.name, kind: String(event.kind), message: String(event.message), stack: typeof event.stack === 'string' ? event.stack : null });
		});
		void child.exited.then(code => {
			if (child.killedAt == null && !this.expectedExits.has(child)) this.unexpected.push(`${child.name} exited with ${code}: ${child.events.filter(event => event.type === 'error').map(event => String(event.message)).join('; ')} (see ${child.logPath})`);
		});
	}

	private track(task: () => Promise<void>): void {
		const promise: Promise<void> = task().catch(e => {
			if (!this.halted) this.unexpected.push(String(e));
		}).finally(() => this.pending.delete(promise));
		this.pending.add(promise);
	}

	public async settle(): Promise<void> {
		while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
	}

	private async spawnRunner(mode: 'direct' | 'queue' = 'direct'): Promise<Child> {
		await this.ctx.redis.up;
		const child = new Child(this.ctx.run, this.ctx.root.bundleDir, {
			role: 'runner',
			env: { MK_E2E_CLOCK_OFFSET_MS: String(mode === 'queue' ? 0 : this.clockOffsetMs), MK_E2E_RUNNER_MODE: mode, PGOPTIONS: explainEverything },
			expect: this.expectation(),
		});
		this.adopt(child);
		const logs = new Map<number, string[]>();
		const numberOrNull = (value: unknown) => typeof value === 'number' ? value : null;
		child.onEvent(event => {
			const run = Number(event.run);
			if (event.type === 'run-start') {
				this.runStarts.push({ t: event.t, child: child.name, run, jobId: typeof event.jobId === 'string' ? event.jobId : null, attemptsStarted: numberOrNull(event.attemptsStarted), stalledCounter: numberOrNull(event.stalledCounter) });
			} else if (event.type === 'job-log') {
				logs.set(run, [...(logs.get(run) ?? []), String(event.row)]);
				this.jobLogs.push({ t: event.t, child: child.name, run, row: String(event.row) });
			} else if (event.type === 'run-end') {
				this.runEnds.push({ t: event.t, child: child.name, run, holder: event.holder === true, logs: logs.get(run) ?? [] });
				logs.delete(run);
			} else if (event.type === 'run-error') {
				this.runErrors.push({ t: event.t, child: child.name, run, message: String(event.message) });
			}
		});
		child.onLine(line => {
			for (const listener of this.lineListeners) listener(child, line);
		});
		return child;
	}

	private pooled(): Child[] {
		for (const child of this.pool.filter(other => other.alive && other.events.some(event => event.type === 'ready' && event.clockOffsetMs !== this.clockOffsetMs))) child.kill('SIGKILL');
		this.pool.splice(0, this.pool.length, ...this.pool.filter(child => child.alive));
		return this.pool;
	}

	private async fill(count: number): Promise<void> {
		const spawned: Child[] = [];
		while (!this.halted && this.pooled().length < count) {
			const child = await this.spawnRunner();
			this.pool.push(child);
			spawned.push(child);
		}
		await Promise.all(spawned.map(child => child.waitFor(event => event.type === 'ready', 5 * 60 * 1000).catch(e => {
			if (child.killedAt == null) throw e;
		})));
	}

	public async warm(count: number): Promise<void> {
		await this.fill(count);
	}

	public async startRunner(slot: number): Promise<Child> {
		let child = this.pooled().find(other => other.ready);
		if (child != null) {
			this.pool.splice(this.pool.indexOf(child), 1);
		} else {
			child = await this.spawnRunner();
			await this.waitReady([child]);
		}
		child.send('start');
		await child.waitFor(event => event.type === 'started', 60 * 1000);
		this.runners[slot] = child;
		if (this.pooled().length === 0) this.track(async () => await this.fill(1));
		return child;
	}

	public async startQueueRunner(): Promise<Child> {
		const child = await this.spawnRunner('queue');
		await this.waitReady([child]);
		child.send('start');
		await child.waitFor(event => event.type === 'started', 60 * 1000);
		this.queueRunner = child;
		return child;
	}

	public async killQueueRunner(): Promise<void> {
		const child = this.queueRunner;
		this.queueRunner = null;
		if (child == null) return;
		child.kill('SIGKILL');
		await child.exited;
	}

	private async startWriter(which: Writer): Promise<Child> {
		await this.ctx.redis.up;
		const child = new Child(this.ctx.run, this.ctx.root.bundleDir, {
			role: `writer-${which}`,
			entry: 'writer',
			env: { MK_E2E_WRITER: which, MK_E2E_WRITER_SEED: String(Math.floor(this.random() * 2 ** 32)), MK_E2E_STAGE: this.stage },
			expect: this.expectation(),
		});
		this.adopt(child);
		this.writers[which] = child;
		return child;
	}

	private async waitReady(children: Child[], timeoutMs = 5 * 60 * 1000): Promise<void> {
		await Promise.all(children.map(child => child.waitFor(event => event.type === 'ready', timeoutMs)));
	}

	public killRunner(slot: number, record: Omit<KillRecord, 'restartDelayMs'>): void {
		const child = this.runners[slot];
		if (child == null) return;
		const restartDelayMs = restartDelays[this.restarts++ % restartDelays.length];
		this.kills.push({ ...record, restartDelayMs });
		child.kill('SIGKILL');
		this.runners[slot] = null;
		this.track(async () => {
			await child.exited;
			await setTimeout(restartDelayMs);
			if (!this.halted) await this.startRunner(slot);
		});
	}

	public killWriter(which: Writer): void {
		const child = this.writers[which];
		if (child == null || !child.alive) return;
		this.writerKills.push({ t: Date.now(), stage: this.stage, victim: child.name });
		child.kill('SIGKILL');
		delete this.writers[which];
		this.track(async () => {
			await child.exited;
			await setTimeout(1000);
			if (!this.halted) await this.waitReady([await this.startWriter(which)]);
		});
	}

	public async stopRunners(): Promise<void> {
		this.halted = true;
		await this.killQueueRunner();
		const kill = async () => {
			for (const child of [...this.runners, ...this.pool, ...this.children.filter(other => other.role === 'runner')]) {
				if (child == null) continue;
				child.kill('SIGKILL');
				await child.exited;
			}
		};
		await kill();
		await this.settle();
		await kill();
		this.runners.fill(null);
		this.pool.splice(0);
		this.halted = false;
	}

	public async restartRunners(offsetMs: number): Promise<void> {
		await this.stopRunners();
		this.clockOffsetMs = offsetMs;
		await this.warm(3);
		await Promise.all([this.startRunner(0), this.startRunner(1)]);
	}

	public async pauseWriters(): Promise<void> {
		this.halted = true;
		await this.settle();
		const after = Date.now();
		const writers = Object.values(this.writers).filter(child => child.alive);
		for (const child of writers) child.send('pause');
		await Promise.all(writers.map(child => child.waitFor(event => event.type === 'paused', 3 * 60 * 1000, after)));
		this.halted = false;
	}

	public setStage(stage: string): void {
		this.stage = stage;
		for (const child of Object.values(this.writers)) child.send(`stage ${stage}`);
	}

	public async stopWriters(): Promise<void> {
		this.halted = true;
		await this.settle();
		for (const [which, child] of Object.entries(this.writers) as [Writer, Child][]) {
			this.expectedExits.add(child);
			child.send('stop');
			const exited = await Promise.race([child.exited.then(() => true), setTimeout(3 * 60 * 1000).then(() => false)]);
			if (!exited) {
				child.kill('SIGKILL');
				await child.exited;
			}
			delete this.writers[which];
		}
		this.halted = false;
	}

	private deadApps(): string[] {
		return this.children.filter(child => !child.alive && child.role !== 'schema').map(child => `mk-e2e-${child.name}`);
	}

	public async killWriters(): Promise<void> {
		this.halted = true;
		await this.settle();
		for (const [which, child] of Object.entries(this.writers) as [Writer, Child][]) {
			child.kill('SIGKILL');
			await child.exited;
			delete this.writers[which];
		}
		this.halted = false;
	}

	public async startWriters(): Promise<void> {
		await this.waitReady([await this.startWriter('a'), await this.startWriter('b')]);
	}

	public async waitJobLog(pattern: RegExp, after: number, timeoutMs: number, runEnd = false): Promise<JobLog> {
		const deadline = Date.now() + timeoutMs;
		for (;;) {
			const log = this.jobLogs.find(other => other.t >= after && pattern.test(other.row));
			if (log != null && (!runEnd || this.runEnds.some(other => other.child === log.child && other.run === log.run))) return log;
			if (this.unexpected.length > 0) throw new Error(`unexpected exits while waiting for ${pattern}: ${this.unexpected.join('; ')}`);
			if (Date.now() > deadline) throw new Error(`no run logged ${pattern}${runEnd ? ' and ended' : ''} within ${timeoutMs} ms`);
			await setTimeout(100);
		}
	}

	public async waitOrphans(client: pg.Client, timeoutMs = 10 * 60 * 1000): Promise<{ waitedMs: number; seen: string[] }> {
		const begin = Date.now();
		const seen = new Set<string>();
		for (;;) {
			const rows = (await client.query<{ pid: number; app: string; state: string; query: string }>('SELECT pid, application_name AS "app", state, left(query, 300) AS "query" FROM pg_stat_activity WHERE application_name = ANY($1)', [this.deadApps()])).rows;
			if (rows.length === 0) return { waitedMs: Date.now() - begin, seen: [...seen] };
			for (const row of rows) seen.add(`${row.app} ${row.state} ${row.query}`);
			if (Date.now() - begin > timeoutMs) throw new Error(`backends of dead processes remain after ${timeoutMs} ms: ${rows.map(row => `${row.app} (${row.pid}, ${row.state}): ${row.query}`).join('; ')}`);
			await setTimeout(200);
		}
	}
}

export type StagePlan = {
	stage: string;
	deadlineMs: number;
	target: (status: MigrationStatus) => boolean;
	k1MinUnfinished: number;
	k2: Record<string, number>;
	k3: string[];
	scarce: Record<string, string[]>;
	randomKillMeanMs: number | null;
	writerKills: { phase: string | null; writer: Writer; delayMs: [number, number] }[];
	redisLosses: { phase: string | null; delayMs: [number, number] }[];
	hooks?: { after: string; when?: (status: MigrationStatus) => Promise<boolean>; run: () => Promise<void> }[];
	blocker?: Blocker;
	deployProbes?: { name: string; phase: string; pattern: RegExp; after: string[]; child: Child }[];
	sample?: (status: MigrationStatus) => Promise<void>;
	sampleEveryMs: number;
};

export type StageReport = {
	stage: string;
	startedAt: number;
	targetAt: number;
	endedAt: number;
	kills: KillRecord[];
	k1Unfinished: string[];
	k2: Record<string, { quota: number; done: number }>;
	k3: string[];
	notExercised: string[];
	writerKills: WriterKill[];
	redisLosses: RedisLoss[];
	fastForwards: FastForward[];
	phases: Record<string, { firstRunningAt: number | null; finishedSeenAt: number | null }>;
	lockWaits: LockWait[];
	samples: number;
	maxBackends: Record<string, number>;
	k4: boolean;
	blockerReleasedAt: number | null;
	deployProbes: DeployProbe[];
};

const k2Patterns: [string, RegExp, boolean][] = [
	['K2a', /^\s*CREATE (UNIQUE )?INDEX CONCURRENTLY/, false],
	['K2b', /^\s*DROP INDEX CONCURRENTLY/, false],
	['K2c', /^\s*ALTER INDEX .* ATTACH PARTITION/, false],
	['K2d note_p', /INSERT INTO "note_p"\s/, false],
	['K2d note_reaction_p', /INSERT INTO "note_reaction_p"\s/, false],
	['K2e', /^\s*CREATE TABLE IF NOT EXISTS "[^"]+" PARTITION OF/, false],
	['K2f', /^\s*INSERT INTO "note_reaction_locator"/, false],
	['K2g', /^\s*SELECT \(SELECT count\(\*\)/, false],
	['K2h validate', /VALIDATE CONSTRAINT/, false],
	['K2h add', /ADD CONSTRAINT .* NOT VALID/, false],
	['K2i', /^\s*ANALYZE /, false],
	['K2j', /"note_unlinked_relation"|"replyId" = CASE WHEN/, true],
	['K2k', /^\s*ALTER TABLE "[^"]+" DROP CONSTRAINT IF EXISTS "FK_/, true],
];

const stallLogs = [/^suspended at \w+$/, /^\S+ is switched to the (partitioned|plain) copy after \S+$/];

export class Monitor {
	private readonly random: () => number;
	private readonly pidApps = new Map<number, string>();
	private readonly currentPhase = new Map<string, string>();
	private readonly seenWaits = new Map<string, { at: number; seenAt: number }>();
	private status: MigrationStatus | null = null;
	private backends: Backend[] = [];

	constructor(private fleet: Fleet, private ctx: FleetContext, private activityClient: pg.Client, private stateClient: pg.Client) {
		this.random = mulberry32(ctx.env.seed ^ 0xc0ffee);
	}

	private between([min, max]: [number, number]): number {
		return min + Math.floor(this.random() * (max - min + 1));
	}

	public appOf(pid: number): string | null {
		return this.pidApps.get(pid) ?? null;
	}

	public pidsOf(app: string): number[] {
		return [...this.pidApps].filter(([, other]) => other === app).map(([pid]) => pid);
	}

	public async run(plan: StagePlan): Promise<StageReport> {
		const fleet = this.fleet;
		const startedAt = Date.now();
		const kills0 = fleet.kills.length;
		const writerKills0 = fleet.writerKills.length;
		const losses0 = this.ctx.redis.losses.length;
		const fastForwards0 = fleet.fastForwards.length;
		const k1Fired = new Set<string>();
		const k1Pending = new Map<string, number>();
		const k2Done: Record<string, number> = Object.fromEntries(Object.keys(plan.k2).map(name => [name, 0]));
		await fleet.warm(3 - fleet.activeRunners.length);
		const k3Done = new Set<string>();
		const anchorsFired = new Set<string>();
		const anchorsDone = new Set<string>();
		const hooksDone = new Set<number>();
		const phases: StageReport['phases'] = {};
		const lockWaits: LockWait[] = [];
		const waiting = new Map<number, string>();
		const maxBackends: Record<string, number> = {};
		const failures: string[] = [];
		const tasks: Promise<void>[] = [];
		const deployProbes: DeployProbe[] = (plan.deployProbes ?? []).map(probe => ({ name: probe.name, phase: probe.phase, app: `mk-e2e-${probe.child.name}`, goAt: null, endAt: null, holderQuery: null, outcome: 'not exercised', error: null, code: null }));
		let killsEnabled = true;
		let busy = false;
		let probing = false;
		let k4 = false;
		let blockerReleasedAt: number | null = null;
		let targetAt: number | null = null;
		let quiet = 0;
		let runEnds0 = fleet.runEnds.length;
		let nextRandomKill = plan.randomKillMeanMs != null ? Date.now() - plan.randomKillMeanMs * Math.log(1 - this.random()) : Infinity;
		let samples = 0;
		let done = false;

		const slotOf = (app: string): number => fleet.runners.findIndex(child => child != null && `mk-e2e-${child.name}` === app);

		const holderSlot = (): number => {
			const holder = this.backends.find(backend => backend.holder && backend.app.startsWith('mk-e2e-runner-'));
			return holder == null ? -1 : slotOf(holder.app);
		};

		const canKill = (slot: number): boolean => {
			const victim = fleet.runners[slot];
			return killsEnabled && !busy && !probing && victim != null && victim.alive && fleet.isActive(fleet.runners[1 - slot]);
		};

		const kill = async (slot: number, trigger: string, backend: Backend | null, phaseKill: boolean): Promise<boolean> => {
			if (!canKill(slot)) return false;
			const victim = fleet.runners[slot]!;
			const phase = this.currentPhase.get(victim.name) ?? null;
			const finished = phase == null ? null : (await this.stateClient.query<{ finished: boolean }>('SELECT "finishedAt" IS NOT NULL AS "finished" FROM "partition_migration_state" WHERE "name" = $1', [phase])).rows[0]?.finished ?? false;
			if (!canKill(slot) || fleet.runners[slot] !== victim) return false;
			fleet.killRunner(slot, { t: Date.now(), stage: plan.stage, trigger, victim: victim.name, phase, phaseKill, activeQuery: backend?.query.trim().slice(0, 300) ?? null, phaseFinishedAtKill: finished });
			return true;
		};

		const remaining = (trigger: string) => trigger.startsWith('K3 ') ? plan.k3.includes(trigger.slice(3)) && !k3Done.has(trigger.slice(3)) : (plan.k2[trigger] ?? 0) > (k2Done[trigger] ?? 0);

		const background = (task: () => Promise<void>) => {
			tasks.push(task().catch(e => {
				failures.push(String(e));
			}));
		};

		const releaseBlocker = async () => {
			if (plan.blocker == null || blockerReleasedAt != null) return;
			blockerReleasedAt = Date.now();
			await plan.blocker.client.query('ROLLBACK');
		};

		const fireAnchors = (phase: string | null) => {
			for (const anchor of plan.writerKills) {
				const key = `W ${anchor.phase} ${anchor.writer}`;
				if (anchor.phase !== phase || anchorsFired.has(key)) continue;
				anchorsFired.add(key);
				background(async () => {
					await setTimeout(this.between(anchor.delayMs));
					while (!done && (busy || fleet.starting)) await setTimeout(100);
					if (done || fleet.writers[anchor.writer]?.alive !== true) return;
					fleet.killWriter(anchor.writer);
					anchorsDone.add(key);
				});
			}
			for (const anchor of plan.redisLosses) {
				const key = `R ${anchor.phase}`;
				if (anchor.phase !== phase || anchorsFired.has(key)) continue;
				anchorsFired.add(key);
				background(async () => {
					await setTimeout(this.between(anchor.delayMs));
					while (!done && (busy || fleet.starting)) await setTimeout(100);
					if (done) return;
					await this.ctx.redis.lose(this.between([2000, 10000]));
					anchorsDone.add(key);
				});
			}
		};

		const onLine = (child: Child, line: { t: number; line: string }) => {
			const match = /running phase (\w+)\.\.\./.exec(line.line);
			if (match == null) return;
			const phase = match[1];
			this.currentPhase.set(child.name, phase);
			phases[phase] ??= { firstRunningAt: line.t, finishedSeenAt: null };
			if (!k1Fired.has(phase) && !k1Pending.has(phase)) k1Pending.set(phase, line.t + this.between([0, 300]));
			fireAnchors(phase);
		};
		fleet.lineListeners.add(onLine);
		for (const slot of [0, 1]) {
			if (fleet.runners[slot] == null) await fleet.startRunner(slot);
		}
		fireAnchors(null);

		const activityLoop = async () => {
			while (!done) {
				const rows = (await this.activityClient.query<Backend>(activitySql, [advisoryLockKey, ['note', 'note_old', 'note_p', 'note_reaction', 'note_reaction_old', 'note_reaction_p']])).rows;
				this.backends = rows;
				const counts: Record<string, number> = {};
				for (const row of rows) {
					this.pidApps.set(row.pid, row.app);
					const role = row.app.replace(/-\d+$/, '');
					counts[role] = (counts[role] ?? 0) + 1;
					if (row.waitType === 'Lock' && row.blockers != null && (row.app.startsWith('mk-e2e-runner-') || row.app.startsWith('mk-e2e-schema-'))) {
						const wait = `${row.query} ${row.blockers.join(',')}`;
						if (waiting.get(row.pid) !== wait) lockWaits.push({ t: Date.now(), app: row.app, pid: row.pid, query: row.query.trim().slice(0, 300), blockers: row.blockers.map(pid => ({ pid, app: this.pidApps.get(pid) ?? null })) });
						waiting.set(row.pid, wait);
					} else {
						waiting.delete(row.pid);
					}
				}
				for (const [role, count] of Object.entries(counts)) maxBackends[role] = Math.max(maxBackends[role] ?? 0, count);
				const slot = holderSlot();
				if (slot >= 0 && killsEnabled && !busy) {
					const holder = fleet.runners[slot]!;
					const holderApp = `mk-e2e-${holder.name}`;
					const own = rows.filter(row => row.app === holderApp);
					const active = own.find(row => row.state === 'active') ?? null;
					const phase = this.currentPhase.get(holder.name) ?? null;
					for (const [i, probe] of (plan.deployProbes ?? []).entries()) {
						const record = deployProbes[i];
						if (record.goAt != null || probing || phase !== probe.phase || !probe.child.ready || active == null || !probe.pattern.test(active.query) || probe.after.some(remaining)) continue;
						probing = true;
						record.goAt = Date.now();
						record.holderQuery = active.query.trim().slice(0, 300);
						probe.child.send('go');
						background(async () => {
							try {
								await probe.child.exited;
								const error = probe.child.events.find(event => event.type === 'error');
								const result = probe.child.events.find(event => event.type === 'result');
								record.endAt = (result ?? error)?.t ?? probe.child.exitedAt;
								record.outcome = result != null ? 'committed' : 'failed';
								record.error = error != null ? String(error.message) : null;
								record.code = error?.code != null ? String(error.code) : null;
							} finally {
								probing = false;
							}
						});
						break;
					}
					for (const name of k1Pending.keys()) {
						if (this.status?.finished.has(name) === true) k1Pending.delete(name);
					}
					const pending = phase == null ? [] : (plan.scarce[phase] ?? []).filter(remaining);
					const scarce = pending.slice(0, 1);
					const candidates: { trigger: string; backend: Backend }[] = [];
					const blocker = plan.blocker;
					if (blocker != null && blockerReleasedAt == null && !k4) {
						const backend = own.find(row => row.waitType === 'Lock' && (row.blockers ?? []).includes(blocker.pid));
						if (backend != null) candidates.push({ trigger: 'K4', backend });
					}
					for (const table of plan.k3) {
						const backend = own.find(row => row.exclusive.includes(table) && (row.exclusive.includes(`${table}_p`) || row.exclusive.includes(`${table}_old`) || /^\s*LOCK TABLE/.test(row.query)));
						if (backend != null && remaining(`K3 ${table}`) && !pending.slice(1).includes(`K3 ${table}`)) candidates.push({ trigger: `K3 ${table}`, backend });
					}
					for (const [name, pattern, inTransaction] of k2Patterns) {
						const backend = own.find(row => (row.state === 'active' || (inTransaction && row.state === 'idle in transaction')) && pattern.test(row.query));
						if (backend != null && remaining(name) && !pending.slice(1).includes(name)) candidates.push({ trigger: name, backend });
					}
					candidates.sort((a, b) => Number(b.trigger === 'K4') - Number(a.trigger === 'K4') || Number(scarce.includes(b.trigger)) - Number(scarce.includes(a.trigger)));
					let killed = false;
					for (const candidate of candidates) {
						const phaseKill = phase != null && k1Pending.has(phase);
						if (!await kill(slot, candidate.trigger, candidate.backend, phaseKill)) break;
						if (candidate.trigger === 'K4') k4 = true;
						else if (candidate.trigger.startsWith('K3 ')) k3Done.add(candidate.trigger.slice(3));
						else k2Done[candidate.trigger]++;
						if (phaseKill && phase != null) {
							k1Fired.add(phase);
							k1Pending.delete(phase);
						}
						killed = true;
						break;
					}
					if (!killed && scarce.length === 0 && phase != null && (k1Pending.get(phase) ?? Infinity) <= Date.now() && await kill(slot, 'K1', active, true)) {
						k1Fired.add(phase);
						k1Pending.delete(phase);
						killed = true;
					}
					if (!killed && scarce.length === 0 && Date.now() >= nextRandomKill) {
						await kill(slot, 'K5', active, false);
						nextRandomKill = Date.now() - plan.randomKillMeanMs! * Math.log(1 - this.random());
					}
				}
				await setTimeout(20);
			}
		};

		const stateLoop = async () => {
			let lastSample = Date.now();
			while (!done) {
				const status = await migrationStatus(this.stateClient);
				this.status = status;
				for (const name of status.finished) {
					if (phases[name] != null) phases[name].finishedSeenAt ??= status.t;
				}
				if (fleet.unexpected.length > 0) throw new Error(`unexpected exits in ${plan.stage}: ${fleet.unexpected.join('; ')}`);
				if (failures.length > 0) throw new Error(failures.join('; '));
				if (Date.now() - startedAt > plan.deadlineMs) throw new Error(`${plan.stage} did not reach its target within ${plan.deadlineMs} ms`);
				for (const [i, hook] of (plan.hooks ?? []).entries()) {
					if (hooksDone.has(i) || !status.finished.has(hook.after) || (hook.when != null && !await hook.when(status))) continue;
					hooksDone.add(i);
					busy = true;
					try {
						while (probing) await setTimeout(100);
						await hook.run();
					} finally {
						busy = false;
					}
				}
				if (plan.blocker != null && blockerReleasedAt == null && plan.blocker.release(status)) await releaseBlocker();
				if (targetAt == null && plan.target(status)) {
					targetAt = Date.now();
					killsEnabled = false;
					runEnds0 = fleet.runEnds.length;
				}
				if (targetAt != null) {
					for (const end of fleet.runEnds.slice(runEnds0)) {
						if (end.holder) quiet = end.logs.length === 0 ? quiet + 1 : 0;
					}
					runEnds0 = fleet.runEnds.length;
					if (quiet >= 2) return;
				} else if (!busy && !probing) {
					await this.fastForwardIfStalled(plan, status, () => { busy = true; }, () => { busy = false; });
				}
				if (plan.sample != null && Date.now() - lastSample >= plan.sampleEveryMs) {
					lastSample = Date.now();
					await plan.sample(status);
					samples++;
				}
				await setTimeout(100);
			}
		};

		try {
			await Promise.race([activityLoop(), stateLoop()]);
		} catch (e) {
			failures.push(String(e));
		} finally {
			done = true;
			fleet.lineListeners.delete(onLine);
		}
		await Promise.allSettled(tasks);
		await fleet.settle();
		await releaseBlocker();
		await setTimeout(100);
		if (failures.length > 0) throw new Error(failures.join('; '));

		const kills = fleet.kills.slice(kills0);
		const k1Unfinished = [...new Set(kills.filter(record => record.phaseKill && record.phaseFinishedAtKill === false).map(record => record.phase!))];
		const notExercised = [
			...Object.entries(plan.k2).filter(([name, quota]) => k2Done[name] < quota).map(([name, quota]) => `${name} (${k2Done[name]}/${quota})`),
			...plan.k3.filter(table => !k3Done.has(table)).map(table => `K3 ${table}`),
			...(plan.blocker != null && !k4 ? ['K4'] : []),
			...plan.writerKills.filter(anchor => !anchorsDone.has(`W ${anchor.phase} ${anchor.writer}`)).map(anchor => `W ${anchor.writer} after ${anchor.phase ?? 'the start'}`),
			...plan.redisLosses.filter(anchor => !anchorsDone.has(`R ${anchor.phase}`)).map(anchor => `R after ${anchor.phase ?? 'the start'}`),
			...deployProbes.filter(probe => probe.goAt == null).map(probe => `deploy probe ${probe.name}`),
		];
		const report: StageReport = {
			stage: plan.stage,
			startedAt,
			targetAt: targetAt!,
			endedAt: Date.now(),
			kills,
			k1Unfinished,
			k2: Object.fromEntries(Object.entries(plan.k2).map(([name, quota]) => [name, { quota, done: k2Done[name] }])),
			k3: [...k3Done],
			notExercised,
			writerKills: fleet.writerKills.slice(writerKills0),
			redisLosses: this.ctx.redis.losses.slice(losses0),
			fastForwards: fleet.fastForwards.slice(fastForwards0),
			phases,
			lockWaits,
			samples,
			maxBackends,
			k4,
			blockerReleasedAt,
			deployProbes,
		};
		if (k1Unfinished.length < plan.k1MinUnfinished) throw Object.assign(new Error(`${plan.stage} killed only ${k1Unfinished.length} phases before they finished (${k1Unfinished.join(', ')}), ${plan.k1MinUnfinished} required`), { report });
		return report;
	}

	private waitingSince(row: string, at: number): number {
		const seen = this.seenWaits.get(row);
		if (seen?.at === at) return seen.seenAt;
		const seenAt = Date.now();
		this.seenWaits.set(row, { at, seenAt });
		return seenAt;
	}

	private async fastForwardIfStalled(plan: StagePlan, status: MigrationStatus, begin: () => void, end: () => void): Promise<void> {
		const fleet = this.fleet;
		const realNow = Date.now();
		const waiting = [...status.states].flatMap(([row, state]) => typeof state.nextAttemptAt === 'number' && state.nextAttemptAt > realNow + fleet.clockOffsetMs ? [{ row, state, at: state.nextAttemptAt }] : []);
		if (waiting.length === 0) return;
		const next = waiting.reduce((a, b) => (a.at <= b.at ? a : b));
		const since = Math.max(fleet.fastForwards.at(-1)?.t ?? 0, this.waitingSince(next.row, next.at));
		const holderEnds = fleet.runEnds.filter(run => run.holder && run.t > since);
		if (holderEnds.length < 2 || !holderEnds.slice(-2).every(run => run.logs.every(row => stallLogs.some(pattern => pattern.test(row))))) return;
		const toMs = Math.max(fleet.clockOffsetMs, next.at - realNow + 1000);
		begin();
		try {
			fleet.fastForwards.push({ t: Date.now(), stage: plan.stage, row: next.row, attempts: next.state.attempts ?? null, lastError: next.state.lastError ?? null, fromMs: fleet.clockOffsetMs, toMs });
			await fleet.restartRunners(toMs);
		} finally {
			end();
		}
	}
}

export type LockPeak = { t: number; app: string; role: string; pid: number; xactStart: string | null; relationLocks: number; query: string; classes: string[] };

const lockSampleActivitySql = `
	SELECT pid, application_name AS "app", xact_start::text AS "xactStart", query_start::text AS "queryStart", left(query, 300) AS "query"
	FROM pg_stat_activity
	WHERE datname = current_database() AND application_name LIKE 'mk-e2e-%' AND pid <> pg_backend_pid() AND xact_start IS NOT NULL
`;

const lockSampleLocksSql = 'SELECT pid, count(*)::int AS "relationLocks" FROM pg_locks WHERE locktype = \'relation\' GROUP BY pid';

export class LockSampler {
	public samples = 0;
	public readonly maxima: Partial<Record<string, LockPeak>> = {};
	private readonly peaks = new Map<string, LockPeak>();
	private running = false;
	private loop: Promise<void> | null = null;

	constructor(private client: pg.Client, private classify: (role: string, query: string) => string) {}

	public start(): void {
		this.running = true;
		this.loop = (async () => {
			while (this.running) {
				type Activity = { pid: number; app: string; xactStart: string; queryStart: string; query: string };
				const before = (await this.client.query<Activity>(lockSampleActivitySql)).rows;
				const locks = new Map((await this.client.query<{ pid: number; relationLocks: number }>(lockSampleLocksSql)).rows.map(row => [row.pid, row.relationLocks]));
				const after = new Map((await this.client.query<Activity>(lockSampleActivitySql)).rows.map(row => [row.pid, row]));
				this.samples++;
				for (const activity of before) {
					const same = after.get(activity.pid);
					const role = activity.app.replace(/^mk-e2e-/, '').replace(/-\d+$/, '');
					if (same == null || same.xactStart !== activity.xactStart || (same.queryStart !== activity.queryStart && role.startsWith('runner'))) continue;
					const row = { ...same, relationLocks: locks.get(activity.pid) ?? 0 };
					const query = row.query.trim();
					const key = `${row.pid} ${row.xactStart}`;
					const known = this.peaks.get(key);
					const kinds = [...new Set([activity.query, same.query].map(text => this.classify(role, text.trim())))];
					if (known == null && row.relationLocks < 10) {
						if ((this.maxima[role]?.relationLocks ?? -1) < row.relationLocks) this.maxima[role] = { t: Date.now(), app: row.app, role, pid: row.pid, xactStart: row.xactStart, relationLocks: row.relationLocks, query, classes: kinds };
						continue;
					}
					const peak = known ?? { t: Date.now(), app: row.app, role, pid: row.pid, xactStart: row.xactStart, relationLocks: -1, query, classes: [] };
					for (const kind of kinds) {
						if (!peak.classes.includes(kind)) peak.classes.push(kind);
					}
					if (row.relationLocks > peak.relationLocks) Object.assign(peak, { t: Date.now(), relationLocks: row.relationLocks, query });
					this.peaks.set(key, peak);
					if ((this.maxima[role]?.relationLocks ?? -1) < peak.relationLocks) this.maxima[role] = peak;
				}
				await setTimeout(50);
			}
		})();
	}

	public async stop(): Promise<LockPeak[]> {
		this.running = false;
		await this.loop;
		return [...this.peaks.values()];
	}
}
