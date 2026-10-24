/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserNoteIdFloor1792429514522 {
	name = 'UserNoteIdFloor1792429514522'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user" ADD "noteIdFloor" character varying(32)`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DELETE FROM "partition_migration_state" WHERE "name" IN ('userNoteIdFloorIndex', 'userNoteIdFloorBackfill')`);
		await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "noteIdFloor"`);
	}
}
