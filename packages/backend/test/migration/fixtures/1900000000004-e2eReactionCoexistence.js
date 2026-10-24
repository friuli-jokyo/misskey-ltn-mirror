/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class E2eReactionCoexistence1900000000004 {
	name = 'E2eReactionCoexistence1900000000004';

	async up(queryRunner) {
		await queryRunner.query('DROP INDEX "IDX_ad0c221b25672daf2df320a817"');
	}

	async down(queryRunner) {
		await queryRunner.query('CREATE UNIQUE INDEX "IDX_ad0c221b25672daf2df320a817" ON "note_reaction" ("userId", "noteId")');
	}
}
