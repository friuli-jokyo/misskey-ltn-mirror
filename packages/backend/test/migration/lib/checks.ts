/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { PARTITION_COUNT, nextPrefix, ordinalToPrefix, prefixOf, prefixToOrdinal } from '@/misc/partition.js';
import { chunk } from '@/misc/prelude/array.js';
import { lockHolders, readPlans } from './autoexplain.js';
import { budgeted, lockedRelations } from './budget.js';
import { copyState, foreignKeys } from './catalog.js';
import { backendDir, repoDir } from './env.js';
import { allowedJobLogs, appRoles, businessErrors, connectionClasses, connectionTimeouts, copyIndexes, copyReference, deletedNoteNotification, dependentColumns, fixtureProbeErrors, genericPlanIterations, harnessDelivery, jobLostWithRedis, killSuspectMs, locatorTriggers, lockLimits, lockTimeoutJobLog, migrationClass, noSuchNote, ours, parentOrderFunctionBody, parentOrderTriggers, partitionKeys, phases, postCommitJobLog, reactionIdTaken, rekeyHorizonMs, rekeyRoundCap, runnerStatementClasses, statementFailureWindowMs, threadStatementShape, transientStates } from './expected.js';
import { childrenByFamily, coverageShape, normalizedText, statementShape } from './explain.js';
import { aid, localNoteUri, prefixStart, unreferenceableNoteId } from './seed.js';
import { harnessUrl } from './source-config.js';
import type { PgLogEntry } from './autoexplain.js';
import type { Snapshot } from './catalog.js';
import type { Child } from './children.js';
import type { Run } from './env.js';
import type { StageExpectation } from './expected.js';
import type { CaptureFile, RecordedThreadEvent, Replay } from './explain.js';
import type { DeployProbe, Fleet, JobLog, KillRecord, LockPeak } from './monitor.js';
import type { RedisLoss } from './redis.js';
import type { Seed, SeedModel } from './seed.js';
import type pg from 'pg';

export function baseFileProblems(files: string[]): string[] {
	const paths = files.map(file => relative(repoDir, file));
	try {
		execFileSync('git', ['-C', repoDir, 'ls-files', '--error-unmatch', '--', ...paths], { stdio: 'ignore' });
	} catch (e) {
		if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
			console.warn('git is unavailable; the BASE migrations are not checked against HEAD');
			return [];
		}
		return ['a BASE migration is not tracked by git'];
	}
	const tracked = execFileSync('git', ['-C', repoDir, 'ls-files', '--', relative(repoDir, join(backendDir, 'migration'))], { encoding: 'utf-8' }).split('\n').filter(line => line !== '');
	const modified = execFileSync('git', ['-C', repoDir, 'diff', '--name-only', 'HEAD', '--', ...paths], { encoding: 'utf-8' }).split('\n').filter(line => line !== '');
	const isOurs = (path: string) => ours.includes(migrationClass.exec(readFileSync(join(repoDir, path), 'utf-8'))?.[1] ?? '');
	return [
		...tracked.filter(path => !paths.includes(path) && !isOurs(path)).map(path => `${path} is tracked but neither a BASE migration nor ours`),
		...modified.map(path => `${path} differs from HEAD`),
	];
}

export async function prefixCounts(client: pg.Client, table: string, column: string): Promise<Record<string, number>> {
	const counts: Record<string, number> = {};
	for (let ord = 0; ord < PARTITION_COUNT; ord++) {
		const prefix = ordinalToPrefix(ord);
		const upper = nextPrefix(prefix);
		const [{ count }] = upper == null
			? await budgeted<{ count: number }>(client, 'data', `SELECT count(*)::int AS "count" FROM "${table}" WHERE "${column}" >= $1`, [prefix])
			: await budgeted<{ count: number }>(client, 'data', `SELECT count(*)::int AS "count" FROM "${table}" WHERE "${column}" >= $1 AND "${column}" < $2`, [prefix, upper]);
		if (count > 0) counts[prefix] = count;
	}
	return counts;
}

export function c7ForeignKeys(current: Snapshot, baseline: Snapshot, removed: string[], added: string[]): { actual: string[]; expected: string[] } {
	return {
		actual: foreignKeys(current),
		expected: [...foreignKeys(baseline).filter(fk => !removed.includes(fk.slice(0, fk.indexOf(' ')))), ...added].sort(),
	};
}

export function c15CheckMigrations(result: Record<string, unknown>): { up: string[]; down: string[] } {
	return { up: [...result.up as string[]].sort(), down: [...result.down as string[]].sort() };
}

type CopyTable = 'note' | 'note_reaction';

export const copyTableNames: CopyTable[] = ['note', 'note_reaction'];

type Copies = {
	table: CopyTable;
	live: 'partitioned' | 'plain';
	standby: string | null;
	synced: boolean;
	partitioned: string | null;
	plain: string | null;
};

export type OplogEntry = {
	file: string;
	seq: number;
	sub?: number;
	t: number;
	stage: string;
	op: string;
	args: Record<string, unknown>;
	result: unknown;
	error?: { class: string; name: string | null; message: string; code: string | null; identifiableId: string | null; sqlState: string | null };
	reconciled?: unknown;
	latencyMs: number;
};

export type StageContext = {
	client: pg.Client;
	run: Run;
	stage: string;
	baseline: Snapshot;
	model: SeedModel;
	from: number;
	to: number;
	fleet: Fleet;
	redisLosses: RedisLoss[];
	pgLog: PgLogEntry[];
	appOf: (pid: number) => string | null;
	pidsOf: (app: string) => number[];
	partitionedWasLive: boolean;
	expectation: StageExpectation;
	fixtureWindows: FixtureWindow[];
	deployProbes: DeployProbe[];
};

export type FixtureWindow = { name: string; from: number; to: number };

export type CheckResult = { check: string; problems: string[]; summary: Record<string, unknown> };

const between = (column: string, alias: string) => `${alias}"${column}" >= $1 AND ($2::text IS NULL OR ${alias}"${column}" < $2)`;

function* allPrefixes(): Generator<[string, string | null]> {
	for (let ord = 0; ord < PARTITION_COUNT; ord++) {
		const prefix = ordinalToPrefix(ord);
		yield [prefix, nextPrefix(prefix)];
	}
}

const childOf = (table: CopyTable, prefix: string) => `${table}_p_${prefix}`;

const redisErrors = /Connection is closed|ECONNREFUSED|ECONNRESET|EPIPE|Reached the max retries per request limit|Stream isn't writeable|Socket closed unexpectedly|connect ETIMEDOUT/;

const inRedisWindow = (losses: RedisLoss[], from: number, to = from) => losses.some(loss => to >= loss.killedAt && from <= loss.readyAt + 60 * 1000);

export function childErrors(child: Child, losses: RedisLoss[]): string[] {
	return [
		...child.problems.filter(line => line.level === 'ERR ' && !(redisErrors.test(line.line) && inRedisWindow(losses, line.t))).map(line => `${child.name} logged an error: ${line.line}`),
		...child.events.filter(event => event.type === 'process-error' && !(redisErrors.test(String(event.message)) && inRedisWindow(losses, event.t))).map(event => `${child.name} had an ${String(event.kind)}: ${String(event.message)}`),
	];
}

export async function childIndexCount(client: pg.Client, table: string): Promise<number> {
	const [{ count }] = await budgeted<{ count: number }>(client, 'catalog', `
		SELECT count(*)::int AS "count"
		FROM pg_index p
		JOIN pg_inherits h ON h.inhparent = p.indexrelid
		JOIN pg_index c ON c.indexrelid = h.inhrelid
		WHERE p.indrelid = $1::regclass AND NOT p.indisprimary AND c.indisvalid
	`, [table]);
	return count;
}

export async function inspectCopies(client: pg.Client, table: CopyTable): Promise<Copies> {
	const [row] = await budgeted<{ kind: string; old: string | null; p: string | null; synced: boolean }>(client, 'catalog', `
		SELECT c.relkind AS "kind", to_regclass($2)::text AS "old", to_regclass($3)::text AS "p",
			EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = $4) AS "synced"
		FROM pg_class c
		WHERE c.oid = $1::regclass
	`, [table, `${table}_old`, `${table}_p`, `${table}_sync`]);
	const live = row.kind === 'p' ? 'partitioned' : 'plain';
	const standby = live === 'partitioned' ? row.old : row.p;
	return { table, live, standby, synced: row.synced, partitioned: live === 'partitioned' ? table : standby, plain: live === 'plain' ? table : standby };
}

export function readOplogs(run: Run): OplogEntry[] {
	const dir = run.path('oplog');
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(file => file.startsWith('writer-') && file.endsWith('.jsonl')).flatMap(file => readFileSync(join(dir, file), 'utf-8').split('\n').filter(line => line !== '').map(line => ({ file, ...JSON.parse(line) as Omit<OplogEntry, 'file'> })));
}

export function expectedCopies(live: Record<CopyTable, 'partitioned' | 'plain'>, standby: boolean): Awaited<ReturnType<typeof copyState>> {
	const relkinds: Record<string, string | null> = {};
	const triggers: string[] = [];
	const functions: string[] = [];
	const children: Record<string, number> = {};
	for (const table of copyTableNames) {
		const partitioned = live[table] === 'partitioned';
		relkinds[table] = partitioned ? 'p' : 'r';
		relkinds[`${table}_old`] = partitioned && standby ? 'r' : null;
		relkinds[`${table}_p`] = !partitioned && standby ? 'p' : null;
		const standbyName = partitioned ? `${table}_old` : `${table}_p`;
		const partitionedName = partitioned ? table : standbyName;
		if (standby) {
			triggers.push(`${table}.${table}_sync`);
			functions.push(partitioned ? `${table}_sync_to_old` : `${table}_sync_to_p`);
		}
		if (partitioned || standby) children[partitionedName] = PARTITION_COUNT;
		if (table === 'note') {
			for (const name of [table, ...(standby ? [standbyName] : [])]) triggers.push(...parentOrderTriggers.map(trigger => `${name}.${trigger}`));
		} else if (partitioned || standby) {
			triggers.push(...locatorTriggers.map(trigger => `${partitionedName}.${trigger}`));
		}
	}
	return { relkinds, triggers: triggers.sort(), functions: functions.sort(), children };
}

export async function c1CopyState(client: pg.Client, expected: Awaited<ReturnType<typeof copyState>>): Promise<CheckResult> {
	const actual = await copyState(client);
	const problems: string[] = [];
	for (const [name, kind] of Object.entries(expected.relkinds)) {
		if (actual.relkinds[name] !== kind) problems.push(`${name} has relkind ${actual.relkinds[name]}, expected ${kind}`);
	}
	if (JSON.stringify(actual.functions) !== JSON.stringify(expected.functions)) problems.push(`sync functions ${actual.functions.join(', ')}, expected ${expected.functions.join(', ')}`);
	const syncTriggers = (list: string[]) => list.filter(name => /_sync$/.test(name)).sort();
	if (JSON.stringify(syncTriggers(actual.triggers)) !== JSON.stringify(syncTriggers(expected.triggers))) problems.push(`sync triggers ${syncTriggers(actual.triggers).join(', ')}, expected ${syncTriggers(expected.triggers).join(', ')}`);
	if (JSON.stringify(actual.children) !== JSON.stringify(expected.children)) problems.push(`partitions ${JSON.stringify(actual.children)}, expected ${JSON.stringify(expected.children)}`);
	return { check: 'C1', problems, summary: actual };
}

export async function c2Phases(client: pg.Client): Promise<CheckResult> {
	const rows = await budgeted<{ name: string; state: Record<string, unknown>; finished: boolean }>(client, 'catalog', 'SELECT "name", "state", "finishedAt" IS NOT NULL AS "finished" FROM "partition_migration_state" ORDER BY "name"');
	const problems: string[] = [];
	for (const phase of phases) {
		if (!rows.some(row => row.name === phase && row.finished)) problems.push(`phase ${phase} is not finished`);
	}
	for (const name of transientStates) {
		const row = rows.find(other => other.name === name);
		if (row != null && Object.keys(row.state).length > 0) problems.push(`${name} has state ${JSON.stringify(row.state)}`);
	}
	const [{ pending }] = await budgeted<{ pending: string | null }>(client, 'catalog', 'SELECT to_regclass(\'note_reaction_swap_pending_fk\')::text AS "pending"');
	if (pending != null) problems.push('note_reaction_swap_pending_fk exists');
	const statistics: Record<string, number> = {};
	for (const table of copyTableNames) {
		const [{ kind }] = await budgeted<{ kind: string }>(client, 'catalog', 'SELECT relkind AS "kind" FROM pg_class WHERE oid = $1::regclass', [table]);
		if (kind !== 'p') continue;
		const [{ count }] = await budgeted<{ count: number }>(client, 'catalog', 'SELECT count(*)::int AS "count" FROM pg_stats WHERE schemaname = \'public\' AND tablename = $1 AND inherited', [table]);
		statistics[table] = count;
		if (count === 0) problems.push(`${table} has no inherited statistics`);
	}
	return { check: 'C2', problems, summary: { states: Object.fromEntries(rows.map(row => [row.name, row.finished ? 'finished' : row.state])), statistics } };
}

async function commonColumns(client: pg.Client, a: string, b: string): Promise<string[]> {
	return (await budgeted<{ name: string }>(client, 'catalog', `
		SELECT a.attname AS "name"
		FROM pg_attribute a
		JOIN pg_attribute b ON b.attrelid = $2::regclass AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped
		WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
		ORDER BY a.attname COLLATE "C"
	`, [`"${a}"`, `"${b}"`])).map(row => row.name);
}

