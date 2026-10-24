/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DeletedNote1792429514525 {
	name = 'DeletedNote1792429514525'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "deleted_note" ("id" character varying(32) NOT NULL, CONSTRAINT "PK_1cb67148b7b707a03c63b2165fc" PRIMARY KEY ("id"))`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "deleted_note"`);
	}
}
