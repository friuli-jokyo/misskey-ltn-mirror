/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NotePendingParent1792429514521 {
	name = 'NotePendingParent1792429514521'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "note_pending_parent" ("parentUri" character varying(512) NOT NULL, "childId" character varying(32) NOT NULL, "kind" smallint NOT NULL, CONSTRAINT "PK_daab6a6ff80a0b197c336e5280e" PRIMARY KEY ("parentUri", "childId", "kind"))`);
		await queryRunner.query(`CREATE INDEX "IDX_928ced07f37014b01ef1267c30" ON "note_pending_parent" ("childId")`);
		await queryRunner.query(`ALTER TABLE "note_pending_parent" ADD CONSTRAINT "FK_928ced07f37014b01ef1267c305" FOREIGN KEY ("childId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note_pending_parent" DROP CONSTRAINT "FK_928ced07f37014b01ef1267c305"`);
		await queryRunner.query(`DROP INDEX "IDX_928ced07f37014b01ef1267c30"`);
		await queryRunner.query(`DROP TABLE "note_pending_parent"`);
	}
}
