/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NotePartitioningShadow1792429514508 {
	name = 'NotePartitioningShadow1792429514508'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE IF NOT EXISTS "note_p" (LIKE "note" INCLUDING DEFAULTS INCLUDING GENERATED INCLUDING COMMENTS) PARTITION BY RANGE ("id")`);
		await queryRunner.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'note_p'::regclass AND contype = 'p') THEN ALTER TABLE "note_p" ADD PRIMARY KEY ("id"); END IF; END $$`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE IF EXISTS "note_p"`);
	}
}
