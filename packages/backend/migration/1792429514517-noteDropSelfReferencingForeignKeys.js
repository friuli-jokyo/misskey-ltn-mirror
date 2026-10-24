/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteDropSelfReferencingForeignKeys1792429514517 {
	name = 'NoteDropSelfReferencingForeignKeys1792429514517'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" DROP CONSTRAINT IF EXISTS "FK_17cb3553c700a4985dff5a30ff5"`);
		await queryRunner.query(`ALTER TABLE "note" DROP CONSTRAINT IF EXISTS "FK_52ccc804d7c69037d558bac4c96"`);
	}

	async down(queryRunner) {
		await queryRunner.query(`ALTER TABLE "note" ADD CONSTRAINT "FK_52ccc804d7c69037d558bac4c96" FOREIGN KEY ("renoteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`);
		await queryRunner.query(`ALTER TABLE "note" ADD CONSTRAINT "FK_17cb3553c700a4985dff5a30ff5" FOREIGN KEY ("replyId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID`);
	}
}
