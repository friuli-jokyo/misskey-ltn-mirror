/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteUriLookup1792429514518 {
	name = 'NoteUriLookup1792429514518'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "note_uri" ("uri" character varying(512) NOT NULL, "noteId" character varying(32) NOT NULL, CONSTRAINT "PK_c6c62a96c656ddaf60ae4684610" PRIMARY KEY ("uri"))`);
		await queryRunner.query(`CREATE UNIQUE INDEX "IDX_eb025e7ab43c991b506fd7d856" ON "note_uri" ("noteId")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_eb025e7ab43c991b506fd7d856"`);
		await queryRunner.query(`DROP TABLE "note_uri"`);
	}
}
