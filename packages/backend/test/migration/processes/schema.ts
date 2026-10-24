/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DataSource } from 'typeorm';
import { migrationClass, ours, oursFrom } from '../lib/expected.js';
import { assertDataSource, emit, installHandlers, loadGuardedConfig } from './common.js';

installHandlers();

const [task, arg] = process.argv.slice(2) as [string, string | undefined];

function baseMigrations(): string[] {
	const dir = join(process.cwd(), 'migration');
	return readdirSync(dir).filter(file => file.endsWith('.js')).sort().flatMap(file => {
		const path = join(dir, file);
		const name = migrationClass.exec(readFileSync(path, 'utf-8'))?.[1];
		if (name == null) throw new Error(`${path} has no migration class`);
		return Number(name.slice(-13)) < oursFrom && !ours.includes(name) ? [path] : [];
	});
}

function migrationsOf(): string[] {
	switch (task) {
		case 'base': return baseMigrations();
		case 'self-fk-upstream': return [join(process.cwd(), 'test', 'migration', 'fixtures', '1753868431598-remove_note_constraints.js')];
		case 'deploy': case 'check': return ['migration/*.js'];
		case 'fixture': if (arg != null) return [arg]; break;
	}
	throw new Error(`unknown task ${task} ${arg ?? ''}`);
}

try {
	if (process.env.MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY != null) throw new Error('MISSKEY_MIGRATION_CREATE_INDEX_CONCURRENTLY is set');
	const migrations = migrationsOf();
	const config = await loadGuardedConfig();
	const { entities } = await import('@/postgres.js');
	const dataSource = new DataSource({
		type: 'postgres',
		host: config.db.host,
		port: config.db.port,
		username: config.db.user,
		password: config.db.pass,
		database: config.db.db,
		extra: config.db.extra,
		entities,
		migrations,
		migrationsTransactionMode: 'all',
	});
	dataSource.setOptions({ subscribers: [], synchronize: false, migrationsRun: false, dropSchema: false });
	await dataSource.initialize();
	try {
		await assertDataSource(dataSource);
		if (process.env.MK_E2E_SCHEMA_WAIT === '1') {
			const go = new Promise<void>(resolve => createInterface({ input: process.stdin }).on('line', line => {
				if (line.trim() === 'go') resolve();
			}));
			emit({ type: 'ready' });
			await go;
		}
		if (task === 'check') {
			const { upQueries, downQueries } = await dataSource.driver.createSchemaBuilder().log();
			emit({ type: 'result', task, up: upQueries.map(query => query.query), down: downQueries.map(query => query.query) });
		} else {
			const executed = (await dataSource.runMigrations({ transaction: 'all' })).map(migration => migration.name);
			if (task === 'deploy' && JSON.stringify(executed) !== JSON.stringify(ours)) throw new Error(`deploy executed ${executed.join(', ')}`);
			emit({ type: 'result', task, executed, files: task === 'base' ? migrations : undefined });
		}
	} finally {
		await dataSource.destroy();
	}
} catch (e) {
	emit({ type: 'error', message: String(e), code: (e as { code?: unknown }).code ?? null, stack: e instanceof Error ? e.stack : undefined });
	process.exitCode = 1;
}

setTimeout(() => process.exit(), 1000).unref();
