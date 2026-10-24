/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { alterPartitionCopies } from '../../../built/partition-copies.js';

export class E2eNoteColumnDriftFix1900000000003 {
	name = 'E2eNoteColumnDriftFix1900000000003';

	async up(queryRunner) {
		await alterPartitionCopies(queryRunner, 'note', 'ADD COLUMN IF NOT EXISTS "e2eDrift" integer');
	}

	async down(queryRunner) {
		await alterPartitionCopies(queryRunner, 'note', 'DROP COLUMN IF EXISTS "e2eDrift"');
	}
}
