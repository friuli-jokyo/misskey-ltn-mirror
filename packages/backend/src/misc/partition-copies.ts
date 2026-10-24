/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { EntityManager } from 'typeorm';

export type PartitionCopyTable = 'note' | 'note_reaction';

export type PartitionCopies = {
	partitioned: boolean;
	inactive: string | null;
	synced: boolean;
};

type Queryable = Pick<EntityManager, 'query'>;

export const partitionCopyTables: readonly PartitionCopyTable[] = ['note', 'note_reaction'];

export const partitionCopyKeyColumns: Record<PartitionCopyTable, string[]> = {
	note: ['id'],
	note_reaction: ['noteId', 'id'],
};

export const partitionedCopyTriggers: Record<PartitionCopyTable, string[]> = {
	note: [],
	note_reaction: ['note_reaction_locator_insert', 'note_reaction_locator_delete', 'note_reaction_locator_update'],
};

export function plainCopyName(table: PartitionCopyTable): string {
	return `${table}_old`;
}

export function partitionedCopyName(table: PartitionCopyTable): string {
	return `${table}_p`;
}

export function syncTriggerName(table: PartitionCopyTable): string {
	return `${table}_sync`;
}

export function syncFunctionName(table: PartitionCopyTable, livePartitioned: boolean): string {
	return livePartitioned ? `${table}_sync_to_old` : `${table}_sync_to_p`;
}

export function schemaMismatchSql(table: string, shadow: string): string {
	return `
		SELECT coalesce(a.attname, b.attname) AS col
		FROM (SELECT attname, atttypid, atttypmod FROM pg_attribute
			WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped) a
		FULL JOIN (SELECT attname, atttypid, atttypmod FROM pg_attribute
			WHERE attrelid = '${shadow}'::regclass AND attnum > 0 AND NOT attisdropped) b USING (attname)
		WHERE a.attname IS NULL OR b.attname IS NULL
			OR a.atttypid <> b.atttypid OR a.atttypmod <> b.atttypmod
	`;
}

export function buildSyncFunctionSql(table: string, shadow: string, fnName: string, keyColumns: string[]): string {
	const newMatch = keyColumns.map((col, i) => `"${col}" = $${i + 2}`).join(' AND ');
	const newKeys = keyColumns.map(col => `NEW."${col}"`).join(', ');
	const oldMatch = keyColumns.map((col, i) => `"${col}" = $${i + 1}`).join(' AND ');
	const oldKeys = keyColumns.map(col => `OLD."${col}"`).join(', ');
	return `
		DO $$
		DECLARE
			cols text;
			conflict text;
		BEGIN
			SELECT string_agg(quote_ident(attname), ', ' ORDER BY attnum)
			INTO cols
			FROM pg_attribute
			WHERE attrelid = '${table}'::regclass AND attnum > 0 AND NOT attisdropped;

			SELECT string_agg(quote_ident(a.attname), ', ' ORDER BY k.ord)
			INTO conflict
			FROM pg_index i
			CROSS JOIN unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord)
			JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum
			WHERE i.indrelid = '${shadow}'::regclass AND i.indisprimary;

			EXECUTE format($fn$
				CREATE OR REPLACE FUNCTION ${fnName}() RETURNS trigger AS $body$
				BEGIN
					IF TG_OP = 'INSERT' THEN
						EXECUTE 'INSERT INTO ${shadow} (%1$s) SELECT ($1).* ON CONFLICT (%2$s) DO NOTHING' USING NEW;
					ELSIF TG_OP = 'UPDATE' THEN
						EXECUTE 'UPDATE ${shadow} SET (%1$s) = ROW(($1).*) WHERE ${newMatch}' USING NEW, ${newKeys};
					ELSIF TG_OP = 'DELETE' THEN
						EXECUTE 'DELETE FROM ${shadow} WHERE ${oldMatch}' USING ${oldKeys};
					END IF;
					RETURN NULL;
				END;
				$body$ LANGUAGE plpgsql
			$fn$, cols, conflict);
		END $$
	`;
}

export async function inspectPartitionCopies(db: Queryable, table: PartitionCopyTable): Promise<PartitionCopies> {
	const [copies]: PartitionCopies[] = await db.query(`
		SELECT c.relkind = 'p' AS "partitioned",
			CASE WHEN c.relkind = 'p' THEN to_regclass($2)::text ELSE to_regclass($3)::text END AS "inactive",
			EXISTS (SELECT 1 FROM pg_trigger t WHERE t.tgrelid = c.oid AND t.tgname = $4) AS "synced"
		FROM pg_class c
		WHERE c.oid = $1::regclass
	`, [table, plainCopyName(table), partitionedCopyName(table), syncTriggerName(table)]);
	return copies;
}

export async function assertPartitionCopiesMatch(db: Queryable): Promise<void> {
	for (const table of partitionCopyTables) {
		const copies = await inspectPartitionCopies(db, table);
		if (!copies.synced) continue;
		if (copies.inactive == null) {
			throw new Error(`${syncTriggerName(table)} mirrors writes on ${table} into ${copies.partitioned ? plainCopyName(table) : partitionedCopyName(table)}, which does not exist.`);
		}
		const mismatches: { col: string }[] = await db.query(schemaMismatchSql(table, copies.inactive));
		if (mismatches.length > 0) {
			throw new Error(`The columns of ${table} and ${copies.inactive} differ (${mismatches.map(x => x.col).join(', ')}) while ${syncTriggerName(table)} mirrors writes between them. Apply the column change to every copy with alterPartitionCopies.`);
		}
	}
}

export async function analyzePartitionedParent(db: Queryable, table: PartitionCopyTable): Promise<void> {
	const [{ version, relkind }]: { version: number; relkind: string }[] = await db.query(
		'SELECT current_setting(\'server_version_num\')::int AS "version", relkind FROM pg_class WHERE oid = $1::regclass',
		[table],
	);
	if (version < 180000 || relkind !== 'p') return;
	await db.query(`ANALYZE ONLY "${table}"`);
}

export async function alterPartitionCopies(db: Queryable, table: PartitionCopyTable, action: string): Promise<void> {
	const [{ copies }]: { copies: string[] }[] = await db.query(
		'SELECT array_remove(ARRAY[to_regclass($1)::text, to_regclass($2)::text, to_regclass($3)::text], NULL) AS "copies"',
		[table, plainCopyName(table), partitionedCopyName(table)],
	);
	for (const copy of copies) {
		await db.query(`ALTER TABLE "${copy}" ${action}`);
	}
	const state = await inspectPartitionCopies(db, table);
	if (state.inactive != null) {
		const mismatches: { col: string }[] = await db.query(schemaMismatchSql(table, state.inactive));
		if (mismatches.length > 0) {
			throw new Error(`The columns of ${table} and ${state.inactive} differ after "${action}": ${mismatches.map(x => x.col).join(', ')}`);
		}
		if (state.synced) {
			await db.query(buildSyncFunctionSql(table, state.inactive, syncFunctionName(table, state.partitioned), partitionCopyKeyColumns[table]));
		}
	}
}