export async function rowEquality(client: pg.Client, copies: Copies, prefixes?: string[], diagnose = true): Promise<{ problems: string[]; prefixes: number; rows: number }> {
	if (copies.partitioned == null || copies.plain == null || copies.standby == null) return { problems: [], prefixes: 0, rows: 0 };
	const columns = (await commonColumns(client, copies.partitioned, copies.plain)).map(column => `t."${column}"`).join(', ');
	const hash = `coalesce(sum(('x' || substr(md5(ROW(${columns})::text), 1, 16))::bit(64)::bigint::numeric), 0)`;
	const key = partitionKeys[copies.table];
	const problems: string[] = [];
	let compared = 0;
	let rows = 0;
	for (const [prefix, upper] of allPrefixes()) {
		if (prefixes != null && !prefixes.includes(prefix)) continue;
		const child = childOf(copies.table, prefix);
		const sides = {
			child: { rows: `(SELECT count(*) FROM "${child}" t WHERE ${between(key, 't.')}) AS "childRows"`, hash: `(SELECT ${hash} FROM "${child}" t WHERE ${between(key, 't.')}) AS "childHash"` },
			plain: { rows: `(SELECT count(*) FROM "${copies.plain}" t WHERE ${between(key, 't.')}) AS "plainRows"`, hash: `(SELECT ${hash} FROM "${copies.plain}" t WHERE ${between(key, 't.')}) AS "plainHash"` },
		};
		const order = copies.live === 'partitioned' ? [sides.child, sides.plain] : [sides.plain, sides.child];
		const [row] = await budgeted<{ childRows: string; childHash: string; plainRows: string; plainHash: string }>(client, 'data', `SELECT ${order.flatMap(side => [side.rows, side.hash]).join(', ')}`, [prefix, upper]);
		compared++;
		rows += Number(row.childRows);
		if (row.childRows === row.plainRows && row.childHash === row.plainHash) continue;
		if (!diagnose) {
			problems.push(`${child} (${row.childRows} rows, hash ${row.childHash}) differs from ${copies.plain} (${row.plainRows} rows, hash ${row.plainHash})`);
			continue;
		}
		const only = async (a: string, b: string) => await budgeted<{ id: string }>(client, 'data', `SELECT x."id" FROM (SELECT ${columns} FROM "${a}" t WHERE ${between(key, 't.')} EXCEPT SELECT ${columns} FROM "${b}" t WHERE ${between(key, 't.')}) x LIMIT 20`, [prefix, upper]);
		const onlyChild = await only(child, copies.plain);
		const onlyPlain = await only(copies.plain, child);
		problems.push(`${child} (${row.childRows} rows) differs from ${copies.plain} (${row.plainRows} rows): only in ${child} ${onlyChild.map(other => other.id).join(', ')}; only in ${copies.plain} ${onlyPlain.map(other => other.id).join(', ')}`);
	}
	return { problems, prefixes: compared, rows };
}

export async function c3RowEquality(client: pg.Client): Promise<CheckResult> {
	const problems: string[] = [];
	const summary: Record<string, unknown> = {};
	for (const table of copyTableNames) {
		const copies = await inspectCopies(client, table);
		if (!copies.synced) {
			summary[table] = 'not synced';
			continue;
		}
		const result = await rowEquality(client, copies);
		problems.push(...result.problems);
		summary[table] = { prefixes: result.prefixes, rows: result.rows };
	}
	return { check: 'C3', problems, summary };
}

const columnsSql = `
	SELECT a.attname AS "name", format_type(a.atttypid, a.atttypmod) AS "type", a.atttypmod AS "typmod", CASE WHEN a.attcollation <> 0 THEN a.attcollation::regcollation::text END AS "collation",
		pg_get_expr(d.adbin, d.adrelid) AS "default", a.attgenerated::text AS "generated", a.attidentity::text AS "identity", a.attnotnull AS "notNull"
	FROM pg_attribute a
	LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
	WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
	ORDER BY a.attname COLLATE "C"
`;

type Column = { name: string; type: string; typmod: number; collation: string | null; default: string | null; generated: string; identity: string; notNull: boolean };

export async function c4Schema(client: pg.Client, baseline: Snapshot, expectation: StageExpectation): Promise<CheckResult> {
	const problems: string[] = [];
	for (const table of copyTableNames) {
		const added = expectation.columns[table] ?? [];
		const nullable = expectation.nullable[table] ?? [];
		const describe = (column: Omit<Column, 'typmod'>) => JSON.stringify(added.some(other => other.name === column.name)
			? { name: column.name, type: column.type, notNull: column.notNull }
			: { name: column.name, type: column.type, notNull: column.notNull, default: column.default, generated: column.generated, identity: column.identity, collation: column.collation });
		const copies = await inspectCopies(client, table);
		const live = await budgeted<Column>(client, 'catalog', columnsSql, [table]);
		const shape = (column: Column) => JSON.stringify({ name: column.name, type: column.type, collation: column.collation, default: column.default, generated: column.generated, identity: column.identity });
		if (copies.standby != null) {
			const standby = await budgeted<Column>(client, 'catalog', columnsSql, [copies.standby]);
			if (JSON.stringify(live.map(shape)) !== JSON.stringify(standby.map(shape))) problems.push(`the columns of ${table} and ${copies.standby} differ: ${live.map(shape).filter(item => !standby.map(shape).includes(item)).join(', ')} / ${standby.map(shape).filter(item => !live.map(shape).includes(item)).join(', ')}`);
			for (const column of standby.filter(other => other.notNull)) {
				if (!live.some(other => other.name === column.name && other.notNull)) problems.push(`${copies.standby}.${column.name} is NOT NULL but ${table}.${column.name} is not`);
			}
		}
		const expected = [
			...baseline.columns.filter(column => column.table === table).map(column => describe({ ...column, notNull: column.notNull && !nullable.includes(column.name) })),
			...added.map(column => JSON.stringify({ name: column.name, type: column.type, notNull: false })),
		].sort();
		const actual = live.map(describe).sort();
		if (JSON.stringify(actual) !== JSON.stringify(expected)) problems.push(`the columns of ${table} differ from the baseline and the fixtures: ${actual.filter(item => !expected.includes(item)).join(', ')} / ${expected.filter(item => !actual.includes(item)).join(', ')}`);
	}
	return { check: 'C4', problems, summary: {} };
}

const indexListSql = `
	SELECT c.relname AS "name", substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') AS "body", i.indisunique AS "unique", i.indisprimary AS "primary", i.indisvalid AS "valid",
		(SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS "columns"
	FROM pg_index i
	JOIN pg_class c ON c.oid = i.indexrelid
	WHERE i.indrelid = $1::regclass
	ORDER BY c.relname COLLATE "C"
`;

type IndexRow = { name: string; body: string; unique: boolean; primary: boolean; valid: boolean; columns: string[] | null };

function expectedIndexNames(table: CopyTable, kind: 'plain' | 'partitioned', role: 'live' | 'standby', partitionedWasLive: boolean, expectation: StageExpectation): string[] {
	const delta = expectation.indexes[table]?.[role] ?? {};
	return [...copyIndexes[table][kind].filter(index => !(delta.without ?? []).includes(index.name)), ...(delta.with ?? [])].map(index => {
		const name = role === 'live' ? index.name : `${index.name}${kind === 'plain' ? '_old' : '_mig'}`;
		return `${index.primary && role === 'standby' && kind === 'partitioned' && !partitionedWasLive ? `${table}_p_pkey` : name} ${index.body}${index.unique ? ' UNIQUE' : ''}${index.primary ? ' PRIMARY' : ''}`;
	}).sort();
}

export async function c5Indexes(client: pg.Client, partitionedWasLive: boolean, expectation: StageExpectation): Promise<CheckResult> {
	const problems: string[] = [];
	const summary: Record<string, unknown> = {};
	const invalid = await budgeted<{ table: string; name: string }>(client, 'catalog', `
		SELECT t.relname AS "table", c.relname AS "name"
		FROM pg_index i
		JOIN pg_class c ON c.oid = i.indexrelid
		JOIN pg_class t ON t.oid = i.indrelid
		WHERE t.relnamespace = 'public'::regnamespace AND NOT i.indisvalid AND t.relname ~ '^note(_reaction)?(_old|_p|_p_[0-9a-z]{2})?$'
	`);
	problems.push(...invalid.map(row => `${row.name} on ${row.table} is invalid`));
	for (const table of copyTableNames) {
		const copies = await inspectCopies(client, table);
		const kind = copies.live;
		const describe = (rows: IndexRow[]) => rows.map(row => `${row.name} ${row.body}${row.unique ? ' UNIQUE' : ''}${row.primary ? ' PRIMARY' : ''}`).sort();
		const live = await budgeted<IndexRow>(client, 'catalog', indexListSql, [table]);
		const expectedLive = expectedIndexNames(table, kind, 'live', partitionedWasLive, expectation);
		if (JSON.stringify(describe(live)) !== JSON.stringify(expectedLive)) problems.push(`the indexes of ${table} are ${describe(live).join(', ')}; expected ${expectedLive.join(', ')}`);
		summary[table] = describe(live);
		if (copies.standby != null) {
			const standby = await budgeted<IndexRow>(client, 'catalog', indexListSql, [copies.standby]);
			const standbyKind = kind === 'partitioned' ? 'plain' : 'partitioned';
			const expectedStandby = expectedIndexNames(table, standbyKind, 'standby', partitionedWasLive, expectation);
			if (JSON.stringify(describe(standby)) !== JSON.stringify(expectedStandby)) problems.push(`the indexes of ${copies.standby} are ${describe(standby).join(', ')}; expected ${expectedStandby.join(', ')}`);
			summary[copies.standby] = describe(standby);
			for (const index of standby.filter(row => row.unique && !row.primary)) {
				const compatible = live.some(other => other.body === index.body && (other.unique || (kind === 'partitioned' && !(index.columns ?? []).includes(partitionKeys[table]))));
				if (!compatible) problems.push(`${copies.standby} has the unique ${index.name}, which no index of ${table} provides`);
			}
		}
		if (copies.partitioned != null) {
			const children = await budgeted<{ name: string; attached: number; valid: number }>(client, 'catalog', `
				SELECT p.relname AS "name", count(inh.inhrelid)::int AS "attached", (count(ci.indexrelid) FILTER (WHERE ci.indisvalid))::int AS "valid"
				FROM pg_index pi
				JOIN pg_class p ON p.oid = pi.indexrelid
				LEFT JOIN pg_inherits inh ON inh.inhparent = pi.indexrelid
				LEFT JOIN pg_index ci ON ci.indexrelid = inh.inhrelid
				WHERE pi.indrelid = $1::regclass
				GROUP BY p.relname
			`, [copies.partitioned]);
			for (const row of children) {
				if (row.attached !== PARTITION_COUNT || row.valid !== PARTITION_COUNT) problems.push(`${row.name} of ${copies.partitioned} has ${row.attached} attached and ${row.valid} valid partitions`);
			}
			const unattached = await budgeted<{ name: string; partition: string }>(client, 'catalog', `
				SELECT c.relname AS "name", p.inhrelid::regclass::text AS "partition"
				FROM pg_inherits p
				JOIN pg_index i ON i.indrelid = p.inhrelid
				JOIN pg_class c ON c.oid = i.indexrelid
				WHERE p.inhparent = $1::regclass AND NOT EXISTS (SELECT 1 FROM pg_inherits a WHERE a.inhrelid = i.indexrelid)
			`, [copies.partitioned]);
			problems.push(...unattached.map(row => `${row.name} on ${row.partition} is not attached`));
		}
	}
	return { check: 'C5', problems, summary };
}

export async function c6Constraints(client: pg.Client, baseline: Snapshot, expectation: StageExpectation): Promise<CheckResult> {
	const problems: string[] = [];
	for (const table of copyTableNames) {
		const copies = await inspectCopies(client, table);
		const constraintsOf = async (name: string) => await budgeted<{ name: string; definition: string; validated: boolean; type: string }>(client, 'catalog', 'SELECT conname AS "name", regexp_replace(pg_get_constraintdef(oid), \' NOT VALID$\', \'\') AS "definition", convalidated AS "validated", contype::text AS "type" FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN (\'c\', \'u\') ORDER BY conname', [name]);
		const live = await constraintsOf(table);
		const expectedChecks = [
			...baseline.constraints.filter(constraint => constraint.table === table && constraint.type === 'c').map(constraint => `${constraint.name} ${constraint.definition.replace(/ NOT VALID$/, '')}${constraint.validated ? '' : ' NOT VALID'}`),
			...(expectation.checks[table] ?? []),
		].sort();
		const liveChecks = live.filter(constraint => constraint.type === 'c').map(constraint => `${constraint.name} ${constraint.definition}${constraint.validated ? '' : ' NOT VALID'}`).sort();
		if (JSON.stringify(liveChecks) !== JSON.stringify(expectedChecks)) problems.push(`the CHECK constraints of ${table} are ${liveChecks.join(', ')}; expected ${expectedChecks.join(', ')}`);
		if (copies.standby == null) continue;
		const standby = await constraintsOf(copies.standby);
		for (const constraint of standby.filter(other => other.type === 'c')) {
			if (!live.some(other => other.type === 'c' && other.definition === constraint.definition)) problems.push(`${copies.standby} has the CHECK ${constraint.name} ${constraint.definition}, which ${table} does not have`);
		}
		const suffix = copies.live === 'partitioned' ? '_old' : '_mig';
		for (const constraint of live.filter(other => other.type === 'u' && !expectation.uniqueBeforeSwitch.includes(other.name))) {
			if (!standby.some(other => other.type === 'u' && other.name === `${constraint.name}${suffix}`)) problems.push(`${copies.standby} lacks the UNIQUE constraint ${constraint.name}${suffix}`);
		}
	}
	return { check: 'C6', problems, summary: {} };
}

