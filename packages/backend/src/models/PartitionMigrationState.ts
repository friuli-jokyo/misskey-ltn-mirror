/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Column } from 'typeorm';

export type PartitionMigrationPhaseState = {
	watermark?: string;
	cursor?: string;
	batchEnd?: string;
	batchSize?: number;
	ord?: number;
	attempts?: number;
	nextAttemptAt?: number;
	lastError?: string;
};

@Entity('partition_migration_state')
export class MiPartitionMigrationState {
	@PrimaryColumn('varchar', {
		length: 64,
	})
	public name: string;

	@Column('jsonb', {
		default: {},
	})
	public state: PartitionMigrationPhaseState;

	@Column('timestamp with time zone', {
		nullable: true,
	})
	public finishedAt: Date | null;
}
