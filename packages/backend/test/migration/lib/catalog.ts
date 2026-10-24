/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { budgeted } from './budget.js';
import type pg from 'pg';

export type Snapshot = {
	relations: { name: string; kind: string }[];
	columns: { table: string; name: string; type: string; notNull: boolean; default: string | null; generated: string; identity: string; collation: string | null }[];
	indexes: { table: string; name: string; definition: string; valid: boolean }[];
	constraints: { table: string; name: string; type: string; definition: string; validated: boolean }[];
	triggers: { table: string; name: string; definition: string; enabled: string }[];
	functions: { name: string; source: string }[];
	migrations: string[];
};

export type CatalogObjects = {
	tables?: string[];
	columns?: string[];
	indexes?: string[];
	functions?: string[];
	triggers?: string[];
	constraints?: string[];
};

const copyTables = ['note', 'note_old', 'note_p', 'note_reaction', 'note_reaction_old', 'note_reaction_p'];

export const syncFunctions = ['note_sync_to_p', 'note_sync_to_old', 'note_reaction_sync_to_p', 'note_reaction_sync_to_old'];

export async function snapshot(client: pg.Client): Promise<Snapshot> {
	const query = async <R extends pg.QueryResultRow>(sql: string) => await budgeted<R>(client, 'catalog', sql);
	return {
		relations: await query('SELECT relname AS "name", relkind AS "kind" FROM pg_class WHERE relnamespace = \'public\'::regnamespace AND relkind IN (\'r\', \'p\', \'v\', \'m\', \'S\') AND NOT relispartition ORDER BY relname'),
		columns: await query(`
			SELECT c.relname AS "table", a.attname AS "name", format_type(a.atttypid, a.atttypmod) AS "type", a.attnotnull AS "notNull",
				pg_get_expr(d.adbin, d.adrelid) AS "default", a.attgenerated::text AS "generated", a.attidentity::text AS "identity",
				CASE WHEN a.attcollation <> 0 THEN a.attcollation::regcollation::text END AS "collation"
			FROM pg_attribute a
			JOIN pg_class c ON c.oid = a.attrelid
			LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
			WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p') AND NOT c.relispartition AND a.attnum > 0 AND NOT a.attisdropped
			ORDER BY c.relname, a.attnum
		`),
		indexes: await query(`
			SELECT t.relname AS "table", c.relname AS "name", pg_get_indexdef(i.indexrelid) AS "definition", i.indisvalid AS "valid"
			FROM pg_index i
			JOIN pg_class c ON c.oid = i.indexrelid
			JOIN pg_class t ON t.oid = i.indrelid
			WHERE t.relnamespace = 'public'::regnamespace AND NOT t.relispartition
			ORDER BY t.relname, c.relname
		`),
		constraints: await query(`
			SELECT t.relname AS "table", con.conname AS "name", con.contype::text AS "type", pg_get_constraintdef(con.oid) AS "definition", con.convalidated AS "validated"
			FROM pg_constraint con
			JOIN pg_class t ON t.oid = con.conrelid
			WHERE t.relnamespace = 'public'::regnamespace AND NOT t.relispartition AND con.conparentid = 0
			ORDER BY t.relname, con.conname, con.contype
		`),
		triggers: await query(`
			SELECT c.relname AS "table", t.tgname AS "name", pg_get_triggerdef(t.oid) AS "definition", t.tgenabled::text AS "enabled"
			FROM pg_trigger t
			JOIN pg_class c ON c.oid = t.tgrelid
			WHERE c.relnamespace = 'public'::regnamespace AND NOT t.tgisinternal AND t.tgparentid = 0
			ORDER BY c.relname, t.tgname
		`),
		functions: await query('SELECT proname AS "name", md5(prosrc) AS "source" FROM pg_proc WHERE pronamespace = \'public\'::regnamespace ORDER BY proname, md5(prosrc)'),
		migrations: (await query<{ name: string }>('SELECT "name" FROM "migrations" ORDER BY "id"')).map(row => row.name),
	};
}

export function foreignKeys(snapshot: Snapshot): string[] {
	return snapshot.constraints.filter(constraint => constraint.type === 'f').map(constraint => `${constraint.table}.${constraint.name} ${constraint.definition}`).sort();
}