export async function c7ForeignKeyDeltas(client: pg.Client, current: Snapshot, baseline: Snapshot, removed: string[], added: string[], detached: boolean): Promise<CheckResult> {
	const fks = c7ForeignKeys(current, baseline, removed, added);
	const problems = [
		...fks.actual.filter(fk => !fks.expected.includes(fk)).map(fk => `unexpected foreign key ${fk}`),
		...fks.expected.filter(fk => !fks.actual.includes(fk)).map(fk => `missing foreign key ${fk}`),
	];
	const touching = await budgeted<{ name: string }>(client, 'catalog', `
		SELECT conrelid::regclass::text || '.' || conname AS "name"
		FROM pg_constraint
		WHERE contype = 'f' AND (conrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ~ $1) OR confrelid IN (SELECT oid FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ~ $1))
	`, ['^note(_reaction)?(_old|_p|_p_[0-9a-z]{2})?$']);
	if (detached) problems.push(...touching.map(row => `${row.name} references or belongs to a copy`));
	return { check: 'C7', problems, summary: { count: fks.actual.length } };
}

export async function c8Triggers(client: pg.Client, expected: Awaited<ReturnType<typeof copyState>>): Promise<CheckResult> {
	const actual = await copyState(client);
	const problems: string[] = [];
	if (JSON.stringify(actual.triggers) !== JSON.stringify(expected.triggers)) problems.push(`the triggers on the copies are ${actual.triggers.join(', ')}; expected ${expected.triggers.join(', ')}`);
	const parentOrder = await budgeted<{ table: string; name: string; function: string; source: string }>(client, 'catalog', `
		SELECT c.relname AS "table", t.tgname AS "name", p.proname AS "function", p.prosrc AS "source"
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		JOIN pg_proc p ON p.oid = t.tgfoid
		WHERE c.relnamespace = 'public'::regnamespace AND t.tgname = ANY($1) AND NOT t.tgisinternal AND t.tgparentid = 0
	`, [parentOrderTriggers]);
	for (const row of parentOrder) {
		if (row.function !== 'note_parent_order' || row.source !== parentOrderFunctionBody) problems.push(`${row.table}.${row.name} runs ${row.function} with another body`);
	}
	return { check: 'C8', problems, summary: { triggers: actual.triggers } };
}

export async function c9Locator(client: pg.Client, oplogs: OplogEntry[]): Promise<CheckResult> {
	const copies = await inspectCopies(client, 'note_reaction');
	const [{ finished }] = await budgeted<{ finished: boolean }>(client, 'catalog', 'SELECT EXISTS (SELECT 1 FROM "partition_migration_state" WHERE "name" = \'reactionLocatorFill\' AND "finishedAt" IS NOT NULL) AS "finished"');
	const problems: string[] = [];
	const [{ total, same }] = await budgeted<{ total: number; same: number }>(client, 'data', 'SELECT count(*)::int AS "total", (count(*) FILTER (WHERE left("id", 2) = left("noteId", 2)))::int AS "same" FROM "note_reaction_locator"');
	if (copies.partitioned == null) {
		if (total > 0) problems.push(`note_reaction_locator has ${total} rows without a partitioned copy`);
		return { check: 'C9', problems, summary: { total } };
	}
	if (!finished) return { check: 'C9', problems, summary: { total, finished } };
	if (same > 0) problems.push(`note_reaction_locator has ${same} rows whose id and noteId share a prefix`);
	let crossPrefix = 0;
	const created = new Map<string, { id: string; noteId: string }[]>();
	for (const entry of oplogs) {
		if (entry.op !== 'reactionCreate' || typeof entry.result !== 'string' || typeof entry.args.noteId !== 'string') continue;
		if (prefixOf(entry.result) === prefixOf(entry.args.noteId)) continue;
		const prefix = prefixOf(entry.args.noteId);
		created.set(prefix, [...(created.get(prefix) ?? []), { id: entry.result, noteId: entry.args.noteId }]);
	}
	let writerChecked = 0;
	for (const [prefix, upper] of allPrefixes()) {
		const child = childOf('note_reaction', prefix);
		const [row] = await budgeted<{ rows: number; missing: number; extra: number }>(client, 'data', `
			SELECT
				(SELECT count(*)::int FROM "${child}" r WHERE left(r."id", 2) <> left(r."noteId", 2)) AS "rows",
				(SELECT count(*)::int FROM "${child}" r WHERE left(r."id", 2) <> left(r."noteId", 2) AND NOT EXISTS (SELECT 1 FROM "note_reaction_locator" l WHERE l."id" = r."id" AND l."noteId" = r."noteId" AND l."userId" = r."userId")) AS "missing",
				(SELECT count(*)::int FROM "note_reaction_locator" l WHERE ${between('noteId', 'l.')} AND NOT EXISTS (SELECT 1 FROM "${child}" r WHERE r."id" = l."id" AND r."noteId" = l."noteId" AND r."userId" = l."userId")) AS "extra"
		`, [prefix, upper]);
		crossPrefix += row.rows;
		if (row.missing > 0 || row.extra > 0) problems.push(`note_reaction_locator lacks ${row.missing} and has ${row.extra} extra rows of ${child}`);
		const mine = created.get(prefix) ?? [];
		if (mine.length === 0) continue;
		const lost = await budgeted<{ id: string }>(client, 'data', `SELECT r."id" FROM "${child}" r WHERE r."id" = ANY($1) AND NOT EXISTS (SELECT 1 FROM "note_reaction_locator" l WHERE l."id" = r."id")`, [mine.map(reaction => reaction.id)]);
		writerChecked += mine.length;
		problems.push(...lost.map(reaction => `the cross-prefix reaction ${reaction.id} created by a writer is not in note_reaction_locator`));
	}
	if (crossPrefix !== total) problems.push(`note_reaction_locator has ${total} rows for ${crossPrefix} cross-prefix reactions`);
	return { check: 'C9', problems, summary: { total, crossPrefix, writerChecked } };
}

const succeeded = (entry: OplogEntry, result: string) => entry.result === result || (entry.error != null && entry.reconciled === result);

export async function c10DeletedIds(client: pg.Client, oplogs: OplogEntry[]): Promise<CheckResult> {
	const problems: string[] = [];
	const deleted = [...new Set(oplogs.filter(entry => entry.op === 'noteDelete' && succeeded(entry, 'deleted') && typeof entry.args.noteId === 'string').map(entry => entry.args.noteId as string))];
	const recorded = new Set((await budgeted<{ id: string }>(client, 'data', 'SELECT "id" FROM "deleted_note" WHERE "id" = ANY($1)', [deleted])).map(row => row.id));
	problems.push(...deleted.filter(id => !recorded.has(id)).map(id => `the deleted note ${id} is not in deleted_note`));
	const copies = await inspectCopies(client, 'note');
	for (const [prefix, upper] of allPrefixes()) {
		if (copies.partitioned != null) {
			const rows = await budgeted<{ id: string }>(client, 'data', `SELECT d."id" FROM "deleted_note" d JOIN "${childOf('note', prefix)}" n ON n."id" = d."id" WHERE ${between('id', 'd.')}`, [prefix, upper]);
			problems.push(...rows.map(row => `${row.id} is in deleted_note and in ${childOf('note', prefix)}`));
		}
		if (copies.plain != null) {
			const rows = await budgeted<{ id: string }>(client, 'data', `SELECT d."id" FROM "deleted_note" d JOIN "${copies.plain}" n ON n."id" = d."id" WHERE ${between('id', 'd.')}`, [prefix, upper]);
			problems.push(...rows.map(row => `${row.id} is in deleted_note and in ${copies.plain}`));
		}
	}
	return { check: 'C10', problems, summary: { deletes: deleted.length } };
}

function liveSource(copies: Copies, prefix: string, alias: string): { source: string; where: string } {
	return {
		source: copies.live === 'partitioned' ? `"${childOf(copies.table, prefix)}"` : `"${copies.table}"`,
		where: between(partitionKeys[copies.table], `${alias}.`),
	};
}

export async function c11NoteUri(client: pg.Client): Promise<CheckResult> {
	const problems: string[] = [];
	const copies = await inspectCopies(client, 'note');
	let withUri = 0;
	for (const [prefix, upper] of allPrefixes()) {
		const { source, where } = liveSource(copies, prefix, 'n');
		const [row] = await budgeted<{ uris: number }>(client, 'data', `SELECT count(*)::int AS "uris" FROM ${source} n WHERE ${where} AND n."uri" IS NOT NULL`, [prefix, upper]);
		withUri += row.uris;
		const missing = await budgeted<{ id: string }>(client, 'data', `SELECT n."id" FROM ${source} n WHERE ${where} AND n."uri" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "note_uri" u WHERE u."uri" = n."uri" AND u."noteId" = n."id") LIMIT 20`, [prefix, upper]);
		problems.push(...missing.map(other => `the live note ${other.id} has a uri without a note_uri row`));
		const dangling = await budgeted<{ noteId: string }>(client, 'data', `SELECT u."noteId" FROM "note_uri" u WHERE ${between('noteId', 'u.')} AND NOT EXISTS (SELECT 1 FROM ${source} n WHERE n."id" = u."noteId") AND NOT EXISTS (SELECT 1 FROM "deleted_note" d WHERE d."id" = u."noteId") LIMIT 20`, [prefix, upper]);
		problems.push(...dangling.map(other => `note_uri points to ${other.noteId}, which is neither live nor deleted`));
	}
	return { check: 'C11', problems, summary: { withUri } };
}

export async function c12Results(client: pg.Client, model: SeedModel, oplogs: OplogEntry[]): Promise<CheckResult> {
	const problems: string[] = [];
	const summary: Record<string, unknown> = {};
	const byPrefix = (ids: string[]) => Map.groupBy(ids, id => prefixOf(id));
	const noteRows = new Map<string, { id: string; replyId: string | null; renoteId: string | null; threadId: string | null; repliesCount: number; renoteCount: number }>();
	const wanted = [...new Set([...model.edgeCases.map(edge => edge.id), ...Object.keys(model.counters)])];
	const notes = await inspectCopies(client, 'note');
	const reactions = await inspectCopies(client, 'note_reaction');
	for (const [prefix, ids] of byPrefix(wanted)) {
		const { source, where } = liveSource(notes, prefix, 'n');
		const rows = await budgeted<{ id: string; replyId: string | null; renoteId: string | null; threadId: string | null; repliesCount: number; renoteCount: number }>(client, 'data', `SELECT n."id", n."replyId", n."renoteId", n."threadId", n."repliesCount", n."renoteCount" FROM ${source} n WHERE ${where} AND n."id" = ANY($3)`, [prefix, nextPrefix(prefix), ids]);
		for (const row of rows) noteRows.set(row.id, row);
	}
	const unlinked = new Map((await budgeted<{ noteId: string; replyId: string | null; renoteId: string | null; replyUri: string | null; renoteUri: string | null }>(client, 'data', 'SELECT "noteId", "replyId", "renoteId", "replyUri", "renoteUri" FROM "note_unlinked_relation" WHERE "noteId" = ANY($1)', [model.edgeCases.map(edge => edge.id)])).map(row => [row.noteId, row]));
	for (const edge of model.edgeCases) {
		const row = noteRows.get(edge.id);
		if (row == null) {
			problems.push(`the edge case ${edge.id} (${edge.kind}) is gone`);
			continue;
		}
		for (const column of ['replyId', 'renoteId', 'threadId'] as const) {
			if (row[column] !== edge.expected[column]) problems.push(`the edge case ${edge.id} (${edge.kind}) has ${column} ${row[column]}, expected ${edge.expected[column]}`);
		}
		const actual = unlinked.get(edge.id);
		const expected = edge.expected.unlinked;
		if (JSON.stringify(actual == null ? null : { replyId: actual.replyId, renoteId: actual.renoteId, replyUri: actual.replyUri, renoteUri: actual.renoteUri }) !== JSON.stringify(expected)) problems.push(`the edge case ${edge.id} (${edge.kind}) has note_unlinked_relation ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(expected)}`);
	}
	for (const [id, counter] of Object.entries(model.counters)) {
		const row = noteRows.get(id);
		if (row == null) {
			problems.push(`the counter note ${id} is gone`);
			continue;
		}
		if (row.repliesCount !== counter.repliesCount.expected || row.renoteCount !== counter.renoteCount.expected) problems.push(`${id} has repliesCount ${row.repliesCount} and renoteCount ${row.renoteCount}, expected ${counter.repliesCount.expected} and ${counter.renoteCount.expected}`);
	}
	summary.edgeCases = model.edgeCases.length;

	const minimum = new Map<string, string>();
	let missingEdges = 0;
	let orphans = 0;
	for (const [prefix, upper] of allPrefixes()) {
		const { source, where } = liveSource(notes, prefix, 'n');
		const edges = await budgeted<{ id: string; replyId: string | null; renoteId: string | null }>(client, 'data', `
			SELECT n."id", n."replyId", n."renoteId"
			FROM ${source} n
			WHERE ${where} AND (
				(n."replyId" IS NOT NULL AND n."replyId" <> '${unreferenceableNoteId}' AND n."id" > n."replyId" AND NOT EXISTS (SELECT 1 FROM "note_relation" r WHERE r."childId" = n."id" AND r."kind" = 0 AND r."parentId" = n."replyId"))
				OR (n."renoteId" IS NOT NULL AND n."renoteId" <> '${unreferenceableNoteId}' AND n."id" > n."renoteId" AND NOT EXISTS (SELECT 1 FROM "note_relation" r WHERE r."childId" = n."id" AND r."parentId" = n."renoteId"
					AND r."kind" = CASE WHEN n."text" IS NOT NULL OR n."cw" IS NOT NULL OR n."replyId" IS NOT NULL OR n."hasPoll" OR n."fileIds" <> '{}' THEN 1 ELSE 2 END))
			)
			LIMIT 20
		`, [prefix, upper]);
		missingEdges += edges.length;
		problems.push(...edges.map(row => `the live note ${row.id} (replyId ${row.replyId}, renoteId ${row.renoteId}) lacks its note_relation edge`));
		const floors = await budgeted<{ userId: string; minId: string }>(client, 'data', `SELECT n."userId", min(n."id") AS "minId" FROM ${source} n WHERE ${where} GROUP BY n."userId"`, [prefix, upper]);
		for (const row of floors) {
			const known = minimum.get(row.userId);
			if (known == null || row.minId < known) minimum.set(row.userId, row.minId);
		}
		for (const [table, column] of dependentColumns) {
			const rows = await budgeted<{ id: string }>(client, 'data', `SELECT d."${column}" AS "id" FROM "${table}" d WHERE ${between(column, 'd.')} AND NOT EXISTS (SELECT 1 FROM ${source} n WHERE n."id" = d."${column}") LIMIT 20`, [prefix, upper]);
			orphans += rows.length;
			problems.push(...rows.map(row => `${table}.${column} ${row.id} has no note`));
		}
		const reactionSource = liveSource(reactions, prefix, 'r');
		const rows = await budgeted<{ id: string }>(client, 'data', `SELECT r."noteId" AS "id" FROM ${reactionSource.source} r WHERE ${reactionSource.where} AND NOT EXISTS (SELECT 1 FROM ${source} n WHERE n."id" = r."noteId") LIMIT 20`, [prefix, upper]);
		orphans += rows.length;
		problems.push(...rows.map(row => `note_reaction.noteId ${row.id} has no note`));
	}
	const users = await budgeted<{ id: string; floor: string; host: string | null }>(client, 'data', 'SELECT "id", COALESCE("noteIdFloor", "id") AS "floor", "host" FROM "user"');
	let floorsChecked = 0;
	for (const user of users) {
		const min = minimum.get(user.id);
		if (min == null) continue;
		floorsChecked++;
		if (min < user.floor) problems.push(`the ${user.host == null ? 'local' : 'remote'} user ${user.id} has the note ${min} below its floor ${user.floor}`);
	}

	const parents = new Map<string, string>();
	const children: string[] = [];
	for (const entry of oplogs) {
		if (entry.op === 'pendingReply' && typeof entry.result === 'string') children.push(entry.result);
		if (entry.op === 'pendingParent' && typeof entry.result === 'string' && typeof entry.args.childId === 'string') parents.set(entry.args.childId, entry.result);
	}
	let linked = 0;
	let waiting = 0;
	for (const [prefix, ids] of byPrefix(children.filter(id => parents.has(id)))) {
		const { source, where } = liveSource(notes, prefix, 'n');
		const rows = await budgeted<{ id: string; replyId: string | null }>(client, 'data', `SELECT n."id", n."replyId" FROM ${source} n WHERE ${where} AND n."id" = ANY($3)`, [prefix, nextPrefix(prefix), ids]);
		const pending = new Set((await budgeted<{ childId: string }>(client, 'data', 'SELECT "childId" FROM "note_pending_parent" WHERE "childId" = ANY($1)', [rows.map(row => row.id)])).map(row => row.childId));
		for (const row of rows) {
			const parentId = parents.get(row.id)!;
			if (row.replyId === parentId) {
				linked++;
			} else if (row.replyId === unreferenceableNoteId && pending.has(row.id)) {
				waiting++;
			} else {
				const [parent] = await budgeted<{ id: string }>(client, 'data', 'SELECT "id" FROM "note" WHERE "id" = $1', [parentId]);
				if (parent != null) problems.push(`the pending child ${row.id} has replyId ${row.replyId} and no pending row although its parent ${parentId} exists`);
			}
		}
	}
	summary.floorsChecked = floorsChecked;
	summary.pendingChildren = { created: children.length, linked, waiting };
	summary.missingEdges = missingEdges;
	summary.orphans = orphans;
	return { check: 'C12', problems, summary };
}

