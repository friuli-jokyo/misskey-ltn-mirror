/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class bannedEmailDomains1709744820502 {
    constructor() {
        this.name = 'bannedEmailDomains1709744820502';
    }

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" ADD "bannedMediaDomains" character varying(1024) array NOT NULL DEFAULT '{}'`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "meta" DROP COLUMN "bannedMediaDomains"`);
    }
}
