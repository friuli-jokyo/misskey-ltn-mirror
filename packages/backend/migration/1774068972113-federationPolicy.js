/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class FederationPolicy1774068972113 {
    name = 'FederationPolicy1774068972113'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user" ADD "federationPolicy" character varying(128) NOT NULL DEFAULT 'lax'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user" DROP COLUMN "federationPolicy"`);
    }
}
