/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import pg from 'pg';
import type { StatementStat } from './checks.js';
import type { HarnessEnv, Run } from './env.js';

export const databases = {
	main: 'misskey_migration_e2e',
	selfForeignKeys: 'misskey_migration_e2e_fk',
	branch: 'misskey_migration_e2e_branch',
} as const;

export type Database = typeof databases[keyof typeof databases];

function fastPathLockSlots(maxLocksPerTransaction: number): number {
	let power = 1;
	while (power < maxLocksPerTransaction) power *= 2;
	return 16 * Math.max(Math.min(Math.floor(power / 16), 1024), 1);
}

export class Cluster {
	public readonly user = userInfo().username;
	public readonly name: string;
	public readonly port: number;
	public fastPathSlots = 0;
	private readonly dataDir: string;

	constructor(private env: HarnessEnv, private run: Run) {
		this.name = `misskey-migration-e2e-${run.id}`;
		this.port = env.pgPort;
		this.dataDir = run.path('pg');
	}

	private exec(binary: string, args: string[]): string {
		return execFileSync(join(this.env.pgBin, binary), args, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] });
	}

	public async start(): Promise<void> {
		writeFileSync(this.run.path('logs', 'initdb.log'), this.exec('initdb', ['-D', this.dataDir, '-U', this.user, '--auth=trust', '--encoding=UTF8', '--locale=C.UTF-8']));
		appendFileSync(join(this.dataDir, 'postgresql.conf'), [
			'',
			'listen_addresses = \'127.0.0.1\'',
			`port = ${this.port}`,
			'unix_socket_directories = \'\'',
			`cluster_name = '${this.name}'`,
			'max_connections = 128',
			'max_locks_per_transaction = 4096',
			'shared_buffers = 512MB',
			'maintenance_work_mem = 512MB',
			'track_activity_query_size = 16384',
			'deadlock_timeout = 1s',
			'log_lock_waits = on',
			'logging_collector = on',
			'log_destination = \'jsonlog\'',
			'log_timezone = \'UTC\'',
			'log_directory = \'log\'',
			'log_min_messages = warning',
			'log_min_error_statement = error',
			'shared_preload_libraries = \'pg_stat_statements,auto_explain\'',
			'compute_query_id = on',
			'pg_stat_statements.track = all',
			'pg_stat_statements.max = 50000',
			'pg_stat_statements.track_utility = off',
			'auto_explain.log_min_duration = 0',
			'auto_explain.log_nested_statements = on',
			'auto_explain.log_format = json',
			'auto_explain.sample_rate = 0.02',
			'fsync = off',
			'synchronous_commit = off',
			'full_page_writes = off',
			'max_wal_size = 4GB',
			'',
		].join('\n'));
		this.exec('pg_ctl', ['-D', this.dataDir, '-l', join(this.dataDir, 'startup.log'), '-w', 'start']);
		this.run.marker.pgPid = Number(readFileSync(join(this.dataDir, 'postmaster.pid'), 'utf-8').split('\n')[0]);
		this.run.saveMarker();

		const client = await this.connect('postgres', 'mk-e2e-harness-cluster');
		try {
			const [settings] = (await client.query<{ version: number; locks: string }>('SELECT current_setting(\'server_version_num\')::int AS "version", current_setting(\'max_locks_per_transaction\') AS "locks"')).rows;
			if (settings.version < 180000 || settings.version >= 190000) throw new Error(`server_version_num ${settings.version} is not PostgreSQL 18`);
			if (settings.locks !== '4096') throw new Error(`max_locks_per_transaction is ${settings.locks}`);
			this.fastPathSlots = fastPathLockSlots(Number(settings.locks));
			await client.query('CREATE EXTENSION IF NOT EXISTS pg_stat_statements');
		} finally {
			await client.end();
		}
	}

	public stop(): void {
		if (this.run.marker.pgPid == null) return;
		this.exec('pg_ctl', ['-D', this.dataDir, '-m', 'fast', '-w', 'stop']);
		delete this.run.marker.pgPid;
		this.run.saveMarker();
	}

	public async connect(database: string, applicationName: string, options?: string): Promise<pg.Client> {
		const client = new pg.Client({ host: '127.0.0.1', port: this.port, user: this.user, database, application_name: applicationName, options: ['-c pg_stat_statements.track=none', ...(options != null ? [options] : [])].join(' ') });
		await client.connect();
		try {
			const [row] = (await client.query<{ cluster: string; database: string; port: number }>('SELECT current_setting(\'cluster_name\') AS "cluster", current_database() AS "database", inet_server_port() AS "port"')).rows;
			if (row.cluster !== this.name || row.database !== database || row.port !== this.port) throw new Error(`connected to ${JSON.stringify(row)} instead of ${this.name}/${database}:${this.port}`);
		} catch (e) {
			await client.end();
			throw e;
		}
		return client;
	}

	public async resetStatementStats(): Promise<void> {
		const client = await this.connect('postgres', 'mk-e2e-harness-statements');
		try {
			await client.query('SELECT pg_stat_statements_reset()');
		} finally {
			await client.end();
		}
	}

	public async statementStats(database: Database): Promise<StatementStat[]> {
		const client = await this.connect('postgres', 'mk-e2e-harness-statements');
		try {
			return (await client.query<StatementStat>('SELECT s.queryid::text AS "queryId", s.toplevel, s.calls::int AS "calls", s.query FROM pg_stat_statements s JOIN pg_database d ON d.oid = s.dbid WHERE d.datname = $1', [database])).rows;
		} finally {
			await client.end();
		}
	}

	public async createDatabase(database: Database): Promise<void> {
		const admin = await this.connect('postgres', 'mk-e2e-harness-cluster');
		try {
			await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
			await admin.query(`CREATE DATABASE "${database}" TEMPLATE template0`);
		} finally {
			await admin.end();
		}
		const client = await this.connect(database, 'mk-e2e-harness-cluster');
		try {
			const [row] = (await client.query<{ collate: string; ctype: string; ordered: boolean }>('SELECT datcollate AS "collate", datctype AS "ctype", \'a0\' > \'9z\' AS "ordered" FROM pg_database WHERE datname = current_database()')).rows;
			if (row.collate !== 'C.UTF-8' || row.ctype !== 'C.UTF-8' || !row.ordered) throw new Error(`${database} has collation ${JSON.stringify(row)}`);
		} finally {
			await client.end();
		}
	}

	public async cloneDatabase(source: Database, target: Database): Promise<void> {
		const admin = await this.connect('postgres', 'mk-e2e-harness-cluster');
		try {
			await admin.query(`DROP DATABASE IF EXISTS "${target}"`);
			await admin.query(`CREATE DATABASE "${target}" TEMPLATE "${source}" STRATEGY FILE_COPY`);
		} finally {
			await admin.end();
		}
	}

	public async dropDatabase(database: Database): Promise<void> {
		const admin = await this.connect('postgres', 'mk-e2e-harness-cluster');
		try {
			await admin.query(`DROP DATABASE IF EXISTS "${database}"`);
		} finally {
			await admin.end();
		}
	}
}
