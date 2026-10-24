/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteUnlinkedRelation1792429514523 {
	name = 'NoteUnlinkedRelation1792429514523'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "note_unlinked_relation" ("noteId" character varying(32) NOT NULL, "replyId" character varying(32), "renoteId" character varying(32), "replyUri" character varying(512), "renoteUri" character varying(512), CONSTRAINT "PK_e011e753f650857e3ad3dbf216c" PRIMARY KEY ("noteId"))`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DELETE FROM "partition_migration_state" WHERE "name" = 'noteInvertedRelationUnlink'`);
		await queryRunner.query(`DROP TABLE "note_unlinked_relation"`);
	}
}
