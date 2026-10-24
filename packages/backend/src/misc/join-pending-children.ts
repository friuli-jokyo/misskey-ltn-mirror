/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { setTimeout } from 'node:timers/promises';
import type { DataSource, EntityManager } from 'typeorm';
import type { IdService } from '@/core/IdService.js';
import type { MiNote } from '@/models/Note.js';
import type { MiUser } from '@/models/User.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { chunk, unique } from '@/misc/prelude/array.js';
import { groupByPrefix, nextPrefix, prefixOf, prefixesAscending } from '@/misc/partition.js';
import { lockNoteRowsInIdOrder, lockNotesInIdOrder } from '@/misc/note-dependents.js';
import type { LockedNote } from '@/misc/note-dependents.js';

type Queryable = {
	query(query: string, parameters?: unknown[]): Promise<any>;
};

type PendingParent = Pick<MiNote, 'id' | 'userId' | 'userHost' | 'channelId'>;

export type PendingChild = { childId: MiNote['id']; kind: number };

type JoinedRoot = Pick<MiNote, 'id' | 'threadId'>;

type PendingReply = JoinedRoot & { linked: boolean };

type JoinedChild = { id: MiNote['id']; userId: MiNote['userId']; linked: boolean; pure: boolean };

const rekeyRounds = 8;
const rekeyHorizonMs = 1000 * 60 * 60;
const idsPerMillisecond = 36 ** 2;

function chunksByPrefix(ids: MiNote['id'][]): MiNote['id'][][] {
	return [...groupByPrefix(ids).values()].flatMap(group => chunk(group, 100));
}

function placeholders(ids: unknown[], from: number): string {
	return ids.map((_, i) => `$${i + from}`).join(', ');
}

export async function findSiblingIds(q: Queryable, formerId: MiNote['id'], afterId: MiNote['id'], excludeIds: MiNote['id'][]): Promise<MiNote['id'][]> {
	const siblings: { childId: MiNote['id'] }[] = await q.query(
		'SELECT "childId" FROM "note_relation" WHERE "parentId" = $1 AND "kind" = 0 AND "childId" > $2 AND "childId" <> ALL($3) ORDER BY "childId" LIMIT 100',
		[formerId, afterId, excludeIds],
	);
	return siblings.map(sibling => sibling.childId);
}

async function lockChildrenWithSibling(q: Queryable, formerId: MiNote['id'], childIds: MiNote['id'][], withSibling: boolean): Promise<{ locked: LockedNote[]; sibling: LockedNote | undefined }> {
	let rest = unique(childIds).sort();
	let siblingIds = withSibling ? await findSiblingIds(q, formerId, formerId, childIds) : [];
	let sibling: LockedNote | undefined;
	const locked: LockedNote[] = [];
	while (rest.length > 0 || siblingIds.length > 0) {
		if (siblingIds.length > 0 && (rest.length === 0 || siblingIds[0] < rest[0])) {
			const siblingId = siblingIds[0];
			siblingIds.shift();
			sibling = (await lockNoteRowsInIdOrder(q, [siblingId], 'KEY SHARE')).at(0);
			if (sibling != null) {
				siblingIds = [];
			} else if (siblingIds.length === 0) {
				siblingIds = await findSiblingIds(q, formerId, siblingId, childIds);
			}
		} else {
			const bound = siblingIds.at(0);
			const ids = bound != null ? rest.filter(id => id < bound) : rest;
			rest = rest.slice(ids.length);
			locked.push(...await lockNoteRowsInIdOrder(q, ids, 'UPDATE'));
		}
	}
	return { locked, sibling };
}

export async function mutingUserIdsOf(q: Queryable, threadIds: string[]): Promise<MiUser['id'][]> {
	if (threadIds.length === 0) return [];
	const mutings: { userId: MiUser['id'] }[] = await q.query('SELECT DISTINCT "userId" FROM "note_thread_muting" WHERE "threadId" = ANY($1)', [threadIds]);
	return mutings.map(muting => muting.userId);
}

