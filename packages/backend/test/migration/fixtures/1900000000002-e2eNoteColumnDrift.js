/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class E2eNoteColumnDrift1900000000002 {
	name = 'E2eNoteColumnDrift1900000000002';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" ADD COLUMN "e2eDrift" integer');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" DROP COLUMN "e2eDrift"');
	}
}