export async function existingObjects(client: pg.Client, objects: CatalogObjects): Promise<string[]> {
	const found: string[] = [];
	const lookups: [string, string[] | undefined, string][] = [
		['table', objects.tables, 'SELECT relname AS "name" FROM pg_class WHERE relnamespace = \'public\'::regnamespace AND relkind IN (\'r\', \'p\') AND relname = ANY($1)'],
		['column', objects.columns, 'SELECT c.relname || \'.\' || a.attname AS "name" FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid WHERE c.relnamespace = \'public\'::regnamespace AND a.attnum > 0 AND NOT a.attisdropped AND c.relname || \'.\' || a.attname = ANY($1)'],
		['index', objects.indexes, 'SELECT relname AS "name" FROM pg_class WHERE relnamespace = \'public\'::regnamespace AND relkind IN (\'i\', \'I\') AND relname = ANY($1)'],
		['function', objects.functions, 'SELECT proname AS "name" FROM pg_proc WHERE pronamespace = \'public\'::regnamespace AND proname = ANY($1)'],
		['trigger', objects.triggers, 'SELECT c.relname || \'.\' || t.tgname AS "name" FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid WHERE c.relnamespace = \'public\'::regnamespace AND NOT t.tgisinternal AND c.relname || \'.\' || t.tgname = ANY($1)'],
		['constraint', objects.constraints, 'SELECT c.relname || \'.\' || con.conname AS "name" FROM pg_constraint con JOIN pg_class c ON c.oid = con.conrelid WHERE c.relnamespace = \'public\'::regnamespace AND c.relname || \'.\' || con.conname = ANY($1)'],
	];
	for (const [kind, names, sql] of lookups) {
		if (names == null || names.length === 0) continue;
		for (const row of await budgeted<{ name: string }>(client, 'catalog', sql, [names])) found.push(`${kind} ${row.name}`);
	}
	return [...new Set(found)].sort();
}

const objectKinds: Record<keyof CatalogObjects, string> = { tables: 'table', columns: 'column', indexes: 'index', functions: 'function', triggers: 'trigger', constraints: 'constraint' };

export function objectNames(objects: CatalogObjects): string[] {
	return (Object.keys(objects) as (keyof CatalogObjects)[]).flatMap(kind => (objects[kind] ?? []).map(name => `${objectKinds[kind]} ${name}`)).sort();
}

export async function copyState(client: pg.Client): Promise<{ relkinds: Record<string, string | null>; triggers: string[]; functions: string[]; children: Record<string, number> }> {
	const relations = await budgeted<{ name: string; kind: string }>(client, 'catalog', 'SELECT relname AS "name", relkind AS "kind" FROM pg_class WHERE relnamespace = \'public\'::regnamespace AND relname = ANY($1)', [copyTables]);
	const triggers = await budgeted<{ name: string }>(client, 'catalog', `
		SELECT c.relname || '.' || t.tgname AS "name"
		FROM pg_trigger t
		JOIN pg_class c ON c.oid = t.tgrelid
		WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND NOT t.tgisinternal AND t.tgparentid = 0
		ORDER BY 1
	`, [copyTables]);
	const functions = await budgeted<{ name: string }>(client, 'catalog', 'SELECT proname AS "name" FROM pg_proc WHERE pronamespace = \'public\'::regnamespace AND proname = ANY($1) ORDER BY 1', [syncFunctions]);
	const children = await budgeted<{ name: string; count: number }>(client, 'catalog', `
		SELECT p.relname AS "name", count(i.inhrelid)::int AS "count"
		FROM pg_class p
		LEFT JOIN pg_inherits i ON i.inhparent = p.oid
		WHERE p.relnamespace = 'public'::regnamespace AND p.relname = ANY($1) AND p.relkind = 'p'
		GROUP BY p.relname
	`, [copyTables]);
	return {
		relkinds: Object.fromEntries(copyTables.map(table => [table, relations.find(row => row.name === table)?.kind ?? null])),
		triggers: triggers.map(row => row.name),
		functions: functions.map(row => row.name),
		children: Object.fromEntries(children.map(row => [row.name, row.count])),
	};
}
