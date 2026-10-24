/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { lockedRelations } from './budget.js';
import { copyReference } from './expected.js';
import type { Run } from './env.js';
import type pg from 'pg';

export type CapturedStatement = { t: number; tag: string | null; text: string; values: unknown[]; processId: number | null; statementTimeout: number | null };

export type CapturedShape = { shape: string; count: number; statementTimeouts: Record<string, number>; samples: CapturedStatement[]; widest: CapturedStatement | null };

export type CaptureFile = { name: string; startedAt: number; flushedAt: number; shapes: CapturedShape[]; statements: CapturedStatement[] | null };

type Allowance = { allowance: number; bound: boolean };

export type Replay = {
	text: string;
	values: unknown[];
	sources: string[];
	kind: 'replayed' | 'utility' | 'unrelated';
	queryId: string | null;
	children: Record<string, string[]>;
	indexes: Record<string, string[]>;
	relationLocks: number;
	spilled: number;
	allowance: number;
	bound: boolean;
	subplansRemoved: number;
	error: string | null;
};

const childPattern = /^(note|note_reaction)_p_[0-9a-z]{2}$/;

const replayable = /^[\s(]*(select|insert|update|delete|with|values|table)\b/i;

const raw = { getTypeParser: () => (value: string) => value };

const fastPathModes = ['AccessShareLock', 'RowShareLock', 'RowExclusiveLock'];

export function statementShape(text: string): string {
	return text.replace(/\s+/g, ' ').trim()
		.replace(/\b(note_reaction_p|note_p)_[0-9a-z]{2}\b/g, '$1_??')
		.replace(/\b(\w+_(?:mig|old))_[0-9a-z]{2}\b/g, '$1_??')
		.replace(/\('[0-9a-z]{2}'\)/g, '(\'??\')')
		.replace(/\$\d+(?:, \$\d+)+/g, '$*');
}

export function normalizedText(sql: string): string {
	return sql.replace(/\s+/g, ' ').trim();
}

export function coverageShape(text: string): string {
	return text.replace(/\s*\/\*.*?\*\//gs, '').replace(/'(?:[^']|'')*'/g, '?').replace(/\$\d+/g, '?').replace(/\b\d+(\.\d+)?\b/g, '?').replace(/\s+/g, ' ')
		.replace(/(?<!\b(?:is (?:not )?|distinct from ))\b(?:true|false|null)\b/gi, '?').replace(/\?(\s*,\s*\?)+/g, '?').trim();
}

function familyOf(relation: string): string | null {
	return childPattern.exec(relation)?.[1] ?? null;
}

function strings(value: unknown): string[] {
	if (typeof value === 'string') return [value];
	if (Array.isArray(value)) return value.flatMap(strings);
	return [];
}

export function allowanceOf(values: unknown[]): Allowance {
	const texts = values.flatMap(strings);
	const prefixes = new Set(texts.filter(text => /^[0-9a-z]{10}$/.test(text)).map(text => text.slice(0, 2)));
	const bound = texts.some(text => /^[0-9a-z]{2}$/.test(text));
	return { allowance: bound ? 1 : Math.max(1, prefixes.size), bound };
}

export function allowanceOfParameters(parameters: string | null): Allowance {
	const values = [...(parameters ?? '').matchAll(/\$\d+ = (?:'((?:[^']|'')*)'|NULL)/g)].map(match => match.at(1)?.replace(/''/g, '\'') ?? null).filter((value): value is string => value != null);
	const tokens = values.flatMap(value => /^[0-9a-z]{2}$/.test(value) ? [value] : [...value.matchAll(/(?<![0-9a-z])[0-9a-z]{10}(?![0-9a-z])/g)].map(match => match[0]));
	return allowanceOf(tokens);
}

export function planFacts(node: unknown, facts: { relations: Set<string>; subplansRemoved: number } = { relations: new Set(), subplansRemoved: 0 }): { relations: Set<string>; subplansRemoved: number } {
	if (Array.isArray(node)) {
		for (const item of node) planFacts(item, facts);
	} else if (node != null && typeof node === 'object') {
		for (const [key, value] of Object.entries(node)) {
			if (key === 'Relation Name' && typeof value === 'string') facts.relations.add(value);
			else if (key === 'Subplans Removed' && typeof value === 'number') facts.subplansRemoved += value;
			else planFacts(value, facts);
		}
	}
	return facts;
}

export function childrenByFamily(relations: Iterable<string>): Record<string, string[]> {
	const children: Record<string, string[]> = {};
	for (const relation of relations) {
		const family = familyOf(relation);
		if (family != null && !(children[family] ?? []).includes(relation)) (children[family] ??= []).push(relation);
	}
	for (const list of Object.values(children)) list.sort();
	return children;
}

type ThreadEventKind = 'link' | 'linkFormer' | 'search' | 'rekey' | 'done' | 'lookup';

type ThreadEvent = { kind: ThreadEventKind; ids: string[]; parent: string | null; prefix: string | null };

