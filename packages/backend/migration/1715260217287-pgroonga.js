/*
* SPDX-FileCopyrightText: syuilo and other misskey contributors
* SPDX-License-Identifier: AGPL-3.0-only
*/

export class PGroonga1715260217287 {
    name = 'PGroonga1715260217287'

    async up(queryRunner) {
        await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS pgroonga`);
        await queryRunner.query(`CREATE INDEX CONCURRENTLY "IDX_8c75d580865f43f8b01b5e90c4" ON "note" USING pgroonga (concat_ws(' ', "cw", "text"))`);
    }

    async down(queryRunner) {
        await queryRunner.query(`DROP INDEX "IDX_8c75d580865f43f8b01b5e90c4"`);
        await queryRunner.query(`DROP EXTENSION IF EXISTS pgroonga`);
    }
}