export async function lockMutingUsers(q: Queryable, threadIds: string[]): Promise<MiUser['id'][]> {
	const userIds = await mutingUserIdsOf(q, threadIds);
	if (userIds.length === 0) return [];
	const users: { id: MiUser['id'] }[] = await q.query('SELECT "id" FROM "user" WHERE "id" = ANY($1) ORDER BY "id" FOR KEY SHARE', [userIds]);
	return users.map(user => user.id);
}

export async function copyThreadMutings(q: Queryable, idService: IdService, userIds: MiUser['id'][], fromThreadIds: string[], threadId: string): Promise<void> {
	if (userIds.length === 0 || fromThreadIds.length === 0) return;
	let after = Date.now();
	const mutings: { userId: MiUser['id'] }[] = await q.query('SELECT DISTINCT "userId" FROM "note_thread_muting" WHERE "userId" = ANY($1) AND "threadId" = ANY($2)', [userIds, fromThreadIds]);
	for (const group of chunk(mutings.map(muting => muting.userId), idsPerMillisecond)) {
		while (Date.now() <= after) await setTimeout(1);
		const time = Date.now();
		await q.query(`
			INSERT INTO "note_thread_muting" ("id", "userId", "threadId")
			SELECT v."id", v."userId", $3 FROM unnest($1::varchar[], $2::varchar[]) AS v("id", "userId")
			WHERE EXISTS (SELECT 1 FROM "note_thread_muting" m WHERE m."userId" = v."userId" AND m."threadId" = ANY($4))
			ON CONFLICT ("userId", "threadId") DO NOTHING
		`, [group.map(() => idService.gen(time)), group, threadId, fromThreadIds]);
		after = time;
	}
}

async function pendingChildrenOf(q: Queryable, parentUri: string, childIds: MiNote['id'][]): Promise<PendingChild[]> {
	return await q.query('SELECT "childId", "kind" FROM "note_pending_parent" WHERE "parentUri" = $1 AND "childId" = ANY($2)', [parentUri, childIds]);
}

async function deletePendingRows(q: Queryable, parentUri: string, childIds: MiNote['id'][], keptIds: MiNote['id'][]): Promise<void> {
	await q.query('DELETE FROM "note_pending_parent" WHERE "parentUri" = $1 AND "childId" = ANY($2) AND NOT ("kind" = 0 AND "childId" = ANY($3))', [parentUri, childIds, keptIds]);
}

function resumedRoots(locked: LockedNote[], replyIds: MiNote['id'][], linkedIds: MiNote['id'][]): LockedNote[] {
	return locked.filter(row => replyIds.includes(row.id) && !linkedIds.includes(row.id));
}

