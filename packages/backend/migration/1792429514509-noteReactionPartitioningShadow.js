/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteReactionPartitioningShadow1792429514509 {
	name = 'NoteReactionPartitioningShadow1792429514509'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE IF NOT EXISTS "note_reaction_p" (LIKE "note_reaction" INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING COMMENTS) PARTITION BY RANGE ("noteId")`);
		await queryRunner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'note_reaction_p'::regclass AND contype = 'p') THEN ALTER TABLE "note_reaction_p" ADD PRIMARY KEY ("noteId", "id"); END IF; END $$`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE IF EXISTS "note_reaction_p"`);
	}
}
