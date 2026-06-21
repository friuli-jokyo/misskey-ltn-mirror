/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class circulation1781982168494 {
	name = 'circulation1781982168494'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "__chart__notes" ADD COLUMN "___promote" integer NOT NULL DEFAULT '0'`);
		await queryRunner.query(`ALTER TABLE "__chart__per_user_notes" ADD COLUMN "___promote" smallint NOT NULL DEFAULT '0'`);
		await queryRunner.query(`ALTER TABLE "__chart_day__notes" ADD COLUMN "___promote" integer NOT NULL DEFAULT '0'`);
		await queryRunner.query(`ALTER TABLE "__chart_day__per_user_notes" ADD COLUMN "___promote" smallint NOT NULL DEFAULT '0'`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "__chart__notes" DROP COLUMN "___promote"`);
		await queryRunner.query(`ALTER TABLE "__chart__per_user_notes" DROP COLUMN "___promote"`);
		await queryRunner.query(`ALTER TABLE "__chart_day__notes" DROP COLUMN "___promote"`);
		await queryRunner.query(`ALTER TABLE "__chart_day__per_user_notes" DROP COLUMN "___promote"`);
	}
}
