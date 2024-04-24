/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class HiddenEmoji1699872192285 {
    name = 'HiddenEmoji1699872192285'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "emoji" ADD "hidden" boolean NOT NULL DEFAULT false`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "emoji" DROP COLUMN "hidden"`);
    }
}