async function linkPartitionToParent(q: Queryable, idService: IdService, parent: PendingParent, parentUri: string, children: PendingChild[]): Promise<JoinedRoot[] | null> {
	const childIds = unique(children.map(child => child.childId));
	const mutingUserIds = await lockMutingUsers(q, unique(children.filter(child => child.kind === 0 && child.childId > parent.id).map(child => child.childId)));
	const locked = await lockNoteRowsInIdOrder(q, [parent.id, ...childIds], 'UPDATE');
	const lockedParent = locked.find(row => row.id === parent.id);
	if (lockedParent == null) return null;

	const threadId = lockedParent.threadId ?? lockedParent.id;
	const pendings = await pendingChildrenOf(q, parentUri, childIds);
	const replyIds = unique(pendings.filter(pending => pending.kind === 0).map(pending => pending.childId));
	const renoteIds = unique(pendings.filter(pending => pending.kind !== 0).map(pending => pending.childId));

	const replies: JoinedChild[] = [];
	for (const ids of chunksByPrefix(replyIds)) {
		const [rows]: [JoinedChild[], number] = await q.query(
			`UPDATE "note" SET "replyId" = CASE WHEN "id" > $1 THEN $1 ELSE "replyId" END, "threadId" = CASE WHEN "id" > $1 THEN $2 ELSE "threadId" END, "replyUserId" = $3, "replyUserHost" = $4 WHERE "id" IN (${placeholders(ids, 6)}) AND "replyId" = $5 RETURNING "id", "userId", "id" > $1 AS "linked", false AS "pure"`,
			[parent.id, threadId, parent.userId, parent.userHost, UNREFERENCEABLE_NOTE_ID, ...ids],
		);
		replies.push(...rows);
	}
	const linkedIds = replies.filter(reply => reply.linked).map(reply => reply.id);
	if (linkedIds.length > 0) {
		await q.query(`
			INSERT INTO "note_relation" ("childId", "parentId", "kind")
			SELECT c, $1, 0 FROM unnest($2::varchar[]) AS c
			ON CONFLICT DO NOTHING
		`, [parent.id, linkedIds]);
		await q.query('UPDATE "note" SET "repliesCount" = "repliesCount" + $2 WHERE "id" = $1', [parent.id, linkedIds.length]);
		await copyThreadMutings(q, idService, mutingUserIds, linkedIds, threadId);
	}
	if (replies.length > 0) {
		await q.query('UPDATE "note_relation" SET "parentReplyUserId" = $2, "parentReplyUserHost" = $3 WHERE "parentId" = ANY($1) AND "kind" IN (1, 2)', [replies.map(reply => reply.id), parent.userId, parent.userHost]);
	}

	const renotes: JoinedChild[] = [];
	for (const ids of chunksByPrefix(renoteIds)) {
		const [rows]: [JoinedChild[], number] = await q.query(
			`UPDATE "note" SET "renoteId" = CASE WHEN "id" > $1 THEN $1 ELSE "renoteId" END, "renoteUserId" = $2, "renoteUserHost" = $3, "renoteChannelId" = $4 WHERE "id" IN (${placeholders(ids, 6)}) AND "renoteId" = $5 RETURNING "id", "userId", "id" > $1 AS "linked", ("text" IS NULL AND "cw" IS NULL AND "replyId" IS NULL AND NOT "hasPoll" AND "fileIds" = '{}') AS "pure"`,
			[parent.id, parent.userId, parent.userHost, parent.channelId, UNREFERENCEABLE_NOTE_ID, ...ids],
		);
		renotes.push(...rows);
	}
	const linkedRenotes = renotes.filter(renote => renote.linked);
	if (linkedRenotes.length > 0) {
		await q.query(`
			INSERT INTO "note_relation" ("childId", "parentId", "kind", "parentReplyUserId", "parentReplyUserHost", "parentRenoteUserId", "parentRenoteUserHost")
			SELECT c."id", $1, c."kind", $2, $3, $4, $5 FROM unnest($6::varchar[], $7::smallint[]) AS c("id", "kind")
			ON CONFLICT DO NOTHING
		`, [parent.id, lockedParent.replyUserId, lockedParent.replyUserHost, lockedParent.renoteUserId, lockedParent.renoteUserHost, linkedRenotes.map(renote => renote.id), linkedRenotes.map(renote => (renote.pure ? 2 : 1))]);

		const renoterIds = linkedRenotes.map(renote => renote.userId).filter(userId => userId !== parent.userId);
		if (renoterIds.length > 0) {
			const bots: { id: MiNote['userId'] }[] = await q.query('SELECT "id" FROM "user" WHERE "id" = ANY($1) AND "isBot"', [[...new Set(renoterIds)]]);
			const botIds = new Set(bots.map(bot => bot.id));
			const counted = renoterIds.filter(userId => !botIds.has(userId)).length;
			if (counted > 0) {
				await q.query('UPDATE "note" SET "renoteCount" = "renoteCount" + $2 WHERE "id" = $1', [parent.id, counted]);
			}
		}
	}
	if (renotes.length > 0) {
		await q.query('UPDATE "note_relation" SET "parentRenoteUserId" = $2, "parentRenoteUserHost" = $3 WHERE "parentId" = ANY($1) AND "kind" IN (1, 2)', [renotes.map(renote => renote.id), parent.userId, parent.userHost]);
	}

	const resumed = resumedRoots(locked, replyIds, replies.map(reply => reply.id));
	await deletePendingRows(q, parentUri, childIds, [...linkedIds, ...resumed.map(root => root.id)]);
	return [...linkedIds.map(id => ({ id, threadId })), ...resumed];
}

