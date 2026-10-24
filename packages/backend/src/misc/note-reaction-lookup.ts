/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { In } from 'typeorm';
import { MiNoteReaction } from '@/models/NoteReaction.js';
import { MiNoteReactionLocator } from '@/models/NoteReactionLocator.js';
import { inspectPartitionCopies } from '@/misc/partition-copies.js';
import { groupByPrefix, isPartitionPrefix, nextPrefix, prefixOf, prefixToOrdinal, prefixesAscending, prefixesDescending } from '@/misc/partition.js';
import type { MiUser } from '@/models/User.js';
import type { DataSource, EntityManager, ObjectLiteral, SelectQueryBuilder } from 'typeorm';

export type NoteReactionRange = {
	sinceId?: MiNoteReaction['id'];
	untilId?: MiNoteReaction['id'];
	ascending: boolean;
	limit: number;
};

async function withLiveNoteReactions<T>(db: DataSource, run: (em: EntityManager, partitioned: boolean) => Promise<T>): Promise<T> {
	return await db.transaction(async em => {
		await em.query('LOCK TABLE ONLY "note_reaction" IN ACCESS SHARE MODE');
		const { partitioned } = await inspectPartitionCopies(em, 'note_reaction');
		return await run(em, partitioned);
	});
}

function inRange<T extends ObjectLiteral>(query: SelectQueryBuilder<T>, range: NoteReactionRange): SelectQueryBuilder<T> {
	if (range.sinceId != null) query.andWhere(`${query.alias}.id > :sinceId`, { sinceId: range.sinceId });
	if (range.untilId != null) query.andWhere(`${query.alias}.id < :untilId`, { untilId: range.untilId });
	return query.orderBy(`${query.alias}.id`, range.ascending ? 'ASC' : 'DESC').limit(range.limit);
}

async function findLocatedUserReactions(em: EntityManager, userId: MiUser['id'], range: NoteReactionRange): Promise<MiNoteReaction[]> {
	const reactions: MiNoteReaction[] = [];
	let page = range;
	for (;;) {
		const located = await inRange(em.createQueryBuilder(MiNoteReactionLocator, 'locator').where('locator.userId = :userId', { userId }), page).getMany();
		for (const noteIds of groupByPrefix(new Set(located.map(row => row.noteId))).values()) {
			const candidates = located.filter(row => noteIds.includes(row.noteId));
			const rows = await em.findBy(MiNoteReaction, { noteId: In(noteIds), id: In(candidates.map(row => row.id)), userId });
			reactions.push(...rows.filter(row => candidates.some(candidate => candidate.id === row.id && candidate.noteId === row.noteId)));
		}
		if (located.length < range.limit || reactions.length >= range.limit) return reactions;
		const last = located[located.length - 1].id;
		page = range.ascending ? { ...page, sinceId: last } : { ...page, untilId: last };
	}
}

export async function findUserNoteReactions(db: DataSource, userId: MiUser['id'], range: NoteReactionRange, nowId: string): Promise<MiNoteReaction[]> {
	const plain = await withLiveNoteReactions(db, async (em, partitioned) => {
		if (partitioned) return null;
		return await inRange(em.createQueryBuilder(MiNoteReaction, 'reaction').where('reaction.userId = :userId', { userId }), range).getMany();
	});
	if (plain != null) return plain;

	if (![userId, range.sinceId, range.untilId].every(id => id == null || isPartitionPrefix(prefixOf(id)))) return [];

	const nowPrefix = prefixOf(nowId);
	const ceiling = nextPrefix(nowPrefix) ?? nowPrefix;
	const floor = prefixOf(userId);
	const lowest = range.sinceId != null && prefixToOrdinal(prefixOf(range.sinceId)) > prefixToOrdinal(floor) ? prefixOf(range.sinceId) : floor;
	const highest = range.untilId == null ? nowPrefix : prefixToOrdinal(prefixOf(range.untilId)) < prefixToOrdinal(ceiling) ? prefixOf(range.untilId) : ceiling;
	const order = (a: MiNoteReaction, b: MiNoteReaction) => (a.id < b.id) === range.ascending ? -1 : 1;

	const reactions = await findLocatedUserReactions(db.manager, userId, range);
	for (const prefix of range.ascending ? prefixesAscending(lowest, highest) : prefixesDescending(highest, lowest)) {
		const upper = nextPrefix(prefix);
		if (reactions.length >= range.limit) {
			const last = reactions.sort(order)[range.limit - 1].id;
			if (range.ascending ? last < prefix : upper != null && upper <= last) break;
		}
		const query = db.createQueryBuilder(MiNoteReaction, 'reaction')
			.where('reaction.noteId >= :lower', { lower: prefix })
			.andWhere('reaction.userId = :userId', { userId })
			.andWhere('reaction.id >= :lower');
		if (upper != null) query.andWhere('reaction.noteId < :upper', { upper }).andWhere('reaction.id < :upper');
		reactions.push(...await inRange(query, range).getMany());
	}
	return reactions.sort(order).slice(0, range.limit);
}

export async function findNoteReactionById(db: DataSource, id: MiNoteReaction['id']): Promise<MiNoteReaction | null> {
	return await withLiveNoteReactions(db, async (em, partitioned) => {
		if (!partitioned) return await em.findOneBy(MiNoteReaction, { id });

		const located = await em.findOneBy(MiNoteReactionLocator, { id });
		if (located != null) {
			const reaction = await em.findOneBy(MiNoteReaction, { noteId: located.noteId, id });
			if (reaction != null) return reaction;
		}

		const prefix = prefixOf(id);
		if (!isPartitionPrefix(prefix)) return null;
		const upper = nextPrefix(prefix);
		const query = em.createQueryBuilder(MiNoteReaction, 'reaction')
			.where('reaction.noteId >= :lower', { lower: prefix })
			.andWhere('reaction.id = :id', { id });
		if (upper != null) query.andWhere('reaction.noteId < :upper', { upper });
		return await query.getOne();
	});
}