export type RecordedThreadEvent = ThreadEvent & { process: string; pid: number | null; start: number; end: number; rows: number | null; failed: boolean };

const threadStatements: [ThreadEventKind, RegExp, (values: unknown[]) => { ids: unknown[]; parent: unknown }][] = [
	['link', /^UPDATE "note" SET "replyId" = CASE WHEN "id" > \$1 THEN \$1 ELSE "replyId" END, "threadId" = CASE /, values => ({ ids: values.slice(5), parent: values[0] })],
	['linkFormer', /^UPDATE "note" SET "replyId" = \$1, "threadId" = \$3 WHERE "id" IN /, values => ({ ids: values.slice(3), parent: values[0] })],
	['search', /^SELECT "id", "threadId" FROM "note" WHERE "threadId" = ANY\(\$1\) AND "id" >= '[0-9a-z]{2}'/, values => ({ ids: [values[0]], parent: null })],
	['rekey', /^UPDATE "note" SET "threadId" = \$1 WHERE "id" IN \([^)]*\) AND "threadId" = \$2$/, values => ({ ids: [values[1]], parent: null })],
	['done', /^DELETE FROM "note_pending_parent" WHERE "childId" = ANY\(\$1\) AND "kind" = 0$/, values => ({ ids: [values[0]], parent: null })],
	['lookup', /^SELECT "childId" FROM "note_pending_parent" WHERE "childId" = ANY\(\$1\) AND "kind" = 0$/, values => ({ ids: [values[0]], parent: null })],
];

export function threadEventOf(text: string, values: unknown[]): ThreadEvent | null {
	const normalized = normalizedText(text);
	for (const [kind, pattern, read] of threadStatements) {
		if (!pattern.test(normalized)) continue;
		const { ids, parent } = read(values);
		return { kind, ids: ids.flatMap(strings), parent: typeof parent === 'string' ? parent : null, prefix: /"id" >= '([0-9a-z]{2})'/.exec(normalized)?.[1] ?? null };
	}
	return null;
}

export function readThreadEvents(run: Run, from: number, to: number): RecordedThreadEvent[] {
	const dir = run.path('threads');
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(file => file.endsWith('.jsonl')).flatMap(file => readFileSync(join(dir, file), 'utf-8').split('\n').filter(line => line !== '').map(line => ({ process: file.slice(0, -'.jsonl'.length), ...JSON.parse(line) as Omit<RecordedThreadEvent, 'process'> })))
		.filter(event => event.start >= from && event.start <= to)
		.sort((a, b) => a.start - b.start);
}

export function readCaptures(run: Run, prefix: string, from: number, to: number): CaptureFile[] {
	const dir = run.path('capture');
	if (!existsSync(dir)) return [];
	return readdirSync(dir).filter(file => file.startsWith(prefix) && file.endsWith('.json'))
		.map(file => JSON.parse(readFileSync(join(dir, file), 'utf-8')) as CaptureFile)
		.filter(capture => capture.startedAt >= from && capture.startedAt <= to);
}

export async function replay(client: pg.Client, statements: { text: string; values: unknown[]; source: string }[]): Promise<Replay[]> {
	const replays = new Map<string, Replay>();
	for (const statement of statements) {
		const key = JSON.stringify([statement.text, statement.values]);
		const known = replays.get(key);
		if (known != null) {
			if (!known.sources.includes(statement.source)) known.sources.push(statement.source);
			continue;
		}
		const { allowance, bound } = allowanceOf(statement.values);
		const kind = !replayable.test(statement.text) ? 'utility' : copyReference.test(statement.text.replace(/'(?:[^']|'')*'/g, '\'\'')) ? 'replayed' : 'unrelated';
		const result: Replay = { text: statement.text, values: statement.values, sources: [statement.source], kind, queryId: null, children: {}, indexes: {}, relationLocks: 0, spilled: 0, allowance, bound, subplansRemoved: 0, error: null };
		replays.set(key, result);
		if (kind !== 'replayed') continue;
		await client.query('BEGIN');
		try {
			const { rows } = await client.query<{ 'QUERY PLAN': string }>({ text: `EXPLAIN (VERBOSE, COSTS OFF, FORMAT JSON) ${statement.text}`, values: statement.values, types: raw });
			const plan = rows[0]['QUERY PLAN'];
			result.queryId = /"Query Identifier": (-?\d+)/.exec(plan)?.[1] ?? null;
			result.subplansRemoved = planFacts(JSON.parse(plan)).subplansRemoved;
			const locks = await lockedRelations(client);
			result.relationLocks = locks.length;
			result.spilled = locks.filter(lock => !lock.fastPath && fastPathModes.includes(lock.mode)).length;
			result.children = childrenByFamily(locks.map(lock => lock.child));
			for (const lock of locks) {
				if (lock.kind === 'i' && familyOf(lock.child) != null) (result.indexes[lock.child] ??= []).push(lock.name);
			}
		} catch (e) {
			result.error = String(e);
		} finally {
			await client.query('ROLLBACK');
		}
	}
	return [...replays.values()];
}