async function linkPartitionToFormerParent(q: Queryable, idService: IdService, formerId: MiNote['id'], noteUri: string, parentUri: string, children: PendingChild[]): Promise<JoinedRoot[] | null> {
	const childIds = unique(children.map(child => child.childId));
	const linkableReplyIds = unique(children.filter(child => child.kind === 0 && child.childId > formerId).map(child => child.childId));
	const mutingUserIds = await lockMutingUsers(q, linkableReplyIds);
	const { locked, sibling } = await lockChildrenWithSibling(q, formerId, childIds, linkableReplyIds.length > 0);
	const uris: unknown[] = await q.query('SELECT 1 FROM "note_uri" WHERE "uri" = $1 AND "noteId" = $2', [noteUri, formerId]);
	if (uris.length === 0) return null;

	const threadId = sibling?.threadId ?? formerId;
	const pendings = (await pendingChildrenOf(q, parentUri, childIds)).filter(pending => pending.childId > formerId);
	const replyIds = unique(pendings.filter(pending => pending.kind === 0).map(pending => pending.childId));
	const renoteIds = unique(pendings.filter(pending => pending.kind !== 0).map(pending => pending.childId));

	const linkedIds: MiNote['id'][] = [];
	for (const ids of chunksByPrefix(replyIds)) {
		const [rows]: [{ id: MiNote['id'] }[], number] = await q.query(
			`UPDATE "note" SET "replyId" = $1, "threadId" = $3 WHERE "id" IN (${placeholders(ids, 4)}) AND "replyId" = $2 RETURNING "id"`,
			[formerId, UNREFERENCEABLE_NOTE_ID, threadId, ...ids],
		);
		linkedIds.push(...rows.map(row => row.id));
	}
	const renotes: { id: MiNote['id']; pure: boolean }[] = [];
	for (const ids of chunksByPrefix(renoteIds)) {
		const [rows]: [{ id: MiNote['id']; pure: boolean }[], number] = await q.query(
			`UPDATE "note" SET "renoteId" = $1 WHERE "id" IN (${placeholders(ids, 3)}) AND "renoteId" = $2 RETURNING "id", ("text" IS NULL AND "cw" IS NULL AND "replyId" IS NULL AND NOT "hasPoll" AND "fileIds" = '{}') AS "pure"`,
			[formerId, UNREFERENCEABLE_NOTE_ID, ...ids],
		);
		renotes.push(...rows);
	}

	const edges = [...linkedIds.map(id => ({ id, kind: 0 })), ...renotes.map(renote => ({ id: renote.id, kind: renote.pure ? 2 : 1 }))];
	if (edges.length > 0) {
		await q.query(`
			INSERT INTO "note_relation" ("childId", "parentId", "kind")
			SELECT c."id", $1, c."kind" FROM unnest($2::varchar[], $3::smallint[]) AS c("id", "kind")
			ON CONFLICT DO NOTHING
		`, [formerId, edges.map(edge => edge.id), edges.map(edge => edge.kind)]);
	}
	await copyThreadMutings(q, idService, mutingUserIds, linkedIds, threadId);

	const resumed = resumedRoots(locked, replyIds, linkedIds);
	await deletePendingRows(q, parentUri, childIds, [...linkedIds, ...resumed.map(root => root.id)]);
	return [...linkedIds.map(id => ({ id, threadId })), ...resumed];
}

async function linkByPartition(db: DataSource, children: PendingChild[], link: (q: Queryable, children: PendingChild[]) => Promise<JoinedRoot[] | null>): Promise<JoinedRoot[]> {
	const roots: JoinedRoot[] = [];
	for (const childIds of groupByPrefix(unique(children.map(child => child.childId))).values()) {
		const linked = await db.transaction('READ COMMITTED', async transactionalEntityManager => await link(transactionalEntityManager, children.filter(child => childIds.includes(child.childId))));
		if (linked == null) break;
		roots.push(...linked);
	}
	return roots;
}

