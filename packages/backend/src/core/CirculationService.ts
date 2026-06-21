/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { bindThis } from '@/decorators.js';
import { DI } from '@/di-symbols.js';
import { MiNote, MiUser } from '@/models/_.js';
import { Inject, Injectable } from '@nestjs/common';
import * as Redis from 'ioredis';
import ActiveUsersChart from './chart/charts/active-users.js';
import NotesChart from './chart/charts/notes.js';
import PerUserNotesChart from './chart/charts/per-user-notes.js';
import { NoteEntityService } from './entities/NoteEntityService.js';
import { GlobalEventService } from './GlobalEventService.js';
import { IdService } from './IdService.js';

const PHI = 0.5 * (Math.sqrt(5) + 1);
const EE = Math.E * Math.E;
const eeWeight: number[] = [1, 1];

function _fillFactorical(n: number): number {
	return eeWeight[n] ??= n * _fillFactorical(n - 1);
}

_fillFactorical(29);
for (let i = 0; i < eeWeight.length; i++) {
	eeWeight[i] = 2 ** i / eeWeight[i];
}

@Injectable()
export class CirculationService {
	constructor(
		@Inject(DI.redis)
		private redis: Redis.Redis,

		private globalEventService: GlobalEventService,
		private idService: IdService,
		private activeUsersChart: ActiveUsersChart,
		private perUserNotesChart: PerUserNotesChart,
		private notesChart: NotesChart,
		private noteEntityService: NoteEntityService,
	) {
	}

	@bindThis
	public async onNote(note: MiNote, user: MiUser): Promise<void> {
		if (note.visibility !== 'public' || note.channelId || note.anonymouslySendToUserId || note.userHost) {
			return;
		}
		await this.promote(note, user);
		await this.stock(note, user);
	}

	@bindThis
	protected async promote(note: MiNote, user: MiUser): Promise<void> {
		const [totalLastHour, { write }] = await Promise.all([
			this.notesChart.getChartRaw('hour', 2, null),
			this.activeUsersChart.getChartRaw('day', 2, null),
		]);
		const totalCurrentHour =
			// @ts-expect-error
			this.notesChart.buffer
				.reduce((a, c) => a + (c.diff['local.inc'] ?? 0) + (c.diff.promote ?? 0), 0);
		const total = totalLastHour['local.inc'][0] + totalLastHour['local.inc'][1] + totalLastHour.promote[0] + totalLastHour.promote[1] + totalCurrentHour;
		let p = 1 - PHI ** (1 / PHI - await this.emaOf(user) * (write[0] + write[1]) / total / 19.2);
		for (let i = 1; Math.random() < (p /= Math.E); i++) {
			await this.draw(this.periodOf(note), total / i);
		}
	}

	@bindThis
	protected async stock(note: MiNote, user: MiUser): Promise<void> {
		if (note.cw || note.localOnly || note.replyId || note.renoteId || user.isBot || user.makeNotesFollowersOnlyBefore != null || user.makeNotesHiddenBefore != null || this.idService.parse(user.id).date.valueOf() > this.idService.parse(note.id).date.valueOf() - 2628e6) {
			return;
		}
		const [notes, activeUsers] = await Promise.all([
			this.notesChart.getChartRaw('day', 2, null),
			this.activeUsersChart.getChartRaw('day', 2, null),
		]);
		if (notes['local.inc'][1] / activeUsers['write'][1] / await this.emaOf(user) < Math.random()) {
			return;
		}
		const stockKey = `circulation:stock:${this.periodOf(note)}`;
		const saddResult = await this.redis.sadd(stockKey, note.id);
		if (saddResult === 1) {
			await this.redis.expire(stockKey, 864e2);
		}
	}

	@bindThis
	protected async draw(period: number, pressure: number): Promise<void> {
		// @ts-expect-error
		if (await this.redis.get('circulation:pool:period') != period) {
			const multi = this.redis.multi();
			multi.set(`circulation:pool:period`, period);
			multi.del('circulation:pool:account');
			multi.rpush('circulation:pool:account', 1);
			await multi.exec();
		}
		const account = (await this.redis.lrange('circulation:pool:account', 0, -1)).map((v) => Math.max(0, parseInt(v, 10)));
		const remaining = account.reduce((a, c) => a + c, 0);
		let r = Math.random() * remaining;
		const targetIndex = account.findIndex((v) => (r -= v) < 0);
		if (targetIndex >= 0) {
			await this.redis.lset('circulation:pool:account', targetIndex, account[targetIndex] - 1);
			const targetStockKey = `circulation:stock:${period - targetIndex - 2}`;
			const noteId = await this.redis.srandmember(targetStockKey);
			if (noteId) {
				const note = await this.noteEntityService.pack(noteId, null, { skipHide: true });
				setTimeout(() => {
					this.globalEventService.publishCirculationStream(note);
					const multi = this.redis.multi()
					multi.zadd('circulation:stream', Date.now(), note.id);
					multi.zremrangebyscore('circulation:stream', 0, Date.now() - 864e5);
					multi.exec();
				}, Math.min(6e4, 36e5 / pressure * Math.random()));
				this.notesChart.promote();
				this.perUserNotesChart.promote({ id: note.userId });
			}
		}
		if (remaining <= 1) {
			const pipeline = this.redis.pipeline();
			for (let i = account.length + 2; i > 1; i--) {
				pipeline.scard(`circulation:stock:${period - i}`);
			}
			const [weights, stockCounts] = await Promise.all([
				this.notesChart.getChartRaw('hour', account.length + 1, new Date((period - 2) * 36e5)).then((chart) => chart['local.inc'].toReversed()),
				pipeline.exec().then((res) => res?.map(([err, res]) => err ? 0 : res as number) ?? Array.from({ length: account.length + 1 }, () => 1)),
			]);
			const weightAverage = weights.reduce((a, c) => a + c, 0) / weights.length;
			if (!(weightAverage > 0)) {
				return;
			}
			const stockCountAverage = stockCounts.reduce((a, c) => a + c, 0) / stockCounts.length;
			if (!(stockCountAverage > 0)) {
				return;
			}
			const multi = this.redis.multi();
			multi.del('circulation:pool:account');
			multi.lpush('circulation:pool:account', ...Array.from({ length: weights.length }, (_, i) => Math.ceil(2 ** i * weights[i] / weightAverage * stockCounts[i] / stockCountAverage)));
			await multi.exec();
		}
	}

	@bindThis
	protected async emaOf(user: MiUser): Promise<number> {
		const cachedEma = await this.redis.get(`circulation:ema:${user.id}`);
		if (cachedEma) {
			return parseFloat(cachedEma);
		}
		const { inc } = await this.perUserNotesChart.getChartRaw('day', 30, null, user.id);
		const ema = inc.filter((v) => v).reduce((a, c, i) => a + c * eeWeight[i], 0) / EE;
		await this.redis.set(`circulation:ema:${user.id}`, ema.toString(), 'EX', 864e2);
		return ema;
	}

	@bindThis
	protected periodOf(note: MiNote): number {
		return Math.floor(this.idService.parse(note.id).date.valueOf() / 36e5);
	}
}
