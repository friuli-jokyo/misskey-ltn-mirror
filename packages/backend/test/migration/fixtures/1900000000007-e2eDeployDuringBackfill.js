/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { alterPartitionCopies } from '../../../built/partition-copies.js';

export class E2eDeployDuringBackfill1900000000007 {
	name = 'E2eDeployDuringBackfill1900000000007';

	async up(queryRunner) {
		await queryRunner.query('ALTER TABLE "note" ADD CONSTRAINT "CHK_e2e_deploy" CHECK (length("id") >= 10)');
		await alterPartitionCopies(queryRunner, 'note', 'ADD COLUMN "e2eDeploy" character varying(32)');
		await alterPartitionCopies(queryRunner, 'note', 'DROP COLUMN "e2eDeploy"');
		await queryRunner.query('ALTER TABLE "note" DROP CONSTRAINT "CHK_e2e_deploy"');
	}

	async down() {
	}
}
