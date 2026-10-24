/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class PartitionMigrationState1792429514519 {
	name = 'PartitionMigrationState1792429514519'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "partition_migration_state" ("name" character varying(64) NOT NULL, "state" jsonb NOT NULL DEFAULT '{}', "finishedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_9d22782d184208e7c5fcf256409" PRIMARY KEY ("name"))`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TABLE "partition_migration_state"`);
	}
}