async function rekeyRound(db: DataSource, keys: Map<MiNote['id'], string>, untilId: MiNote['id']): Promise<boolean> {
	const rootIds = [...keys].filter(([rootId, threadId]) => threadId !== rootId).map(([rootId]) => rootId);
	if (rootIds.length === 0) return false;

	let found = false;
	for (const prefix of prefixesAscending(prefixOf(rootIds.reduce((a, b) => (a < b ? a : b))), prefixOf(untilId))) {
		const upper = nextPrefix(prefix);
		const rows: { id: MiNote['id']; threadId: string }[] = await db.query(
			`SELECT "id", "threadId" FROM "note" WHERE "threadId" = ANY($1) AND "id" >= '${prefix}'${upper != null ? ` AND "id" < '${upper}'` : ''}`,
			[rootIds],
		);
		if (rows.length > 0) found = true;
		for (const [rootId, descendants] of Map.groupBy(rows, row => row.threadId)) {
			for (const ids of chunk(descendants.map(row => row.id), 100)) {
				await db.transaction('READ COMMITTED', async transactionalEntityManager => {
					const root = (await lockNoteRowsInIdOrder(transactionalEntityManager, [rootId], 'KEY SHARE')).at(0);
					if (root != null) keys.set(rootId, root.threadId ?? root.id);
					const lockedIds = await lockNotesInIdOrder(transactionalEntityManager, ids, 'UPDATE');
					if (lockedIds.length === 0) return;
					await transactionalEntityManager.query(
						`UPDATE "note" SET "threadId" = $1 WHERE "id" IN (${placeholders(lockedIds, 3)}) AND "threadId" = $2`,
						[keys.get(rootId), rootId, ...lockedIds],
					);
				});
			}
		}
	}
	return found;
}

export async function rekeyJoinedChildren(db: DataSource, idService: IdService, roots: JoinedRoot[], deadline = Infinity): Promise<boolean> {
	if (roots.length === 0) return true;

	const keys = new Map(roots.map(root => [root.id, root.threadId ?? root.id]));
	for (let round = 0; ; round++) {
		if (round >= rekeyRounds || Date.now() >= deadline) return false;
		if (!await rekeyRound(db, keys, idService.gen(Date.now() + rekeyHorizonMs, true))) break;
	}

	for (const rootIds of groupByPrefix(keys.keys()).values()) {
		await db.transaction('READ COMMITTED', async transactionalEntityManager => {
			const mutingUserIds = await lockMutingUsers(transactionalEntityManager, rootIds);
			for (const root of await lockNoteRowsInIdOrder(transactionalEntityManager, rootIds, 'KEY SHARE')) {
				keys.set(root.id, root.threadId ?? root.id);
			}
			for (const rootId of rootIds) {
				const threadId = keys.get(rootId) ?? rootId;
				if (threadId === rootId || mutingUserIds.length === 0) continue;
				await copyThreadMutings(transactionalEntityManager, idService, mutingUserIds, [rootId], threadId);
				await transactionalEntityManager.query('DELETE FROM "note_thread_muting" WHERE "threadId" = $1 AND "userId" = ANY($2)', [rootId, mutingUserIds]);
			}
			await transactionalEntityManager.query('DELETE FROM "note_pending_parent" WHERE "childId" = ANY($1) AND "kind" = 0', [rootIds]);
		});
	}
	return true;
}

async function findPendingReplies(q: Queryable, noteIds: MiNote['id'][]): Promise<PendingReply[]> {
	if (noteIds.length === 0) return [];

	const pendings: { childId: MiNote['id'] }[] = await q.query('SELECT "childId" FROM "note_pending_parent" WHERE "childId" = ANY($1) AND "kind" = 0', [noteIds]);
	const replies: PendingReply[] = [];
	for (const ids of chunksByPrefix(unique(pendings.map(pending => pending.childId)))) {
		replies.push(...await q.query(`SELECT "id", "threadId", "replyId" <> $1 AS "linked" FROM "note" WHERE "id" IN (${placeholders(ids, 2)})`, [UNREFERENCEABLE_NOTE_ID, ...ids]));
	}
	return replies;
}

async function findRekeyRoots(q: Queryable, noteIds: MiNote['id'][]): Promise<JoinedRoot[]> {
	return (await findPendingReplies(q, noteIds)).filter(reply => reply.linked);
}

export async function findRekeyRootsForUnmuting(q: Queryable, userId: MiUser['id'], noteId: MiNote['id'], threadId: string): Promise<{ roots: JoinedRoot[]; unlinkedIds: MiNote['id'][] }> {
	const mutings: { threadId: string }[] = await q.query('SELECT m."threadId" FROM "note_thread_muting" m JOIN "note_pending_parent" p ON p."childId" = m."threadId" AND p."kind" = 0 WHERE m."userId" = $1', [userId]);
	const replies = await findPendingReplies(q, unique([noteId, threadId, ...mutings.map(muting => muting.threadId)]));
	return {
		roots: replies.filter(reply => reply.linked && (reply.id === noteId || reply.id === threadId || reply.threadId === threadId)),
		unlinkedIds: replies.filter(reply => !reply.linked).map(reply => reply.id),
	};
}

