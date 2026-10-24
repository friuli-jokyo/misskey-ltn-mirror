/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DI } from '@/di-symbols.js';
import type { PartitionMigrationStatesRepository } from '@/models/_.js';
import { bindThis } from '@/decorators.js';

const recheckIntervalMs = 1000 * 10;

@Injectable()
export class PartitionMigrationStateService {
	private finishedPhases = new Set<string>();
	private lastCheckedAt = new Map<string, number>();
	private checks = new Map<string, Promise<boolean>>();

	constructor(
		@Inject(DI.partitionMigrationStatesRepository)
		private partitionMigrationStatesRepository: PartitionMigrationStatesRepository,
	) {
	}

	@bindThis
	public async isPhaseFinished(name: string): Promise<boolean> {
		if (this.finishedPhases.has(name)) return true;
		const lastCheckedAt = this.lastCheckedAt.get(name);
		if (lastCheckedAt != null && Date.now() - lastCheckedAt < recheckIntervalMs) return false;
		let check = this.checks.get(name);
		if (check == null) {
			check = this.checkPhaseFinished(name).finally(() => this.checks.delete(name));
			this.checks.set(name, check);
		}
		return await check;
	}

	@bindThis
	private async checkPhaseFinished(name: string): Promise<boolean> {
		const checkedAt = Date.now();
		const row = await this.partitionMigrationStatesRepository.findOneBy({ name });
		if (row?.finishedAt == null) {
			this.lastCheckedAt.set(name, checkedAt);
			return false;
		}
		this.finishedPhases.add(name);
		return true;
	}
}
