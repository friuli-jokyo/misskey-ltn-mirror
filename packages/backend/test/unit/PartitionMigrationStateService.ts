/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import { describe, test, vi } from 'vitest';
import { PartitionMigrationStateService } from '@/core/PartitionMigrationStateService.js';
import type { MiPartitionMigrationState } from '@/models/PartitionMigrationState.js';
import type { PartitionMigrationStatesRepository } from '@/models/_.js';

describe('PartitionMigrationStateService', () => {
	function createService(findOneBy: (where: { name: string }) => Promise<Pick<MiPartitionMigrationState, 'finishedAt'> | null>): PartitionMigrationStateService {
		return new PartitionMigrationStateService({ findOneBy } as unknown as PartitionMigrationStatesRepository);
	}

	test('Calls made while the first check is running get its result instead of an unfinished phase', async () => {
		let release = (): void => {};
		const queried: string[] = [];
		const service = createService(async ({ name }) => {
			queried.push(name);
			await new Promise<void>(resolve => {
				release = resolve;
			});
			return { finishedAt: new Date() };
		});

		const checks = [
			service.isPhaseFinished('noteUriBackfill'),
			service.isPhaseFinished('noteUriBackfill'),
			service.isPhaseFinished('noteUriBackfill'),
		];
		release();

		assert.deepStrictEqual(await Promise.all(checks), [true, true, true]);
		assert.strictEqual(await service.isPhaseFinished('noteUriBackfill'), true);
		assert.deepStrictEqual(queried, ['noteUriBackfill']);
	});

	test('A failed check is retried by the next call instead of reporting an unfinished phase', async () => {
		let failing = true;
		let queries = 0;
		const service = createService(async () => {
			queries++;
			if (failing) throw new Error('connection terminated');
			return { finishedAt: new Date() };
		});

		await assert.rejects(service.isPhaseFinished('noteUriBackfill'), /connection terminated/);
		failing = false;

		assert.strictEqual(await service.isPhaseFinished('noteUriBackfill'), true);
		assert.strictEqual(queries, 2);
	});

	test('An unfinished phase is checked again only after the interval', async () => {
		let finishedAt: Date | null = null;
		let queries = 0;
		const service = createService(async () => {
			queries++;
			return { finishedAt };
		});
		const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

		assert.strictEqual(await service.isPhaseFinished('noteUriBackfill'), false);
		finishedAt = new Date();
		now.mockReturnValue(1_009_999);
		assert.strictEqual(await service.isPhaseFinished('noteUriBackfill'), false);
		assert.strictEqual(queries, 1);

		now.mockReturnValue(1_010_000);
		assert.strictEqual(await service.isPhaseFinished('noteUriBackfill'), true);
		assert.strictEqual(queries, 2);
	});
});
