/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class ConspicuousScaleEmoji1711123547052 {
    name = 'ConspicuousScaleEmoji1711123547052'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "emoji" ADD "conspicuousScale" smallint NOT NULL DEFAULT 1`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "emoji" DROP COLUMN "conspicuousScale"`);
    }
}
