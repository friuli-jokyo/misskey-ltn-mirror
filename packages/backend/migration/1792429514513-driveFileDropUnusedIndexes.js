/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DriveFileDropUnusedIndexes1792429514513 {
	name = 'DriveFileDropUnusedIndexes1792429514513'

	async up(queryRunner) {
		await queryRunner.query(`DROP INDEX "IDX_e5848eac4940934e23dbc17581"`);
		await queryRunner.query(`DROP INDEX "IDX_a7eba67f8b3fa27271e85d2e26"`);
		await queryRunner.query(`DROP INDEX "IDX_3b33dff77bb64b23c88151d23e"`);
		await queryRunner.query(`DROP INDEX "IDX_8bdcd3dd2bddb78014999a16ce"`);
	}

	async down(queryRunner) {
		await queryRunner.query(`CREATE INDEX "IDX_8bdcd3dd2bddb78014999a16ce" ON "drive_file" ("maybePorn")`);
		await queryRunner.query(`CREATE INDEX "IDX_3b33dff77bb64b23c88151d23e" ON "drive_file" ("maybeSensitive")`);
		await queryRunner.query(`CREATE INDEX "IDX_a7eba67f8b3fa27271e85d2e26" ON "drive_file" ("isSensitive")`);
		await queryRunner.query(`CREATE INDEX "IDX_e5848eac4940934e23dbc17581" ON "drive_file" ("uri")`);
	}
}
