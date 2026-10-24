/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { alterPartitionCopies } from '../../../built/partition-copies.js';

export class E2eAfterPartitionedSwitch1900000000006 {
	name = 'E2eAfterPartitionedSwitch1900000000006';

	async up(queryRunner) {
		await queryRunner.query('CREATE INDEX "IDX_d4ebdef929896d6dc4a3c5bb48" ON "note" ("threadId")');
		await alterPartitionCopies(queryRunner, 'note', 'DROP COLUMN "e2eAdded"');
		await alterPartitionCopies(queryRunner, 'note', 'DROP COLUMN "e2eDrift"');
		await queryRunner.query('ALTER TABLE "note_reaction" DROP CONSTRAINT "UQ_e2e_reaction_note_user_reaction"');
	}

	async down(queryRunner) {
		await queryRunner.query('ALTER TABLE "note_reaction" ADD CONSTRAINT "UQ_e2e_reaction_note_user_reaction" UNIQUE ("noteId", "userId", "reaction")');
		await alterPartitionCopies(queryRunner, 'note', 'ADD COLUMN "e2eDrift" integer');
		await alterPartitionCopies(queryRunner, 'note', 'ADD COLUMN "e2eAdded" character varying(32)');
		await queryRunner.query('DROP INDEX "IDX_d4ebdef929896d6dc4a3c5bb48"');
	}
}
