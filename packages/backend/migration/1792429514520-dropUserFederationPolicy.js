/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DropUserFederationPolicy1792429514520 {
	name = 'DropUserFederationPolicy1792429514520'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "federationPolicy"`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "user" ADD "federationPolicy" character varying(128) NOT NULL DEFAULT 'lax'`);
	}
}
