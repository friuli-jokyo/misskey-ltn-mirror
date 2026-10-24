/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { allowanceOfParameters, childrenByFamily, planFacts } from './explain.js';
import type { Run } from './env.js';

export type PgLogEntry = {
	t: number;
	severity: string;
	sqlState: string | null;
	message: string;
	detail: string | null;
	context: string | null;
	statement: string | null;
	app: string | null;
	backendType: string | null;
	pid: number;
};

type PlanEntry = {
	t: number;
	app: string | null;
	pid: number;
	queryId: string | null;
	text: string;
	parameters: string | null;
	children: Record<string, string[]>;
	allowance: number;
	bound: boolean;
	subplansRemoved: number;
};

type JsonLogLine = {
	timestamp: string;
	error_severity: string;
	state_code?: string;
	message?: string;
	detail?: string;
	context?: string;
	statement?: string;
	application_name?: string;
	backend_type?: string;
	pid: number;
};

const interesting = /"error_severity":"(ERROR|FATAL|PANIC)"|still waiting for/;

const timestampOf = (timestamp: string) => Date.parse(timestamp.replace(' ', 'T').replace(/ UTC$/, 'Z'));

async function* logLines(run: Run, from: number, to: number, filter: RegExp): AsyncGenerator<[number, string]> {
	const dir = run.path('pg', 'log');
	if (!existsSync(dir)) return;
	for (const file of readdirSync(dir).filter(name => name.endsWith('.json')).sort()) {
		for await (const line of createInterface({ input: createReadStream(join(dir, file), 'utf-8'), crlfDelay: Infinity })) {
			if (!filter.test(line)) continue;
			const timestamp = /^\{"timestamp":"([^"]+)"/.exec(line)?.[1];
			const t = timestamp != null ? timestampOf(timestamp) : NaN;
			if (t < from || t > to) continue;
			yield [t, line];
		}
	}
}

export async function readPgLog(run: Run, from: number, to: number): Promise<PgLogEntry[]> {
	const entries: PgLogEntry[] = [];
	for await (const [t, line] of logLines(run, from, to, interesting)) {
		const row = JSON.parse(line) as JsonLogLine;
		entries.push({
			t,
			severity: row.error_severity,
			sqlState: row.state_code ?? null,
			message: row.message ?? '',
			detail: row.detail ?? null,
			context: row.context ?? null,
			statement: row.statement ?? null,
			app: row.application_name ?? null,
			backendType: row.backend_type ?? null,
			pid: row.pid,
		});
	}
	return entries;
}

export async function readPlans(run: Run, from: number, to: number, onPlan: (plan: PlanEntry) => void): Promise<number> {
	let count = 0;
	for await (const [t, line] of logLines(run, from, to, /"message":"duration: [^"]*plan:/)) {
		const row = JSON.parse(line) as JsonLogLine;
		const message = row.message ?? '';
		const explained = JSON.parse(message.slice(message.indexOf('plan:') + 5)) as { 'Query Text'?: string; 'Query Parameters'?: string; Plan?: unknown };
		const facts = planFacts(explained.Plan);
		const parameters = explained['Query Parameters'] ?? null;
		onPlan({
			t,
			app: row.application_name ?? null,
			pid: row.pid,
			queryId: /"query_id":(-?\d+)/.exec(line)?.[1] ?? null,
			text: explained['Query Text'] ?? '',
			parameters,
			children: childrenByFamily(facts.relations),
			...allowanceOfParameters(parameters),
			subplansRemoved: facts.subplansRemoved,
		});
		count++;
	}
	return count;
}

export function lockHolders(entry: PgLogEntry): number[] {
	const match = /Process(?:es)? holding the lock: ([\d, ]+)\./.exec(entry.detail ?? '');
	return match == null ? [] : match[1].split(',').map(pid => Number(pid.trim()));
}
