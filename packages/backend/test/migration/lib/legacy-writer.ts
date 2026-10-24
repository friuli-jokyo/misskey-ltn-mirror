/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { appendFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import { aid } from './seed.js';
import type { Seed, SeedNote, SeedUser } from './seed.js';
import type pg from 'pg';

type LegacyNote = { id: string; userId: string; replyId: string | null };

type LegacyResult = {
	ops: Record<string, number>;
	errors: { op: string; code: string | null; message: string }[];
	statements: number;
	longestMs: number;
	longestSql: string | null;
	longestAt: number | null;
	created: string[];
	deleted: string[];
	reactions: string[];
};

const kinds = ['👍', '❤', '🎉'];

export class LegacyWriter {
	private running = false;
	private loop: Promise<void> | null = null;
	private seq = 0;
	private readonly ids = new Set<string>();
	private readonly own: LegacyNote[] = [];
	private readonly pairs: Set<string>;
	private readonly users: SeedUser[];
	private readonly targets: SeedNote[];
	private readonly result: LegacyResult = { ops: {}, errors: [], statements: 0, longestMs: 0, longestSql: null, longestAt: null, created: [], deleted: [], reactions: [] };

	constructor(private client: pg.Client, seed: Seed, private random: () => number, private oplog: string, private stage: string) {
		this.users = seed.users.filter(user => user.kind === 'local');
		this.targets = seed.notes.filter(note => !note.special && !note.pureRenote && note.visibility === 'public');
		this.pairs = new Set((seed.tables.find(([table]) => table === 'note_reaction')?.[1] ?? []).map(row => `${row.userId as string}/${row.noteId as string}`));
	}

	public start(): void {
		this.running = true;
		this.loop = this.run();
	}

	public async stop(): Promise<LegacyResult> {
		this.running = false;
		await this.loop;
		return this.result;
	}

	private pick<T>(items: T[]): T {
		return items[Math.floor(this.random() * items.length)];
	}

	private newId(): string {
		for (;;) {
			const id = aid(Date.now(), Math.floor(this.random() * 1296));
			if (!this.ids.has(id)) {
				this.ids.add(id);
				return id;
			}
		}
	}

	private async query(sql: string, values: unknown[]): Promise<void> {
		const begin = performance.now();
		await this.client.query(sql, values);
		const ms = performance.now() - begin;
		this.result.statements++;
		if (ms > this.result.longestMs) {
			this.result.longestMs = ms;
			this.result.longestSql = sql;
			this.result.longestAt = Date.now();
		}
	}

	private async run(): Promise<void> {
		while (this.running) {
			const begin = Date.now();
			await this.op();
			const rest = 100 - (Date.now() - begin);
			if (rest > 0) await setTimeout(rest);
		}
	}

	private async insertNote(user: SeedUser, columns: Record<string, unknown>): Promise<string> {
		const id = this.newId();
		const values = { id, userId: user.id, userHost: null, visibility: 'public', localOnly: false, ...columns };
		const names = Object.keys(values);
		await this.query(`INSERT INTO "note" (${names.map(name => `"${name}"`).join(', ')}) VALUES (${names.map((_, i) => `$${i + 1}`).join(', ')})`, Object.values(values));
		this.own.push({ id, userId: user.id, replyId: (columns.replyId as string | undefined) ?? null });
		this.result.created.push(id);
		await this.query('UPDATE "user" SET "notesCount" = "notesCount" + 1, "updatedAt" = $2 WHERE "id" = $1', [user.id, new Date()]);
		return id;
	}

	private async op(): Promise<void> {
		const seq = ++this.seq;
		const begin = Date.now();
		const user = this.pick(this.users);
		const r = this.random();
		let op = r < 0.25 ? 'note' : r < 0.4 ? 'reply' : r < 0.5 ? 'renote' : r < 0.85 ? 'reaction' : 'delete';
		if (op === 'delete' && this.own.length === 0) op = 'note';
		const args: Record<string, unknown> = { userId: user.id };
		let result: unknown = null;
		try {
			if (op === 'note') {
				result = await this.insertNote(user, { text: `e2e:legacy:${seq}` });
			} else if (op === 'reply') {
				const parent = this.pick(this.targets);
				args.replyId = parent.id;
				result = await this.insertNote(user, { text: `e2e:legacy:${seq}`, replyId: parent.id, threadId: parent.threadId ?? parent.id, replyUserId: parent.user.id, replyUserHost: parent.user.host });
				await this.query('UPDATE "note" SET "repliesCount" = "repliesCount" + 1 WHERE "id" = $1', [parent.id]);
			} else if (op === 'renote') {
				const target = this.pick(this.targets);
				args.renoteId = target.id;
				result = await this.insertNote(user, { renoteId: target.id, renoteUserId: target.user.id, renoteUserHost: target.user.host, renoteChannelId: target.channelId });
				if (target.user.id !== user.id) await this.query('UPDATE "note" SET "renoteCount" = "renoteCount" + 1 WHERE "id" = $1', [target.id]);
			} else if (op === 'reaction') {
				let target = this.pick(this.targets);
				for (let i = 0; i < 20 && this.pairs.has(`${user.id}/${target.id}`); i++) target = this.pick(this.targets);
				const reaction = this.pick(kinds);
				const id = this.newId();
				args.noteId = target.id;
				this.pairs.add(`${user.id}/${target.id}`);
				await this.query('INSERT INTO "note_reaction" ("id", "noteId", "userId", "reaction") VALUES ($1, $2, $3, $4)', [id, target.id, user.id, reaction]);
				this.result.reactions.push(id);
				await this.query(`UPDATE "note" SET "reactions" = jsonb_set("reactions", '{${reaction}}', (COALESCE("reactions"->>'${reaction}', '0')::int + 1)::text::jsonb), "reactionAndUserPairCache" = CASE WHEN cardinality("reactionAndUserPairCache") < 16 THEN array_append("reactionAndUserPairCache", $2) ELSE "reactionAndUserPairCache" END WHERE "id" = $1`, [target.id, `${user.id}/${reaction}`]);
				result = id;
			} else {
				const note = this.own.splice(Math.floor(this.random() * this.own.length), 1)[0];
				args.noteId = note.id;
				if (note.replyId != null) await this.query('UPDATE "note" SET "repliesCount" = "repliesCount" - 1 WHERE "id" = $1', [note.replyId]);
				await this.query('DELETE FROM "note" WHERE "id" = $1 AND "userId" = $2', [note.id, note.userId]);
				this.result.deleted.push(note.id);
				result = note.id;
			}
			this.result.ops[op] = (this.result.ops[op] ?? 0) + 1;
			appendFileSync(this.oplog, `${JSON.stringify({ seq, t: begin, stage: this.stage, op, args, result, latencyMs: Date.now() - begin })}\n`);
		} catch (e) {
			const error = { op, code: (e as { code?: string }).code ?? null, message: String(e) };
			this.result.errors.push(error);
			appendFileSync(this.oplog, `${JSON.stringify({ seq, t: begin, stage: this.stage, op, args, result, error, latencyMs: Date.now() - begin })}\n`);
		}
	}
}
