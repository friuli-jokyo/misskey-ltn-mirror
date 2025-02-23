/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class RoleTags1740325734247 {
    name = 'RoleTags1740325734247'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "role" ADD "tags" varchar(256) array NOT NULL DEFAULT '{}'::varchar[]`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "role" DROP COLUMN "tags"`);
    }
}
