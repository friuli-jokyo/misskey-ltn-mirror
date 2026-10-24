/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class E2eAfterPlainSwitch1900000000005 {
	name = 'E2eAfterPlainSwitch1900000000005';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" DROP CONSTRAINT "CHK_e2e_note_id_length"');
		await queryRunner.query('DROP INDEX "IDX_d4ebdef929896d6dc4a3c5bb48"');
		await queryRunner.query('ALTER TABLE "note" ALTER COLUMN "pageCount" SET NOT NULL');
		await queryRunner.query('DELETE FROM "note_reaction" a USING "note_reaction" b WHERE a."userId" = b."userId" AND a."noteId" = b."noteId" AND a."id" < b."id"');
		await queryRunner.query('CREATE UNIQUE INDEX "IDX_ad0c221b25672daf2df320a817" ON "note_reaction" ("userId", "noteId")');
		await queryRunner.query('ALTER TABLE "note_reaction" ADD CONSTRAINT "UQ_e2e_reaction_note_user_reaction" UNIQUE ("noteId", "userId", "reaction")');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "note_reaction" DROP CONSTRAINT "UQ_e2e_reaction_note_user_reaction"');
		await queryRunner.query('DROP INDEX "IDX_ad0c221b25672daf2df320a817"');
		await queryRunner.query('ALTER TABLE "note" ALTER COLUMN "pageCount" DROP NOT NULL');
		await queryRunner.query('CREATE INDEX "IDX_d4ebdef929896d6dc4a3c5bb48" ON "note" ("threadId")');
		await queryRunner.query('ALTER TABLE "note" ADD CONSTRAINT "CHK_e2e_note_id_length" CHECK (length("id") >= 10)');
	}
}
