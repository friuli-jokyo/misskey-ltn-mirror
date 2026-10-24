/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteRelation1792429514516 {
	name = 'NoteRelation1792429514516'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "note_relation" ("childId" character varying(32) NOT NULL, "kind" smallint NOT NULL, "parentId" character varying(32) NOT NULL, "parentReplyUserId" character varying(32), "parentReplyUserHost" character varying(128), "parentRenoteUserId" character varying(32), "parentRenoteUserHost" character varying(128), CONSTRAINT "PK_17cab021f69974cd455bd4ba924" PRIMARY KEY ("childId", "kind"))`);
		await queryRunner.query(`CREATE INDEX "IDX_8fa3991d01ef7478fe89ed629f" ON "note_relation" ("parentId", "childId")`);
		await queryRunner.query(`ALTER TABLE "note_relation" ADD CONSTRAINT "CHK_547cc29e50f07df9fc86a116fb" CHECK ("childId" > "parentId")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_relation" DROP CONSTRAINT "CHK_547cc29e50f07df9fc86a116fb"`);
		await queryRunner.query(`DROP INDEX "IDX_8fa3991d01ef7478fe89ed629f"`);
		await queryRunner.query(`DROP TABLE "note_relation"`);
	}
}
