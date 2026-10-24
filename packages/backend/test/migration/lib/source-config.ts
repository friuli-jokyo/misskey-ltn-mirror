/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export const harnessUrl = 'https://e2e.misskey.invalid';

export type PartitionMigrationSource = {
	liveTable: 'partitioned' | 'plain';
	dropOldTables: boolean;
};

export type SourceConfigInput = {
	pgPort: number;
	database: string;
	user: string;
	redisPort: number;
	partitionMigration: PartitionMigrationSource;
};

export function sourceConfig(input: SourceConfigInput): Record<string, unknown> {
	return {
		url: `${harnessUrl}/`,
		port: 61812,
		db: { host: '127.0.0.1', port: input.pgPort, db: input.database, user: input.user, pass: '' },
		dbReplications: false,
		redis: { host: '127.0.0.1', port: input.redisPort, pass: '', db: 0, prefix: 'e2e' },
		id: 'aid',
		fulltextSearch: { provider: 'sqlLike' },
		proxyBypassHosts: [],
		allowedPrivateNetworks: [],
		clusterLimit: 1,
		partitionMigration: input.partitionMigration,
	};
}