const deployMarginMs = 6000;

function deployProbeOf(probes: DeployProbe[], t: number, to = t): DeployProbe | undefined {
	return probes.find(probe => probe.goAt != null && to >= probe.goAt && t <= (probe.endAt ?? probe.goAt) + deployMarginMs);
}

export function c13Errors(context: StageContext, oplogs: OplogEntry[]): CheckResult {
	const { from, to, fleet, redisLosses } = context;
	const problems: string[] = [];
	const counts: Record<string, number> = {};
	const deploy: Record<string, string[]> = {};
	const count = (name: string) => {
		counts[name] = (counts[name] ?? 0) + 1;
	};
	const attribute = (probe: DeployProbe, line: string) => {
		(deploy[probe.name] ??= []).push(line);
	};
	const lostRuns = fleet.runStarts.flatMap(start => {
		const end = fleet.runEnds.find(other => other.child === start.child && other.run === start.run)?.t ?? Infinity;
		const loss = redisLosses.find(other => start.t < other.killedAt && end > other.killedAt);
		return loss != null && start.jobId != null ? [{ child: start.child, jobId: start.jobId, from: loss.killedAt, to: end + 60 * 1000 }] : [];
	});
	const lostWithRedis = (child: string, message: string, t: number) => {
		const jobId = jobLostWithRedis.exec(message)?.[1];
		if (jobId == null) return false;
		return inRedisWindow(redisLosses, t) || lostRuns.some(lost => lost.child === child && lost.jobId === jobId && t >= lost.from && t <= lost.to);
	};
	const deployPids = new Map(context.deployProbes.map(probe => [probe, new Set(context.pidsOf(probe.app))]));
	const involvesDeploy = (entry: PgLogEntry, holders: number[]): DeployProbe | undefined => {
		const probe = deployProbeOf(context.deployProbes, entry.t);
		if (probe == null) return undefined;
		const pids = [...`${entry.detail ?? ''}`.matchAll(/Process (\d+)/g)].map(match => Number(match[1]));
		return entry.app === probe.app || [...pids, ...holders].some(pid => deployPids.get(probe)!.has(pid)) ? probe : undefined;
	};
	const creators = new Map(oplogs.flatMap(entry => (typeof entry.result === 'string' ? [[entry.result, entry.file] as const] : [])));
	const takenIds = new Set<PgLogEntry>();
	const takenByAnotherWriter = (entry: OplogEntry) => {
		if (entry.op !== 'reactionCreate' || entry.error?.class !== 'EntityNotFoundError' || !reactionIdTaken.message.test(entry.error.message)) return false;
		const log = context.pgLog.find(other => {
			const id = reactionIdTaken.detail.exec(other.detail ?? '')?.[1];
			return id != null && !takenIds.has(other) && other.sqlState === '23505' && other.app === `mk-e2e-${entry.file.replace(/\.jsonl$/, '')}` && other.t >= entry.t - 1000 && other.t <= entry.t + entry.latencyMs + 1000 && reactionIdTaken.statement.test(other.statement ?? '') && creators.has(id) && creators.get(id) !== entry.file;
		});
		if (log != null) takenIds.add(log);
		return log != null;
	};
	for (const entry of oplogs.filter(other => other.t >= from && other.t <= to)) {
		if (entry.latencyMs > 10 * 1000) count(`latency>10s ${entry.op}`);
		if (entry.error == null) continue;
		const error = entry.error;
		const probe = deployProbeOf(context.deployProbes, entry.t, entry.t + entry.latencyMs);
		if (probe != null && ['40P01', '55P03'].includes(error.sqlState ?? '')) {
			attribute(probe, `${entry.file}#${entry.seq} ${entry.op} failed: ${error.sqlState} ${error.message}`);
		} else if (error.sqlState === '57014') {
			problems.push(`${entry.file}#${entry.seq} ${entry.op} hit the statement timeout: ${error.message}`);
		} else if ((error.identifiableId != null && businessErrors.identifiable.includes(error.identifiableId)) || businessErrors.classes.includes(error.class) || businessErrors.messages.includes(error.message)) {
			count(`E_BUSINESS ${entry.op} ${error.identifiableId ?? error.class} ${error.message}`);
		} else if (redisErrors.test(error.message) && inRedisWindow(redisLosses, entry.t, entry.t + entry.latencyMs)) {
			count(`E_REDIS ${entry.op}`);
		} else if (takenByAnotherWriter(entry)) {
			count(`E_UPSTREAM ${entry.op} id generated by another writer in the same millisecond`);
		} else {
			problems.push(`${entry.file}#${entry.seq} ${entry.op} ${JSON.stringify(entry.args)} failed: ${error.class} ${error.identifiableId ?? ''} ${error.message}`);
		}
	}
	const lockTimeouts: JobLog[] = [];
	for (const log of fleet.jobLogs.filter(other => other.t >= from && other.t <= to)) {
		if (allowedJobLogs.some(pattern => pattern.test(log.row))) continue;
		if (lockTimeoutJobLog.test(log.row)) {
			lockTimeouts.push(log);
			count('job-log lock timeout');
			continue;
		}
		problems.push(`${log.child} run ${log.run} logged: ${log.row}`);
	}
	for (const runError of fleet.runErrors.filter(other => other.t >= from && other.t <= to)) {
		const probe = deployProbeOf(context.deployProbes, runError.t);
		if (probe != null && /deadlock detected|lock timeout/.test(runError.message)) attribute(probe, `${runError.child} run ${runError.run} threw: ${runError.message}`);
		else problems.push(`${runError.child} run ${runError.run} threw: ${runError.message}`);
	}
	for (const child of fleet.children) {
		for (const line of child.problems.filter(other => other.level === 'ERR ' && other.t >= from && other.t <= to)) {
			const probe = deployProbeOf(context.deployProbes, line.t);
			if (redisErrors.test(line.line) && inRedisWindow(redisLosses, line.t)) count(`E_REDIS logger ${child.role}`);
			else if (child.role === 'runner' && lostWithRedis(child.name, line.line, line.t)) count('E_REDIS logger runner: a job lost with Redis');
			else if (child.role === 'runner' && harnessDelivery.test(line.line)) count('E_DELIVER deliver job to a harness host');
			else if (probe != null && /deadlock detected|lock timeout/.test(line.line)) attribute(probe, `${child.name} logged: ${line.line}`);
			else problems.push(`${child.name} logged an error: ${line.line}`);
		}
	}
	const deletedNotes = new Set(oplogs.filter(entry => entry.op === 'noteDelete' && succeeded(entry, 'deleted')).map(entry => entry.args.noteId));
	for (const error of fleet.processErrors.filter(other => other.t >= from && other.t <= to)) {
		const deletedNote = deletedNoteNotification.message.exec(error.message)?.[1];
		if (redisErrors.test(error.message) && inRedisWindow(redisLosses, error.t)) count(`E_REDIS ${error.kind}`);
		else if (error.kind === 'unhandledRejection' && /^runner-/.test(error.child) && lostWithRedis(error.child, error.message, error.t)) count(`E_REDIS ${error.kind}: the log of a job lost with Redis`);
		else if (error.kind === 'unhandledRejection' && deletedNote != null && deletedNotes.has(deletedNote) && deletedNoteNotification.stack.test(error.stack ?? '')) count('E_UPSTREAM notification packed after its note was deleted');
		else problems.push(`${error.child} had an ${error.kind}: ${error.message}`);
	}
	const killed = new Set(fleet.children.filter(child => child.killedAt != null).map(child => `mk-e2e-${child.name}`));
	const waits = context.pgLog.filter(entry => entry.severity === 'LOG' && /still waiting for/.test(entry.message));
	for (const wait of waits) {
		const probe = involvesDeploy(wait, lockHolders(wait));
		if (probe != null) attribute(probe, `${wait.app ?? wait.backendType} (${wait.pid}) ${wait.message} ${wait.detail ?? ''}${wait.statement != null ? ` [${wait.statement.trim().slice(0, 200)}]` : ''}`);
	}
	for (const entry of context.pgLog.filter(other => other.severity !== 'LOG')) {
		const app = entry.app ?? '';
		const where = `${entry.severity} ${entry.sqlState} from ${app || entry.backendType} (${entry.pid}): ${entry.message}${entry.statement != null ? ` [${entry.statement.trim().slice(0, 200)}]` : ''}`;
		const wait = waits.filter(other => other.pid === entry.pid && other.t <= entry.t && other.t >= entry.t - 6000).at(-1);
		const holderPids = wait == null ? [] : lockHolders(wait);
		const probe = involvesDeploy(entry, holderPids);
		if (probe != null && ['40P01', '55P03', '57014'].includes(entry.sqlState ?? '')) {
			attribute(probe, `${where}${entry.detail != null ? ` (${entry.detail})` : ''}`);
		} else if (['53200', '40P01', 'XX000'].includes(entry.sqlState ?? '')) {
			problems.push(where);
		} else if (entry.sqlState === '57014') {
			if (entry.backendType === 'autovacuum worker' && entry.message === 'canceling autovacuum task') count('autovacuum canceled');
			else problems.push(where);
		} else if (entry.sqlState === '55P03' && (app.startsWith('mk-e2e-runner-') || app === 'mk-e2e-harness-blocker')) {
			const holders = holderPids.map(pid => context.appOf(pid));
			if (holders.some(holder => holder != null && (killed.has(holder) || holder === 'mk-e2e-harness-blocker'))) count(`55P03 behind ${holders.join(', ')}`);
			else problems.push(`${where} is not explained by a blocker or a backend of a killed process (holders: ${holders.join(', ') || 'unknown'})`);
		} else if (entry.sqlState === '23505' && app.startsWith('mk-e2e-writer-') && /INSERT INTO "note(_reaction)?"[\s(]/.test(entry.statement ?? '')) {
			count(`23505 ${app.replace(/-\d+$/, '')}`);
		} else if (app === 'mk-e2e-harness-fixtureprobe' && fixtureProbeErrors.includes(entry.sqlState ?? '') && context.fixtureWindows.some(window => entry.t >= window.from && entry.t <= window.to)) {
			count(`fixture probe ${entry.sqlState}`);
		} else if (entry.sqlState === '42P01' && app === 'mk-e2e-harness-sample') {
			count('C3 sample behind a switch or drop');
		} else if (entry.severity === 'FATAL' && ['08006', '08P01'].includes(entry.sqlState ?? '') && killed.has(app)) {
			count('connection of a killed process lost');
		} else {
			problems.push(where);
		}
	}
	return { check: 'C13', problems, summary: { counts, lockTimeouts: lockTimeouts.length, pgErrors: context.pgLog.filter(entry => entry.severity !== 'LOG').length, deployProbes: deploy } };
}

export function jobLogOrder(stage: string, logs: JobLog[], expected: { ordered: RegExp[][]; present: RegExp[] }, killedAtCommit: KillRecord[]): CheckResult {
	const problems: string[] = [];
	const lostAtCommit: string[] = [];
	const missing = (pattern: RegExp) => {
		if (killedAtCommit.length > 0 && postCommitJobLog.test(pattern.source)) lostAtCommit.push(String(pattern));
		else problems.push(`no job log matches ${pattern}`);
	};
	for (const chain of expected.ordered) {
		let previous: JobLog | null = null;
		for (const pattern of chain) {
			const log = logs.find(other => pattern.test(other.row));
			if (log == null) {
				missing(pattern);
				continue;
			}
			if (previous != null && log.t < previous.t) problems.push(`${log.row} was logged before ${previous.row}`);
			previous = log;
		}
	}
	for (const pattern of expected.present) {
		if (!logs.some(other => pattern.test(other.row))) missing(pattern);
	}
	return { check: `job logs ${stage}`, problems, summary: { logs: logs.length, lostAtCommit, killedAtCommit: killedAtCommit.map(kill => `${kill.victim} ${kill.trigger}`) } };
}

export async function catalogHash(client: pg.Client): Promise<string> {
	const [{ hash }] = await budgeted<{ hash: string }>(client, 'catalog', `
		WITH copies AS (
			SELECT oid, relname, relkind FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relname ~ '^note(_reaction)?(_old|_p|_p_[0-9a-z]{2})?$' AND relkind IN ('r', 'p')
		)
		SELECT md5(string_agg(x, E'\\n' ORDER BY x COLLATE "C")) AS "hash" FROM (
			SELECT 'relation ' || relname::text || ' ' || relkind::text FROM copies
			UNION ALL SELECT 'index ' || c.relname::text || ' ' || pg_get_indexdef(i.indexrelid) || ' ' || i.indisvalid::text FROM pg_index i JOIN copies t ON t.oid = i.indrelid JOIN pg_class c ON c.oid = i.indexrelid
			UNION ALL SELECT 'constraint ' || t.relname::text || ' ' || con.conname::text || ' ' || pg_get_constraintdef(con.oid) || ' ' || con.convalidated::text FROM pg_constraint con JOIN copies t ON t.oid = con.conrelid
			UNION ALL SELECT 'trigger ' || t.relname::text || ' ' || tg.tgname::text || ' ' || tg.tgenabled::text FROM pg_trigger tg JOIN copies t ON t.oid = tg.tgrelid WHERE NOT tg.tgisinternal
			UNION ALL SELECT 'function ' || proname::text || ' ' || md5(prosrc) FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname ~ '^note_'
			UNION ALL SELECT 'state ' || "name" || ' ' || ("finishedAt" IS NOT NULL)::text FROM "partition_migration_state"
		) t(x)
	`);
	return hash;
}

export type ProbeTargets = {
	stage: string;
	index: number;
	output: string;
	probeUserId: string;
	notes: string[];
	missingNoteId: string;
	deletedNoteId: string | null;
	remoteUserId: string;
	localUserId: string;
	replyParentId: string;
	renoteTargetId: string;
	conversationId: string;
	reactionNoteId: string;
	channelId: string;
	clipId: string;
	tag: string;
	remoteNote: { uri: string; id: string };
	localNote: { uri: string; id: string };
	likes: { kind: 'same prefix' | 'cross prefix'; id: string; noteId: string }[];
	listUserIds: string[];
	notifications: { userId: string; noteIds: string[] };
	spreadNoteIds: string[];
	favoriteNoteIds: string[];
	writes: { reactionNoteId: string; favoriteNoteId: string; clipNoteId: string; pollNoteId: string };
};

export type ProbeCall = { name: string; params: Record<string, unknown>; ms: number; ok: boolean; ids: string[]; objectId: string | null; error: { id: string | null; message: string } | null };

export type ProbeRoute = { name: string; url: string; ms: number; status: number; type: string | null; id: string | null };

export type ProbeOutput = { startedAt: number; endedAt: number; calls: ProbeCall[]; routes: ProbeRoute[]; usersReactions: Record<string, string[]>; createdNoteId: string | null; reaction: { id: string; noteId: string } | null };

type ProbeReference = { usersReactions: string[]; noteReactions: string[]; remoteNoteId: string | null };

export type StatementStat = { queryId: string; toplevel: boolean; calls: number; query: string };

const stableKinds = new Set(['local', 'remote', 'floor', 'probe']);

export function probeTargets(seed: Seed, stage: string, index: number, oplogs: OplogEntry[], output: string): ProbeTargets {
	const rows = (table: string) => seed.tables.find(([name]) => name === table)?.[1] ?? [];
	const probeUserId = seed.model.users.probe[0];
	const notesById = new Map(seed.notes.map(note => [note.id, note]));
	const stable = seed.notes.filter(note => !note.special && stableKinds.has(note.user.kind));
	const stableIds = new Set(stable.map(note => note.id));
	const visible = stable.filter(note => note.visibility === 'public' && !note.pureRenote && note.channelId == null);
	const first = new Map<string, string>();
	for (const note of visible) if (!first.has(prefixOf(note.id))) first.set(prefixOf(note.id), note.id);
	const prefixes = [...first.keys()].sort();
	const notes = [...new Set([0, 0.25, 0.5, 0.75, 1].map(q => first.get(prefixes[Math.round(q * (prefixes.length - 1))])))].filter(id => id != null);
	const missingFrom = prefixStart(prefixToOrdinal(prefixes[Math.floor(prefixes.length / 2)])) + 123456789;
	let missingNoteId = aid(missingFrom, 1295);
	for (let k = 1; notesById.has(missingNoteId); k++) missingNoteId = aid(missingFrom + k, 1295);
	const deleted = oplogs.filter(entry => entry.op === 'noteDelete' && succeeded(entry, 'deleted') && entry.args.uri == null && typeof entry.args.noteId === 'string').at(-1);
	const users = seed.users.filter(user => stableKinds.has(user.kind));
	const stableUsers = new Set(users.map(user => user.id));
	const prefixesOf = (userId: string) => new Set(stable.filter(note => note.user.id === userId).map(note => prefixOf(note.id))).size;
	const remoteUsers = users.filter(user => user.host != null);
	const localUsers = users.filter(user => user.kind === 'local');
	const pinned = new Set(rows('user_note_pining').map(row => row.userId as string));
	const replies = Map.groupBy(stable, note => note.replyId);
	const renotes = Map.groupBy(stable, note => note.renoteId);
	const reactions = rows('note_reaction') as { id: string; noteId: string; userId: string }[];
	const reactionsOf = Map.groupBy(reactions, reaction => reaction.noteId);
	const clipNotes = Map.groupBy(rows('clip_note'), row => row.clipId as string);
	const most = <T>(items: T[], score: (item: T) => number): T => items.reduce((a, b) => (score(b) > score(a) ? b : a));
	const required = <T>(value: T | null | undefined, what: string): T => {
		if (value == null) throw new Error(`the seed has no ${what} for the probe`);
		return value;
	};
	const remote = required(visible.find(note => note.user.host != null && note.uri != null), 'remote note');
	const local = required(visible.find(note => note.user.host == null && note.row.hasPoll !== true), 'local note without a poll');
	const like = (same: boolean) => reactions.find(reaction => stableUsers.has(reaction.userId) && stableIds.has(reaction.noteId) && (prefixOf(reaction.id) === prefixOf(reaction.noteId)) === same);
	const reacted = new Set(reactions.filter(reaction => reaction.userId === probeUserId).map(reaction => reaction.noteId));
	const favorites = rows('note_favorite').filter(row => row.userId === probeUserId).toSorted((a, b) => ((a.id as string) < (b.id as string) ? 1 : -1));
	const favorited = new Set(favorites.map(row => row.noteId as string));
	const voted = new Set(rows('poll_vote').filter(row => row.userId === probeUserId).map(row => row.noteId as string));
	const candidates = visible.filter(note => !reacted.has(note.id) && !favorited.has(note.id) && note.user.id !== probeUserId);
	const polls = visible.filter(note => note.row.hasPoll === true && !voted.has(note.id));
	const reactionNoteId = most(visible.filter(note => (reactionsOf.get(note.id)?.length ?? 0) <= 100), note => reactionsOf.get(note.id)?.length ?? 0).id;
	const notifier = localUsers[0].id;
	const notifierReacted = new Set(reactions.filter(reaction => reaction.userId === notifier).map(reaction => reaction.noteId));
	const spread = (spreading: typeof visible) => [...Map.groupBy(spreading, note => prefixOf(note.id)).values()].map(group => group[group.length - 1].id).sort().reverse().slice(0, 100);
	return {
		stage,
		index,
		output,
		probeUserId,
		notes,
		missingNoteId,
		deletedNoteId: deleted != null ? deleted.args.noteId as string : null,
		remoteUserId: most(remoteUsers, user => prefixesOf(user.id)).id,
		localUserId: (localUsers.find(user => pinned.has(user.id)) ?? localUsers[0]).id,
		replyParentId: most(visible, note => replies.get(note.id)?.length ?? 0).id,
		renoteTargetId: most(visible, note => renotes.get(note.id)?.length ?? 0).id,
		conversationId: required(visible.find(note => note.replyId != null && notesById.get(note.replyId)?.replyId != null), 'reply to a reply').id,
		reactionNoteId,
		channelId: rows('channel')[0].id as string,
		clipId: most(rows('clip').filter(row => row.isPublic === true), row => clipNotes.get(row.id as string)?.length ?? 0).id as string,
		tag: visible.flatMap(note => note.row.tags as string[])[0],
		remoteNote: { uri: required(remote.uri, 'remote note uri'), id: remote.id },
		localNote: { uri: localNoteUri(local.id), id: local.id },
		likes: ([['same prefix', like(true)], ['cross prefix', like(false)]] as const).flatMap(([kind, reaction]) => reaction != null ? [{ kind, id: reaction.id, noteId: reaction.noteId }] : []),
		listUserIds: [localUsers[localUsers.length - 1].id, remoteUsers[0].id],
		notifications: { userId: notifier, noteIds: spread(visible.filter(note => note.user.id === probeUserId && note.id !== reactionNoteId && !notifierReacted.has(note.id))) },
		spreadNoteIds: spread(visible),
		favoriteNoteIds: favorites.slice(0, 100 - index).map(row => row.noteId as string).filter(id => stableIds.has(id)),
		writes: { reactionNoteId: candidates[0].id, favoriteNoteId: candidates[1 + index].id, clipNoteId: candidates[101 + index].id, pollNoteId: polls[index % polls.length].id },
	};
}

export async function probeReference(client: pg.Client, targets: ProbeTargets): Promise<ProbeReference> {
	const notes = await inspectCopies(client, 'note');
	const reactions = await inspectCopies(client, 'note_reaction');
	const mine: { id: string; noteId: string }[] = [];
	if (reactions.live === 'partitioned') {
		for (const [prefix] of allPrefixes()) mine.push(...await budgeted<{ id: string; noteId: string }>(client, 'data', `SELECT "id", "noteId" FROM "${childOf('note_reaction', prefix)}" WHERE "userId" = $1`, [targets.probeUserId]));
	} else {
		mine.push(...await budgeted<{ id: string; noteId: string }>(client, 'data', 'SELECT "id", "noteId" FROM "note_reaction" WHERE "userId" = $1', [targets.probeUserId]));
	}
	const visible = new Set<string>();
	for (const [prefix, ids] of Map.groupBy(mine.map(reaction => reaction.noteId), id => prefixOf(id))) {
		const { source, where } = liveSource(notes, prefix, 'n');
		for (const row of await budgeted<{ id: string }>(client, 'data', `SELECT n."id" FROM ${source} n WHERE ${where} AND n."id" = ANY($3) AND n."visibility" IN ('public', 'home')`, [prefix, nextPrefix(prefix), ids])) visible.add(row.id);
	}
	const prefix = prefixOf(targets.reactionNoteId);
	const { source, where } = liveSource(reactions, prefix, 'r');
	const noteReactions = await budgeted<{ id: string }>(client, 'data', `SELECT r."id" FROM ${source} r WHERE ${where} AND r."noteId" = $3 ORDER BY r."id" DESC LIMIT 100`, [prefix, nextPrefix(prefix), targets.reactionNoteId]);
	const uri = (await budgeted<{ noteId: string }>(client, 'data', 'SELECT "noteId" FROM "note_uri" WHERE "uri" = $1', [targets.remoteNote.uri])).at(0);
	return {
		usersReactions: mine.filter(reaction => visible.has(reaction.noteId)).map(reaction => reaction.id).sort().reverse(),
		noteReactions: noteReactions.map(row => row.id),
		remoteNoteId: uri?.noteId ?? null,
	};
}

export function probeResult(output: ProbeOutput, targets: ProbeTargets, reference: ProbeReference, label: string): CheckResult {
	const problems: string[] = [];
	const missing = new Set([targets.missingNoteId, ...(targets.deletedNoteId != null ? [targets.deletedNoteId] : [])]);
	for (const call of output.calls) {
		if (call.name === 'notes/show' && missing.has(call.params.noteId as string)) {
			if (call.ok || call.error?.id !== noSuchNote) problems.push(`notes/show of the missing or deleted ${String(call.params.noteId)} returned ${call.ok ? 'the note' : call.error?.message}`);
		} else if (!call.ok) {
			problems.push(`${call.name} ${JSON.stringify(call.params)} failed: ${call.error?.message}`);
		}
	}
	const difference = (actual: string[], expected: string[]) => `${actual.length} ids, expected ${expected.length}; only returned ${actual.filter(id => !expected.includes(id)).slice(0, 10).join(', ')}; only expected ${expected.filter(id => !actual.includes(id)).slice(0, 10).join(', ')}`;
	for (const limit of ['10', '100']) {
		if (!(limit in output.usersReactions)) problems.push(`the probe did not read users/reactions of the probe user in pages of ${limit}`);
	}
	for (const [limit, ids] of Object.entries(output.usersReactions)) {
		if (JSON.stringify(ids) !== JSON.stringify(reference.usersReactions)) problems.push(`users/reactions of the probe user in pages of ${limit} returned ${difference(ids, reference.usersReactions)}`);
	}
	const noteReactions = output.calls.find(call => call.name === 'notes/reactions')?.ids ?? [];
	if (JSON.stringify(noteReactions) !== JSON.stringify(reference.noteReactions)) problems.push(`notes/reactions of ${targets.reactionNoteId} returned ${difference(noteReactions, reference.noteReactions)}`);
	const shows = output.calls.filter(call => call.name === 'ap/show');
	const remoteShow = shows.at(0);
	const localShow = shows.at(1);
	if (reference.remoteNoteId == null || remoteShow?.objectId !== reference.remoteNoteId) problems.push(`ap/show of ${targets.remoteNote.uri} resolved to ${remoteShow?.objectId ?? null}, note_uri has ${reference.remoteNoteId}`);
	if (localShow?.objectId !== targets.localNote.id) problems.push(`ap/show of ${targets.localNote.uri} resolved to ${localShow?.objectId ?? null}`);
	const expectRoute = (name: string, status: number, type: string | null, id: string | null) => {
		const route = output.routes.find(other => other.name === name);
		if (route == null) problems.push(`the probe did not request ${name}`);
		else if (route.status !== status || (type != null && route.type !== type) || (id != null && route.id !== id)) problems.push(`${route.url} answered ${route.status} ${route.type} ${route.id}, expected ${status} ${type ?? ''} ${id ?? ''}`);
	};
	expectRoute('note', 200, 'Note', `${harnessUrl}/notes/${targets.localNote.id}`);
	expectRoute('note activity', 200, null, null);
	expectRoute('missing note', 404, null, null);
	if (targets.deletedNoteId != null) expectRoute('deleted note', 200, 'Tombstone', null);
	expectRoute('featured', 200, null, null);
	for (const like of targets.likes) {
		expectRoute(`like ${like.kind}`, 200, 'Like', `${harnessUrl}/likes/${like.noteId}/${like.id}`);
		expectRoute(`like ${like.kind} by id`, 200, 'Like', `${harnessUrl}/likes/${like.noteId}/${like.id}`);
	}
	if (output.createdNoteId == null) problems.push('notes/create did not return the created note');
	else expectRoute('deleted own note', 200, 'Tombstone', null);
	if (output.reaction == null) problems.push('notes/reactions/create left no reaction to look up');
	else {
		expectRoute('deleted like', 404, null, null);
		expectRoute('deleted like by id', 404, null, null);
	}
	return { check: `C14 probe ${label}`, problems, summary: { ms: output.endedAt - output.startedAt, calls: output.calls.length, routes: output.routes.length, usersReactions: Object.fromEntries(Object.entries(output.usersReactions).map(([limit, ids]) => [limit, ids.length])), notified: targets.notifications.noteIds.length, slowest: output.calls.toSorted((a, b) => b.ms - a.ms).slice(0, 3).map(call => `${call.name} ${Math.round(call.ms)} ms`) } };
}

type PathMaxima = { statements: number; relationLocks: number; spilled: number; children: Record<string, number>; shape: string };

const capturePath = (source: string) => source.replace(/^probe-\d+ /, '').replace(/^(writer-[ab])-\d+$/, '$1');

export function c14aReplay(replays: Replay[], fastPathSlots: number, spans: Record<string, number>): CheckResult {
	const problems: string[] = [];
	const maxima: Record<string, number> = {};
	const paths: Record<string, PathMaxima> = {};
	for (const replay of replays.filter(other => other.kind === 'replayed')) {
		const where = `${replay.sources.slice(0, 3).join(', ')}: ${replay.text.replace(/\s+/g, ' ').trim().slice(0, 240)} ${JSON.stringify(replay.values).slice(0, 160)}`;
		if (replay.error != null) problems.push(`the replay failed (${replay.error}) for ${where}`);
		for (const [family, children] of Object.entries(replay.children)) {
			maxima[family] = Math.max(maxima[family] ?? 0, children.length);
			if (children.length > replay.allowance) problems.push(`locked ${children.length} partitions of ${family} (${children.slice(0, 5).join(', ')}${children.length > 5 ? ', ...' : ''}), at most ${replay.allowance}${replay.bound ? ' for a per-partition step' : ''}: ${where}`);
		}
		if (replay.subplansRemoved > 0) problems.push(`the plan removed ${replay.subplansRemoved} subplans: ${where}`);
		if (replay.relationLocks > fastPathSlots) problems.push(`took ${replay.relationLocks} relation locks, more than the ${fastPathSlots} fast-path lock slots of a backend: ${where}`);
		for (const path of new Set(replay.sources.map(capturePath))) {
			const entry = paths[path] ??= { statements: 0, relationLocks: 0, spilled: 0, children: {}, shape: '' };
			entry.statements++;
			if (replay.relationLocks > entry.relationLocks) Object.assign(entry, { relationLocks: replay.relationLocks, shape: statementShape(replay.text).slice(0, 160) });
			entry.spilled = Math.max(entry.spilled, replay.spilled);
			for (const [family, children] of Object.entries(replay.children)) entry.children[family] = Math.max(entry.children[family] ?? 0, children.length);
		}
	}
	const noteChildren = new Map(Object.entries(paths).map(([path, entry]) => [path, entry.children.note]));
	for (const [path, span] of Object.entries(spans)) {
		const children = noteChildren.get(path) ?? 0;
		if (children < span) problems.push(`${path} locked at most ${children} partitions of note in one statement, so its page at the API limit did not span the ${span} partitions it should`);
	}
	return {
		check: 'C14a replay',
		problems,
		summary: {
			...Object.fromEntries([...Map.groupBy(replays, other => other.kind)].map(([kind, group]) => [kind, group.length])),
			fastPathSlots,
			spans,
			maxChildren: maxima,
			maxRelationLocks: Math.max(0, ...replays.map(other => other.relationLocks)),
			maxSpilled: Math.max(0, ...replays.map(other => other.spilled)),
			paths: Object.fromEntries(Object.entries(paths).sort((a, b) => b[1].relationLocks - a[1].relationLocks)),
		},
	};
}

export async function c14bAutoExplain(run: Run, from: number, to: number): Promise<{ result: CheckResult; queryIds: Set<string>; texts: Set<string> }> {
	const problems: string[] = [];
	const queryIds = new Set<string>();
	const texts = new Set<string>();
	const roles: Record<string, number> = {};
	const plans = await readPlans(run, from, to, plan => {
		const role = (plan.app ?? 'unknown').replace(/^mk-e2e-/, '').replace(/-\d+$/, '');
		roles[role] = (roles[role] ?? 0) + 1;
		if (plan.queryId != null) queryIds.add(plan.queryId);
		texts.add(coverageShape(plan.text));
		const over = Object.entries(plan.children).filter(([, children]) => children.length > plan.allowance);
		if (over.length === 0 && plan.subplansRemoved === 0) return;
		problems.push(`${plan.app} (${plan.pid}) ran a plan that ${[...over.map(([family, children]) => `scans ${children.length} partitions of ${family} (at most ${plan.allowance})`), ...(plan.subplansRemoved > 0 ? [`removed ${plan.subplansRemoved} subplans`] : [])].join(' and ')}: ${normalizedText(plan.text).slice(0, 240)} ${plan.parameters?.slice(0, 160) ?? ''}`);
	});
	return { result: { check: 'C14b auto_explain', problems, summary: { plans, roles } }, queryIds, texts };
}

const transactionClass = (peak: LockPeak) => peak.classes.includes('global') ? 'global' : peak.classes.includes('per-partition') ? 'per-partition' : 'other';

export function lockClassOf(role: string, query: string): string {
	if (!role.startsWith('runner')) return role;
	return runnerStatementClasses.find(([, pattern]) => pattern.test(query))?.[0] ?? 'other';
}

export function c14cLocks(peaks: LockPeak[], maxima: Partial<Record<string, LockPeak>>, samples: number, fastPathSlots: number, pathOf: (peak: LockPeak) => string): CheckResult {
	const problems: string[] = [];
	const runner: Partial<Record<string, { relationLocks: number; query: string }>> = {};
	const app: Record<string, { transactions: number; relationLocks: number; query: string }> = {};
	for (const peak of peaks) {
		if (appRoles.includes(peak.role)) {
			if (peak.relationLocks > fastPathSlots) problems.push(`${peak.app} (${peak.pid}) held ${peak.relationLocks} relation locks in one transaction, more than the ${fastPathSlots} fast-path lock slots of a backend: ${peak.query.replace(/\s+/g, ' ').slice(0, 240)}`);
			const entry = app[pathOf(peak)] ??= { transactions: 0, relationLocks: -1, query: '' };
			entry.transactions++;
			if (peak.relationLocks > entry.relationLocks) Object.assign(entry, { relationLocks: peak.relationLocks, query: statementShape(peak.query).slice(0, 160) });
		}
		if (!peak.role.startsWith('runner')) continue;
		const kind = transactionClass(peak);
		if (kind === 'per-partition' && peak.relationLocks >= lockLimits.perPartition) problems.push(`${peak.app} (${peak.pid}) held ${peak.relationLocks} relation locks in a per-partition transaction: ${peak.query.replace(/\s+/g, ' ').slice(0, 240)}`);
		if ((runner[kind]?.relationLocks ?? -1) < peak.relationLocks) runner[kind] = { relationLocks: peak.relationLocks, query: statementShape(peak.query).slice(0, 200) };
	}
	const runnerShapes = Map.groupBy(peaks.filter(peak => peak.role.startsWith('runner') && peak.relationLocks >= 20), peak => `${transactionClass(peak)} ${statementShape(peak.query).slice(0, 120)}`);
	return {
		check: 'C14c lock samples',
		problems,
		summary: {
			samples,
			fastPathSlots,
			maxima: Object.fromEntries(Object.entries(maxima).flatMap(([role, peak]) => peak != null ? [[role, { relationLocks: peak.relationLocks, query: statementShape(peak.query).slice(0, 160) }]] : [])),
			app: Object.fromEntries(Object.entries(app).sort((a, b) => b[1].relationLocks - a[1].relationLocks)),
			runner,
			runnerShapes: Object.fromEntries([...runnerShapes].map(([shape, group]) => [shape, Math.max(...group.map(peak => peak.relationLocks))]).sort((a, b) => (b[1] as number) - (a[1] as number)).slice(0, 20)),
		},
	};
}

export async function c14dGenericPlans(client: pg.Client, userId: string, olderPrefix: string): Promise<CheckResult> {
	const problems: string[] = [];
	const now = Date.now();
	const noteId = aid(now, 1291);
	const reactionId = aid(now, 1292);
	const reactedNoteId = aid(prefixStart(prefixToOrdinal(olderPrefix)) + 987654321, 1293);
	const steps: Record<string, [string, string, unknown[]][]> = {
		note: [
			['INSERT', 'INSERT INTO "note" ("id", "userId", "visibility", "text") VALUES ($1, $2, \'public\', $3)', [noteId, userId, 'e2e:generic-plan']],
			['UPDATE', 'UPDATE "note" SET "text" = $2 WHERE "id" = $1', [noteId, 'e2e:generic-plan:updated']],
			['DELETE', 'DELETE FROM "note" WHERE "id" = $1', [noteId]],
		],
		note_reaction: [
			['INSERT', 'INSERT INTO "note_reaction" ("id", "noteId", "userId", "reaction") VALUES ($1, $2, $3, $4)', [reactionId, reactedNoteId, userId, '👍']],
			['UPDATE', 'UPDATE "note_reaction" SET "reaction" = $3 WHERE "noteId" = $1 AND "id" = $2', [reactedNoteId, reactionId, '❤']],
			['DELETE', 'DELETE FROM "note_reaction" WHERE "noteId" = $1 AND "id" = $2', [reactedNoteId, reactionId]],
		],
	};
	const counts: Record<string, string[]> = {};
	for (const [table, statements] of Object.entries(steps)) {
		for (let iteration = 1; iteration <= genericPlanIterations; iteration++) {
			await client.query('BEGIN');
			try {
				for (const [step, sql, values] of statements) {
					await client.query(sql, values);
					const children = childrenByFamily((await lockedRelations(client)).map(lock => lock.child));
					(counts[`${table} ${step}`] ??= []).push(Object.entries(children).map(([family, list]) => `${family}:${list.length}`).join(' ') || '0');
					for (const [family, list] of Object.entries(children)) {
						if (list.length > 1) problems.push(`${step} on ${table} in iteration ${iteration} locked ${list.length} partitions of ${family}`);
					}
				}
			} finally {
				await client.query('ROLLBACK');
			}
		}
	}
	return { check: 'C14d generic plans', problems, summary: counts };
}

export function c14eCoverage(stats: StatementStat[], queryIds: Set<string>, texts: Set<string>, replays: Replay[]): CheckResult {
	const replayed = new Set(replays.flatMap(replay => replay.queryId != null ? [replay.queryId] : []));
	const shapes = new Set([...texts, ...replays.filter(replay => replay.kind === 'replayed').map(replay => coverageShape(replay.text))]);
	const touching = stats.filter(stat => copyReference.test(stat.query));
	const uncovered = touching.filter(stat => !((stat.toplevel && (queryIds.has(stat.queryId) || replayed.has(stat.queryId))) || shapes.has(coverageShape(stat.query))));
	return {
		check: 'C14e coverage',
		problems: [],
		summary: {
			statements: stats.length,
			touchingCopies: touching.length,
			uncovered: uncovered.length,
			uncoveredCalls: uncovered.reduce((sum, stat) => sum + stat.calls, 0),
			list: uncovered.toSorted((a, b) => b.calls - a.calls).slice(0, 40).map(stat => `${stat.calls}x ${stat.toplevel ? 'top' : 'nested'} ${normalizedText(stat.query).slice(0, 200)}`),
		},
	};
}

export function c14fConnections(captures: CaptureFile[]): CheckResult {
	const problems: string[] = [];
	const summary: Record<string, Record<string, number>> = {};
	for (const capture of captures) {
		for (const shape of capture.shapes) {
			const kind = connectionClasses.find(([, pattern]) => pattern.test(shape.shape))?.[0];
			if (kind == null) continue;
			for (const [timeout, count] of Object.entries(shape.statementTimeouts)) {
				(summary[kind] ??= {})[timeout] = (summary[kind][timeout] ?? 0) + count;
				if (timeout !== connectionTimeouts[kind]) problems.push(`${capture.name} sent ${count} statements on a connection with statement_timeout ${timeout}, expected ${connectionTimeouts[kind]} (${kind}): ${shape.shape.slice(0, 200)}`);
			}
		}
	}
	return { check: 'C14f connection class', problems, summary };
}

export type ProcessInfo = { name: string; alive: boolean; killedAt: number | null };

type ThreadEpisode = { process: string; root: string; start: number; end: number; linked: boolean; done: boolean; failed: boolean; searches: RecordedThreadEvent[] };

export type PendingLeftover = { childId: string; kind: number; reason: 'failed' | 'interrupted' | 'cap' | 'unexplained'; processes: string[] };

export type UnjoinedChild = { childId: string; parentId: string; process: string; reason: 'parentGone' | 'killed' | 'failed' | 'unexplained' };

type OldestJoin = { root: string; partitioned: boolean; linked: boolean; rounds: number; complete: number; partitions: number[]; paceMs: number[] };

type NoteKeys = { id: string; replyId: string | null; renoteId: string | null; threadId: string | null };

const markerPattern = /^e2e:(writer-[ab]-\d+):(\d+)(?:\.(\d+))?/;

const listed = (problems: string[], limit = 50) => problems.length > limit ? [...problems.slice(0, limit), `... and ${problems.length - limit} more`] : problems;

function distribution(values: number[]): Record<string, number> | null {
	if (values.length === 0) return null;
	const sorted = values.toSorted((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
	return { count: sorted.length, mean: Math.round(sorted.reduce((a, b) => a + b, 0) / sorted.length * 100) / 100, p50: at(0.5), p95: at(0.95), max: sorted[sorted.length - 1] };
}

async function notesById(client: pg.Client, ids: string[]): Promise<Map<string, NoteKeys>> {
	const notes = await inspectCopies(client, 'note');
	const found = new Map<string, NoteKeys>();
	for (const [prefix, group] of Map.groupBy([...new Set(ids)], id => prefixOf(id))) {
		const { source, where } = liveSource(notes, prefix, 'n');
		for (const part of chunk(group, 1000)) {
			for (const row of await budgeted<NoteKeys>(client, 'data', `SELECT n."id", n."replyId", n."renoteId", n."threadId" FROM ${source} n WHERE ${where} AND n."id" = ANY($3)`, [prefix, nextPrefix(prefix), part])) found.set(row.id, row);
		}
	}
	return found;
}

function threadEpisodes(events: RecordedThreadEvent[]): ThreadEpisode[] {
	const open = new Map<string, ThreadEpisode>();
	const episodes: ThreadEpisode[] = [];
	for (const event of events) {
		if (event.kind === 'lookup') continue;
		for (const root of event.ids) {
			const key = `${event.process} ${root}`;
			let episode = open.get(key);
			if (episode == null) {
				episode = { process: event.process, root, start: event.start, end: event.end, linked: false, done: false, failed: false, searches: [] };
				open.set(key, episode);
				episodes.push(episode);
			}
			episode.end = Math.max(episode.end, event.end);
			episode.failed = event.failed;
			if (event.kind === 'link' || event.kind === 'linkFormer') episode.linked = true;
			if (event.kind === 'search') episode.searches.push(event);
			if (event.kind === 'done' && !event.failed) {
				episode.done = true;
				open.delete(key);
			}
		}
	}
	return episodes;
}

type SearchRound = { first: number; last: number; searches: RecordedThreadEvent[] };

function searchRounds(searches: RecordedThreadEvent[]): SearchRound[] {
	const rounds: (SearchRound & { tail: RecordedThreadEvent })[] = [];
	for (const search of searches) {
		if (search.prefix == null) continue;
		const ord = prefixToOrdinal(search.prefix);
		const rank = (other: { tail: RecordedThreadEvent }) => (other.tail.pid === search.pid ? Infinity : other.tail.end);
		const round = rounds.filter(other => other.last === ord - 1 && other.tail.end <= search.start)
			.reduce<(SearchRound & { tail: RecordedThreadEvent }) | null>((best, other) => (best == null || rank(other) > rank(best) ? other : best), null);
		if (round != null) {
			round.searches.push(search);
			round.last = ord;
			round.tail = search;
		} else {
			rounds.push({ first: ord, last: ord, searches: [search], tail: search });
		}
	}
	return rounds.map(({ first, last, searches: members }) => ({ first, last, searches: members }));
}

async function pendingRowStates(client: pg.Client): Promise<{ childId: string; kind: number; linked: boolean; live: boolean; replyId: string | null; renoteId: string | null }[]> {
	const rows = await budgeted<{ childId: string; kind: number }>(client, 'data', 'SELECT "childId", "kind" FROM "note_pending_parent"');
	const children = await notesById(client, rows.map(row => row.childId));
	return rows.map(row => {
		const child = children.get(row.childId);
		const parentId = row.kind === 0 ? child?.replyId : child?.renoteId;
		return { childId: row.childId, kind: row.kind, live: child != null, linked: parentId != null && parentId !== unreferenceableNoteId, replyId: child?.replyId ?? null, renoteId: child?.renoteId ?? null };
	});
}

function failedAfter(pgLog: PgLogEntry[], process: string, from: number, to: number): boolean {
	return pgLog.some(entry => entry.severity === 'ERROR' && entry.app === `mk-e2e-${process}` && entry.t >= from && entry.t <= to && threadStatementShape.test(normalizedText(entry.statement ?? '')));
}

function leftoverReason(root: string, events: RecordedThreadEvent[], processes: ProcessInfo[], pgLog: PgLogEntry[]): PendingLeftover['reason'] {
	const own = events.filter(event => event.kind !== 'lookup' && event.ids.includes(root));
	const last = own.reduce<RecordedThreadEvent | null>((latest, event) => (latest == null || event.end >= latest.end ? event : latest), null);
	if (last == null) return 'unexplained';
	const killedAt = processes.find(other => other.name === last.process)?.killedAt;
	if (killedAt != null && killedAt >= last.start) return 'interrupted';
	if (last.failed || failedAfter(pgLog, last.process, last.start, last.end + statementFailureWindowMs)) return 'failed';
	const calls = own.filter(event => event.process === last.process);
	const call = calls.slice(calls.findLastIndex(event => event.kind === 'link' || event.kind === 'linkFormer' || event.kind === 'done') + 1);
	return searchRounds(call.filter(event => event.kind === 'search')).length >= rekeyRoundCap ? 'cap' : 'unexplained';
}

export async function pendingLeftovers(client: pg.Client, events: RecordedThreadEvent[], processes: ProcessInfo[], pgLog: PgLogEntry[]): Promise<PendingLeftover[]> {
	return (await pendingRowStates(client)).filter(row => row.linked).map(row => ({
		childId: row.childId,
		kind: row.kind,
		reason: leftoverReason(row.childId, events, processes, pgLog),
		processes: [...new Set(events.filter(event => event.kind !== 'lookup' && event.ids.includes(row.childId)).map(event => event.process))],
	}));
}

export async function unjoinedChildren(client: pg.Client, oplogs: OplogEntry[], events: RecordedThreadEvent[], processes: ProcessInfo[], pgLog: PgLogEntry[]): Promise<UnjoinedChild[]> {
	const arrivals = oplogs.filter(entry => entry.op === 'pendingParent' && typeof entry.result === 'string' && /^[0-9a-z]{10}$/.test(entry.result) && typeof entry.args.childId === 'string');
	if (arrivals.length === 0) return [];
	const notes = await notesById(client, arrivals.flatMap(entry => [entry.args.childId as string, entry.result as string]));
	const waiting = new Set((await pendingRowStates(client)).filter(row => row.kind === 0).map(row => row.childId));
	return arrivals.flatMap(entry => {
		const childId = entry.args.childId as string;
		const parentId = entry.result as string;
		const child = notes.get(childId);
		if (child == null || child.replyId === parentId || (childId <= parentId && !waiting.has(childId))) return [];
		const process = entry.file.replace(/\.jsonl$/, '');
		const killedAt = processes.find(other => other.name === process)?.killedAt;
		const failed = events.some(event => event.process === process && event.failed && event.start >= entry.t && event.ids.includes(childId)) || failedAfter(pgLog, process, entry.t, entry.t + entry.latencyMs + statementFailureWindowMs);
		const reason = !notes.has(parentId) ? 'parentGone' : killedAt != null && killedAt >= entry.t ? 'killed' : failed ? 'failed' : 'unexplained';
		return [{ childId, parentId, process, reason }];
	});
}

export async function c17ThreadKeys(client: pg.Client): Promise<CheckResult> {
	const notes = await inspectCopies(client, 'note');
	const problems: string[] = [];
	const replies: { id: string; replyId: string; threadId: string | null }[] = [];
	let unreferenceable = 0;
	for (const [prefix, upper] of allPrefixes()) {
		const { source, where } = liveSource(notes, prefix, 'n');
		for (const row of await budgeted<{ id: string; replyId: string | null; threadId: string | null }>(client, 'data', `SELECT n."id", n."replyId", n."threadId" FROM ${source} n WHERE ${where} AND (n."replyId" IS NOT NULL OR n."threadId" IS NOT NULL)`, [prefix, upper])) {
			if (row.replyId == null) {
				problems.push(`${row.id} has the thread key ${row.threadId} without a reply target`);
			} else if (row.replyId === unreferenceableNoteId) {
				unreferenceable++;
				if (row.threadId != null) problems.push(`${row.id} replies to ${unreferenceableNoteId} but has the thread key ${row.threadId}`);
			} else {
				replies.push({ id: row.id, replyId: row.replyId, threadId: row.threadId });
			}
		}
	}
	const targets = await notesById(client, replies.map(reply => reply.replyId));
	const gone = new Map<string, Set<string | null>>();
	let live = 0;
	for (const reply of replies) {
		const target = targets.get(reply.replyId);
		if (target == null) {
			gone.set(reply.replyId, (gone.get(reply.replyId) ?? new Set()).add(reply.threadId));
			continue;
		}
		live++;
		const expected = target.threadId ?? target.id;
		if (reply.threadId !== expected) problems.push(`${reply.id} replies to ${reply.replyId} (thread key ${target.threadId}) but has the thread key ${reply.threadId}, expected ${expected}`);
	}
	for (const [replyId, keys] of gone) {
		if (keys.size > 1 || keys.has(null)) problems.push(`the live replies to the gone ${replyId} have the thread keys ${[...keys].join(', ')}`);
	}
	return { check: 'C17 thread keys', problems: listed(problems), summary: { repliesToLiveTargets: live, goneTargets: gone.size, repliesToGoneTargets: replies.length - live, unreferenceable } };
}

export async function c18PendingRows(client: pg.Client, leftovers: PendingLeftover[], unjoined: UnjoinedChild[]): Promise<CheckResult> {
	const rows = await pendingRowStates(client);
	const linked = rows.filter(row => row.linked);
	const unlinked = new Set(rows.filter(row => !row.linked).map(row => row.childId));
	const resolvable = (await budgeted<{ childId: string; kind: number; parentId: string }>(client, 'data', `
		SELECT p."childId" AS "childId", p."kind" AS "kind", u."noteId" AS "parentId"
		FROM "note_pending_parent" p
		JOIN "note_uri" u ON u."uri" IN (p."parentUri", regexp_replace(p."parentUri", '^(https?://)', '\\1www.'))
	`)).filter(row => unlinked.has(row.childId));
	const problems = [
		...linked.map(row => `the pending row (kind ${row.kind}) of ${row.childId} remains after the daily clean although the child is linked (replyId ${row.replyId}, renoteId ${row.renoteId})`),
		...resolvable.map(row => `the pending row (kind ${row.kind}) of the unlinked ${row.childId} remains after the daily clean although its parent ${row.parentId} is found by its uri`),
		...leftovers.filter(row => row.reason === 'unexplained').map(row => `the pending row (kind ${row.kind}) of the linked ${row.childId} remained at the quiescence point without a failed, interrupted or capped re-key (episodes in ${row.processes.join(', ') || 'no process'})`),
		...unjoined.filter(row => row.reason === 'unexplained').map(row => `${row.process} created the parent ${row.parentId} of the waiting ${row.childId}, but the child was not joined to it by the quiescence point although the writer lived and no statement of the join failed`),
	];
	const reasons = Object.fromEntries([...Map.groupBy(leftovers, row => row.reason)].map(([reason, group]) => [reason, group.length]));
	const unjoinedReasons = Object.fromEntries([...Map.groupBy(unjoined, row => row.reason)].map(([reason, group]) => [reason, group.length]));
	return { check: 'C18 pending rows', problems: listed(problems), summary: { rows: rows.length, waitingReplies: rows.filter(row => row.kind === 0 && !row.linked).length, waitingRenotes: rows.filter(row => row.kind !== 0 && !row.linked).length, linkedBeforeClean: reasons, unjoinedBeforeClean: unjoinedReasons, linkedAfterClean: linked.length, resolvableAfterClean: resolvable.length } };
}

export async function c19ThreadMutes(client: pg.Client, oplogs: OplogEntry[]): Promise<CheckResult> {
	const problems: string[] = [];
	const parents = new Map<string, string>();
	const children: string[] = [];
	for (const entry of oplogs) {
		if (entry.op === 'pendingReply' && typeof entry.result === 'string') children.push(entry.result);
		if (entry.op === 'pendingParent' && typeof entry.result === 'string' && typeof entry.args.childId === 'string') parents.set(entry.args.childId, entry.result);
	}
	const actions = oplogs.filter(entry => ['waitingMute', 'waitingUnmute', 'joinUnmute'].includes(entry.op) && (entry.result === 'muted' || entry.result === 'unmuted') && typeof entry.args.childId === 'string' && typeof entry.args.userId === 'string');
	const replies = oplogs.filter(entry => ['waitingReply', 'joinReply'].includes(entry.op) && typeof entry.result === 'string' && /^[0-9a-z]{10}$/.test(entry.result));
	const rows = await notesById(client, [...children, ...replies.map(entry => entry.result as string)]);
	const linked = children.filter(id => parents.has(id) && rows.get(id)?.replyId === parents.get(id));
	const keyedOnLinked = linked.length === 0 ? [] : await budgeted<{ userId: string; threadId: string }>(client, 'data', 'SELECT "userId", "threadId" FROM "note_thread_muting" WHERE "threadId" = ANY($1)', [linked]);
	problems.push(...keyedOnLinked.map(row => `${row.userId} mutes the thread ${row.threadId}, the id of a linked child`));
	const userIds = [...new Set(actions.map(entry => entry.args.userId as string))];
	const mutings = new Set((userIds.length === 0 ? [] : await budgeted<{ userId: string; threadId: string }>(client, 'data', 'SELECT "userId", "threadId" FROM "note_thread_muting" WHERE "userId" = ANY($1)', [userIds])).map(row => `${row.userId} ${row.threadId}`));
	const counts = { muted: 0, unmuted: 0, linked: 0, waiting: 0, gone: 0, unverifiable: 0 };
	for (const group of Map.groupBy(actions, entry => `${entry.args.childId as string} ${entry.args.userId as string}`).values()) {
		const last = group.reduce((a, b) => (b.t + b.latencyMs >= a.t + a.latencyMs ? b : a));
		const childId = last.args.childId as string;
		const userId = last.args.userId as string;
		const child = rows.get(childId);
		const key = child != null ? child.threadId ?? child.id : replies.filter(entry => entry.args.childId === childId && entry.args.targetId === childId).map(entry => rows.get(entry.result as string)?.threadId).find(threadId => threadId != null);
		if (key == null) {
			counts.unverifiable++;
			continue;
		}
		counts[child == null ? 'gone' : linked.includes(childId) ? 'linked' : 'waiting']++;
		if (last.result === 'muted') {
			counts.muted++;
			if (!mutings.has(`${userId} ${key}`)) problems.push(`${userId} muted the thread of ${childId} (${last.op} via ${String(last.args.via)}) but does not mute its key ${key}`);
		} else {
			counts.unmuted++;
			for (const threadId of new Set([key, childId])) {
				if (mutings.has(`${userId} ${threadId}`)) problems.push(`${userId} unmuted the thread of ${childId} (${last.op} via ${String(last.args.via)}) but mutes ${threadId} again`);
			}
		}
	}
	return { check: 'C19 thread mutes', problems: listed(problems), summary: { linkedChildren: linked.length, mutesKeyedOnLinked: keyedOnLinked.length, ...counts } };
}

export async function c20RelationCopies(client: pg.Client): Promise<CheckResult> {
	const notes = await inspectCopies(client, 'note');
	const problems: string[] = [];
	let edges = 0;
	for (const [prefix, upper] of allPrefixes()) {
		const { source, where } = liveSource(notes, prefix, 'n');
		const differs = 'r."parentReplyUserId" IS DISTINCT FROM n."replyUserId" OR r."parentReplyUserHost" IS DISTINCT FROM n."replyUserHost" OR r."parentRenoteUserId" IS DISTINCT FROM n."renoteUserId" OR r."parentRenoteUserHost" IS DISTINCT FROM n."renoteUserHost"';
		const [row] = await budgeted<{ edges: number; mismatches: number; samples: string[] | null }>(client, 'data', `
			SELECT count(*)::int AS "edges", (count(*) FILTER (WHERE ${differs}))::int AS "mismatches", (array_agg(r."childId" || ' -> ' || r."parentId") FILTER (WHERE ${differs}))[1:20] AS "samples"
			FROM "note_relation" r JOIN ${source} n ON n."id" = r."parentId"
			WHERE r."kind" IN (1, 2) AND ${between('parentId', 'r.')} AND ${where}
		`, [prefix, upper]);
		edges += row.edges;
		if (row.mismatches > 0) problems.push(`${row.mismatches} renote edges to notes of ${prefix} copy other author columns than their parents have: ${(row.samples ?? []).join(', ')}`);
	}
	return { check: 'C20 relation copies', problems, summary: { edges } };
}

export async function c21RepliesCount(client: pg.Client, oplogs: OplogEntry[], processes: ProcessInfo[]): Promise<CheckResult> {
	const notes = await inspectCopies(client, 'note');
	const problems: string[] = [];
	const counts = new Map<string, number>();
	const children = new Map<string, { id: string; text: string | null }[]>();
	for (const [prefix, upper] of allPrefixes()) {
		const { source, where } = liveSource(notes, prefix, 'n');
		for (const row of await budgeted<{ id: string; repliesCount: number }>(client, 'data', `SELECT n."id", n."repliesCount" FROM ${source} n WHERE ${where} AND n."repliesCount" <> 0`, [prefix, upper])) counts.set(row.id, row.repliesCount);
		for (const row of await budgeted<{ id: string; replyId: string; text: string | null }>(client, 'data', `SELECT n."id", n."replyId", left(n."text", 40) AS "text" FROM ${source} n WHERE ${where} AND n."replyId" IS NOT NULL AND n."replyId" <> '${unreferenceableNoteId}'`, [prefix, upper])) {
			children.set(row.replyId, [...(children.get(row.replyId) ?? []), { id: row.id, text: row.text }]);
		}
	}
	for (const id of (await notesById(client, [...children.keys()].filter(other => !counts.has(other)))).keys()) counts.set(id, 0);
	const mismatched = [...counts].map(([id, claimed]) => ({ id, claimed, actual: children.get(id)?.length ?? 0 })).filter(row => row.claimed !== row.actual);
	const killed = new Map(processes.flatMap(other => (other.killedAt != null ? [[other.name, other.killedAt] as const] : [])));
	const logged = new Map(oplogs.map(entry => [`${entry.file.replace(/\.jsonl$/, '')} ${entry.seq} ${entry.sub ?? ''}`, entry]));
	const lostIncrement = (text: string | null) => {
		const match = markerPattern.exec(text ?? '');
		const killedAt = match != null ? killed.get(match[1]) : undefined;
		if (match == null || killedAt == null) return false;
		const entry = logged.get(`${match[1]} ${match[2]} ${match.at(3) ?? ''}`);
		return entry == null || entry.t + entry.latencyMs >= killedAt - killSuspectMs;
	};
	const deleted = new Set(oplogs.filter(entry => entry.op === 'noteDelete' && succeeded(entry, 'deleted')).map(entry => entry.args.noteId));
	const edges = mismatched.length === 0 ? [] : await budgeted<{ childId: string; parentId: string }>(client, 'data', 'SELECT "childId", "parentId" FROM "note_relation" WHERE "parentId" = ANY($1) AND "kind" = 0', [mismatched.map(row => row.id)]);
	const liveChildren = new Set(mismatched.flatMap(row => (children.get(row.id) ?? []).map(child => child.id)));
	const gone = edges.filter(edge => !liveChildren.has(edge.childId)).map(edge => edge.childId);
	const recorded = new Set(gone.length === 0 ? [] : (await budgeted<{ id: string }>(client, 'data', 'SELECT "id" FROM "deleted_note" WHERE "id" = ANY($1)', [gone])).map(row => row.id));
	const explained: string[] = [];
	for (const row of mismatched) {
		const missedIncrements = (children.get(row.id) ?? []).filter(child => lostIncrement(child.text)).length;
		const missedDecrements = edges.filter(edge => edge.parentId === row.id && !liveChildren.has(edge.childId) && recorded.has(edge.childId) && !deleted.has(edge.childId)).length;
		const difference = row.actual - row.claimed;
		if (difference <= missedIncrements && difference >= -missedDecrements) explained.push(`${row.id} ${row.claimed}/${row.actual}`);
		else problems.push(`${row.id} has repliesCount ${row.claimed} but ${row.actual} live replies (${missedIncrements} replies whose increment a writer kill may have lost, ${missedDecrements} deletions a writer kill may have cut short)`);
	}
	return { check: 'C21 repliesCount', problems: listed(problems), summary: { notes: counts.size, mismatched: mismatched.length, explainedByWriterKills: explained } };
}

export async function c22UnlinkMutes(client: pg.Client, model: SeedModel): Promise<CheckResult> {
	const problems: string[] = [];
	const keys = [...new Set(model.unlinkMutes.flatMap(mute => [mute.noteId, mute.threadId]))];
	const mutings = new Set((keys.length === 0 ? [] : await budgeted<{ userId: string; threadId: string }>(client, 'data', 'SELECT "userId", "threadId" FROM "note_thread_muting" WHERE "threadId" = ANY($1)', [keys])).map(row => `${row.userId} ${row.threadId}`));
	let mutes = 0;
	for (const mute of model.unlinkMutes) {
		for (const userId of mute.userIds) {
			mutes++;
			if (!mutings.has(`${userId} ${mute.noteId}`)) problems.push(`${userId} muted ${mute.threadId}, the thread key the unlinked reply ${mute.noteId} had, but does not mute ${mute.noteId}`);
			if (!mutings.has(`${userId} ${mute.threadId}`)) problems.push(`${userId} no longer mutes ${mute.threadId}, the thread key the unlinked reply ${mute.noteId} had`);
		}
	}
	return { check: 'C22 unlink mutes', problems, summary: { replies: model.unlinkMutes.length, mutes } };
}

export function oldestJoins(events: RecordedThreadEvent[], oplogs: OplogEntry[]): OldestJoin[] {
	const byRoot = Map.groupBy(threadEpisodes(events), episode => episode.root);
	return oplogs.filter(entry => entry.op === 'pendingParent' && entry.args.oldest === true && typeof entry.result === 'string' && typeof entry.args.childId === 'string').map(entry => {
		const root = entry.args.childId as string;
		const own = byRoot.get(root) ?? [];
		const rounds = searchRounds(own.flatMap(episode => episode.searches).sort((a, b) => a.start - b.start));
		const complete = rounds.filter(round => round.first === prefixToOrdinal(prefixOf(root)) && round.last >= prefixToOrdinal(prefixOf(aid(round.searches[0].start + rekeyHorizonMs, 0))));
		return { root, partitioned: entry.args.partitioned === true, linked: own.some(episode => episode.linked), rounds: rounds.length, complete: complete.length, partitions: complete.map(round => round.searches.length), paceMs: complete.map(round => Math.round((round.searches[round.searches.length - 1].end - round.searches[0].start) / round.searches.length * 1000) / 1000) };
	});
}

export function c23JoinWindows(events: RecordedThreadEvent[], oplogs: OplogEntry[], live: 'partitioned' | 'plain', required: number): CheckResult {
	const problems: string[] = [];
	const byRoot = Map.groupBy(threadEpisodes(events), episode => episode.root);
	const kinds: Partial<Record<string, string>> = { waitingReply: 'waiting reply', joinReply: 'join reply', waitingUnmute: 'waiting unmute', joinUnmute: 'join unmute', noteDelete: 'join delete' };
	const overlaps: Record<string, { ops: number; overlapped: number }> = {};
	for (const entry of oplogs) {
		const kind = kinds[entry.op];
		if (kind == null || typeof entry.args.childId !== 'string' || (entry.op === 'noteDelete' && entry.args.thread !== true)) continue;
		const counts = overlaps[kind] ??= { ops: 0, overlapped: 0 };
		counts.ops++;
		const end = entry.t + entry.latencyMs;
		if ((byRoot.get(entry.args.childId) ?? []).some(episode => entry.t <= episode.end && end >= episode.start)) counts.overlapped++;
	}
	const joins = oldestJoins(events, oplogs);
	const searchMs = joins.flatMap(join => (byRoot.get(join.root) ?? []).flatMap(episode => episode.searches.map(search => search.end - search.start)));
	for (const join of joins.filter(other => other.linked && other.complete === 0)) problems.push(`the oldest-partition child ${join.root} was linked but no search covered every partition from ${prefixOf(join.root)} to now (${join.rounds} rounds)`);
	const searched = joins.filter(join => join.partitioned && join.complete > 0).length;
	if (live === 'partitioned' && searched < required) problems.push(`${searched} oldest-partition children were joined with the partitioned copy live and searched every partition, ${required} required`);
	return { check: 'C23 join windows', problems, summary: { overlaps, oldest: joins, searchMs: distribution(searchMs), paceMs: distribution(joins.flatMap(join => join.paceMs)) } };
}
