/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DriveFileSortIndexes1792429514512 {
	name = 'DriveFileSortIndexes1792429514512'

	async up(queryRunner) {
		await queryRunner.query(`CREATE INDEX "IDX_6c943175a8ebbe892f6992408b" ON "drive_file" ("userId", "name")`);
		await queryRunner.query(`CREATE INDEX "IDX_10de3938f7c1bb443f6d51b003" ON "drive_file" ("userId", "size")`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_10de3938f7c1bb443f6d51b003"`);
		await queryRunner.query(`DROP INDEX "IDX_6c943175a8ebbe892f6992408b"`);
	}
}
