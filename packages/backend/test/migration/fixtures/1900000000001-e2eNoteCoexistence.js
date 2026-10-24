/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { alterPartitionCopies } from '../../../built/partition-copies.js';

export class E2eNoteCoexistence1900000000001 {
	name = 'E2eNoteCoexistence1900000000001';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" ADD CONSTRAINT "CHK_e2e_note_id_length" CHECK (length("id") >= 10)');
		await queryRunner.query('ALTER TABLE "note" ALTER COLUMN "pageCount" DROP NOT NULL');
		await alterPartitionCopies(queryRunner, 'note', 'ADD COLUMN "e2eAdded" character varying(32)');
	}

	async down(queryRunner) {
		await alterPartitionCopies(queryRunner, 'note', 'DROP COLUMN "e2eAdded"');
		await queryRunner.query('ALTER TABLE "note" ALTER COLUMN "pageCount" SET NOT NULL');
		await queryRunner.query('ALTER TABLE "note" DROP CONSTRAINT "CHK_e2e_note_id_length"');
	}
}
