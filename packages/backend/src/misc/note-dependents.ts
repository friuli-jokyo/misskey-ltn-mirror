/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { MiNote } from '@/models/Note.js';
import { chunk, unique } from '@/misc/prelude/array.js';

type Queryable = {
	query(query: string, parameters?: unknown[]): Promise<any>;
};

type NoteLockStrength = 'UPDATE' | 'NO KEY UPDATE' | 'KEY SHARE';

export type LockedNote = Pick<MiNote, 'id' | 'threadId' | 'replyUserId' | 'replyUserHost' | 'renoteUserId' | 'renoteUserHost'>;

const dependents = [
	['poll', 'noteId'],
	['poll_vote', 'noteId'],
	['note_favorite', 'noteId'],
	['clip_note', 'noteId'],
	['user_note_pining', 'noteId'],
	['promo_note', 'noteId'],
	['promo_read', 'noteId'],
	['note_reaction', 'noteId'],
	['note_pending_parent', 'childId'],
	['note_unlinked_relation', 'noteId'],
] as const;

const inClauseLimit = 500;

export async function lockNoteRowsInIdOrder(q: Queryable, noteIds: MiNote['id'][], strength: NoteLockStrength): Promise<LockedNote[]> {
	const locked: LockedNote[] = [];
	for (const ids of chunk(unique(noteIds).sort(), inClauseLimit)) {
		const rows: LockedNote[] = await q.query(
			`SELECT "id", "threadId", "replyUserId", "replyUserHost", "renoteUserId", "renoteUserHost" FROM "note" WHERE "id" IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) ORDER BY "id" FOR ${strength}`,
			ids,
		);
		locked.push(...rows);
	}
	return locked;
}

export async function lockNotesInIdOrder(q: Queryable, noteIds: MiNote['id'][], strength: NoteLockStrength): Promise<MiNote['id'][]> {
	return (await lockNoteRowsInIdOrder(q, noteIds, strength)).map(row => row.id);
}

export async function deleteNoteDependents(q: Queryable, noteIds: MiNote['id'][]): Promise<void> {
	if (noteIds.length === 0) return;

	for (const [table, column] of dependents) {
		await q.query(`DELETE FROM "${table}" WHERE "${column}" = ANY($1)`, [noteIds]);
	}
}

export async function recordDeletedNotes(q: Queryable, notes: Pick<MiNote, 'id' | 'uri'>[]): Promise<void> {
	if (notes.length === 0) return;

	await q.query('INSERT INTO "deleted_note" ("id") SELECT unnest($1::varchar[]) ON CONFLICT DO NOTHING', [notes.map(note => note.id)]);

	const remoteNotes = notes.filter(note => note.uri != null);
	if (remoteNotes.length > 0) {
		await q.query(
			'INSERT INTO "note_uri" ("uri", "noteId") SELECT * FROM unnest($1::varchar[], $2::varchar[]) ON CONFLICT DO NOTHING',
			[remoteNotes.map(note => note.uri), remoteNotes.map(note => note.id)],
		);
	}
}

export async function isDeletedNote(q: Queryable, noteId: MiNote['id']): Promise<boolean> {
	const rows: unknown[] = await q.query('SELECT 1 FROM "deleted_note" WHERE "id" = $1', [noteId]);
	return rows.length > 0;
}

export async function deleteNotesWithDependents(q: Queryable, noteIds: MiNote['id'][], options: { record: boolean }): Promise<MiNote['id'][]> {
	const deleted: Pick<MiNote, 'id' | 'uri'>[] = [];
	for (const ids of chunk(await lockNotesInIdOrder(q, noteIds, 'UPDATE'), inClauseLimit)) {
		const [rows]: [Pick<MiNote, 'id' | 'uri'>[], number] = await q.query(
			`DELETE FROM "note" WHERE "id" IN (${ids.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING "id", "uri"`,
			ids,
		);
		deleted.push(...rows);
	}

	if (options.record) await recordDeletedNotes(q, deleted);
	const deletedIds = deleted.map(note => note.id);
	await deleteNoteDependents(q, deletedIds);

	return deletedIds;
}
