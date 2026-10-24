/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type pg from 'pg';

type LockedRelation = { name: string; kind: string; child: string; partitionOf: string | null; mode: string; fastPath: boolean };

const locksSql = `
	SELECT c.relname AS "name", c.relkind AS "kind", coalesce(x.indrelid::regclass::text, c.relname) AS "child", coalesce(pt.relname, pi.relname) AS "partitionOf", l.mode AS "mode", l.fastpath AS "fastPath"
	FROM pg_locks l
	JOIN pg_class c ON c.oid = l.relation
	LEFT JOIN pg_inherits it ON it.inhrelid = c.oid AND c.relkind = 'r'
	LEFT JOIN pg_class pt ON pt.oid = it.inhparent AND pt.relkind = 'p'
	LEFT JOIN pg_index x ON x.indexrelid = c.oid
	LEFT JOIN pg_inherits ii ON ii.inhrelid = x.indrelid
	LEFT JOIN pg_class pi ON pi.oid = ii.inhparent AND pi.relkind = 'p'
	WHERE l.pid = pg_backend_pid() AND l.locktype = 'relation'
`;

export async function lockedRelations(client: pg.Client): Promise<LockedRelation[]> {
	return (await client.query<LockedRelation>(locksSql)).rows;
}

export async function budgeted<R extends pg.QueryResultRow>(client: pg.Client, kind: 'data' | 'catalog', sql: string, values: unknown[] = []): Promise<R[]> {
	await client.query('BEGIN');
	try {
		const { rows } = await client.query<R>(sql, values);
		const locks = await lockedRelations(client);
		const children = new Map<string, Set<string>>();
		for (const lock of locks) {
			if (lock.partitionOf != null) children.set(lock.partitionOf, (children.get(lock.partitionOf) ?? new Set()).add(lock.child));
		}
		const over = [...children].filter(([, locked]) => kind === 'catalog' || locked.size > 1);
		if (over.length > 0) throw new Error(`a ${kind} check locked ${over.map(([parent, locked]) => `${locked.size} partitions of ${parent}`).join(', ')}: ${sql.trim().slice(0, 300)}`);
		return rows;
	} finally {
		await client.query('ROLLBACK');
	}
}