export async function hasReplyEdge(q: Queryable, childIds: MiNote['id'][]): Promise<boolean> {
	if (childIds.length === 0) return false;

	const edges: unknown[] = await q.query('SELECT 1 FROM "note_relation" WHERE "childId" = ANY($1) AND "kind" = 0 LIMIT 1', [childIds]);
	return edges.length > 0;
}

export async function deleteAfterRekey<T>(db: DataSource, idService: IdService, noteIds: MiNote['id'][], run: (transactionalEntityManager: EntityManager, lockedIds: MiNote['id'][]) => Promise<T>): Promise<T> {
	const capped = new Set<MiNote['id']>();
	for (;;) {
		const roots = (await findRekeyRoots(db, noteIds)).filter(root => !capped.has(root.id));
		if (!await rekeyJoinedChildren(db, idService, roots)) {
			for (const root of roots) capped.add(root.id);
		}
		const deletion = await db.transaction('READ COMMITTED', async transactionalEntityManager => {
			const lockedIds = await lockNotesInIdOrder(transactionalEntityManager, noteIds, 'UPDATE');
			if ((await findRekeyRoots(transactionalEntityManager, lockedIds)).some(root => !capped.has(root.id))) return null;
			return { result: await run(transactionalEntityManager, lockedIds) };
		});
		if (deletion != null) return deletion.result;
	}
}

export async function joinChildrenToParent(db: DataSource, idService: IdService, parent: PendingParent, parentUri: string, children: PendingChild[], deadline = Infinity): Promise<void> {
	const roots = await linkByPartition(db, children, (q, group) => linkPartitionToParent(q, idService, parent, parentUri, group));
	await rekeyJoinedChildren(db, idService, roots, deadline);
}

async function joinChildrenToFormerParent(db: DataSource, idService: IdService, formerId: MiNote['id'], noteUri: string, parentUri: string, children: PendingChild[], deadline: number): Promise<void> {
	const roots = await linkByPartition(db, children, (q, group) => linkPartitionToFormerParent(q, idService, formerId, noteUri, parentUri, group));
	await rekeyJoinedChildren(db, idService, roots, deadline);
}

export async function sweepPendingParents(db: DataSource, idService: IdService, deadline: number): Promise<boolean> {
	while (Date.now() < deadline) {
		const rows: { parentUri: string; childId: MiNote['id']; kind: number; parentId: MiNote['id']; noteUri: string }[] = await db.query(`
			SELECT p."parentUri" AS "parentUri", p."childId" AS "childId", p."kind" AS "kind", u."noteId" AS "parentId", u."uri" AS "noteUri"
			FROM "note_pending_parent" p
			JOIN "note_uri" u ON u."uri" IN (p."parentUri", regexp_replace(p."parentUri", '^(https?://)', '\\1www.'))
			LIMIT 200
		`);
		if (rows.length === 0) return true;

		const parentIds = [...new Set(rows.map(row => row.parentId))];
		const parentById = new Map<MiNote['id'], PendingParent>();
		for (const group of groupByPrefix(parentIds).values()) {
			const parents: PendingParent[] = await db.query(
				`SELECT "id", "userId", "userHost", "channelId" FROM "note" WHERE "id" IN (${placeholders(group, 1)})`,
				group,
			);
			for (const parent of parents) parentById.set(parent.id, parent);
		}

		for (const group of Map.groupBy(rows, row => `${row.parentId} ${row.parentUri}`).values()) {
			const parent = parentById.get(group[0].parentId);
			if (parent != null) {
				await joinChildrenToParent(db, idService, parent, group[0].parentUri, group, deadline);
			} else {
				await joinChildrenToFormerParent(db, idService, group[0].parentId, group[0].noteUri, group[0].parentUri, group, deadline);
			}
		}
	}
	return false;
}
