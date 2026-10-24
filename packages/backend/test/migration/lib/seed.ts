/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PARTITION_COUNT, ordinalToPrefix, prefixOf, prefixToOrdinal } from '@/misc/partition.js';
import { harnessUrl } from './source-config.js';
import type pg from 'pg';

export const time2000 = 946684800000;

export const prefixSpan = 36 ** 6;

export const unreferenceableNoteId = '0000000000';

const second = 1000;

const minute = 60 * second;

const day = 24 * 60 * minute;

const reactionKinds = ['👍', '❤', '🎉'];

const remoteHosts = ['a.e2e.invalid', 'b.e2e.invalid', 'c.e2e.invalid'];

const pairCacheMax = 16;

type Row = Record<string, unknown>;

type UserKind = 'local' | 'writerLocal' | 'threadLocal' | 'probe' | 'remote' | 'floor' | 'writerRemote' | 'special';

export type SeedUser = {
	id: string;
	t: number;
	kind: UserKind;
	username: string;
	host: string | null;
	isBot: boolean;
	uri: string | null;
};

export type SeedNote = {
	id: string;
	t: number;
	user: SeedUser;
	special: boolean;
	pureRenote: boolean;
	replyId: string | null;
	renoteId: string | null;
	threadId: string | null;
	channelId: string | null;
	visibility: 'public' | 'home' | 'followers' | 'specified';
	uri: string | null;
	row: Row;
	repliesCount: number;
	renoteCount: number;
	reactions: Record<string, number>;
	pairs: string[];
	clippedCount: number;
};

type Unlinked = { replyId: string | null; renoteId: string | null; replyUri: string | null; renoteUri: string | null };

type EdgeCase = {
	id: string;
	kind: 'invertedReply' | 'invertedRenote' | 'invertedQuote' | 'selfReply' | 'selfRenote' | 'chainRoot' | 'chainDescendant' | 'danglingReply' | 'danglingRenote' | 'danglingQuote';
	timing: 'sameMillisecond' | 'sameSecond' | 'earlier' | null;
	renoter: 'bot' | 'self' | 'other' | null;
	original: { replyId: string | null; renoteId: string | null; threadId: string | null };
	expected: { replyId: string | null; renoteId: string | null; threadId: string | null; unlinked: Unlinked | null };
};

export type SeedModel = {
	seed: number;
	scale: number;
	variant: 'main' | 'small';
	now: number;
	populatedPrefixes: string[];
	notesPerPrefix: Record<string, number>;
	reactionsPerPrefix: Record<string, number>;
	users: Record<UserKind, string[]>;
	bots: string[];
	special: { userIds: string[]; noteIds: string[] };
	edgeCases: EdgeCase[];
	counters: Record<string, { repliesCount: { seed: number; expected: number }; renoteCount: { seed: number; expected: number } }>;
	floors: Record<string, string | null>;
	unlinkMutes: { noteId: string; threadId: string; userIds: string[] }[];
};

export type Seed = {
	tables: [string, Row[]][];
	model: SeedModel;
	users: SeedUser[];
	notes: SeedNote[];
};

type SeedOptions = {
	seed: number;
	scale: number;
	now: number;
	variant: 'main' | 'small';
};

export function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export function aid(t: number, noise: number): string {
	return (t - time2000).toString(36).padStart(8, '0') + noise.toString(36).padStart(2, '0');
}

export function prefixStart(ord: number): number {
	return time2000 + ord * prefixSpan;
}

function ordinalOfTime(t: number): number {
	return Math.floor((t - time2000) / prefixSpan);
}

export function localNoteUri(id: string): string {
	return `${harnessUrl}/notes/${id}`;
}

export function generateSeed(options: SeedOptions): Seed {
	const random = mulberry32(options.seed);
	const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
	const chance = (p: number) => random() < p;
	const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
	const token = (length: number) => Array.from({ length }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[int(0, 35)]).join('');
	const ids = new Set<string>();
	const uris = new Set<string>();
	const newId = (t: number): string => {
		for (;;) {
			const id = aid(t, int(0, 1295));
			if (!ids.has(id)) {
				ids.add(id);
				return id;
			}
		}
	};
	const newUri = (host: string, kind: string): string => {
		for (;;) {
			const uri = `https://${host}/${kind}/${token(12)}`;
			if (!uris.has(uri)) {
				uris.add(uri);
				return uri;
			}
		}
	};
	const scaled = (count: number) => count * options.scale;
	const small = options.variant === 'small';
	const now = options.now;
	const latest = now - minute;

	const users: SeedUser[] = [];
	const addUser = (kind: UserKind, username: string, t: number, host: string | null = null, isBot = false): SeedUser => {
		const user: SeedUser = { id: newId(t), t, kind, username, host, isBot, uri: host != null ? `https://${host}/users/${username}` : null };
		users.push(user);
		return user;
	};
	const between = (from: number, to: number) => int(from, to);
	const localFrom = Date.UTC(2020, 0, 1);
	const localTo = Date.UTC(2026, 8, 1);
	const remoteFrom = Date.UTC(2000, 0, 2);
	const remoteTo = Date.UTC(2019, 10, 1);
	const pad = (n: number) => String(n).padStart(2, '0');

	const probe = addUser('probe', 'e2eprobe', Date.UTC(2020, 0, 2));
	for (let i = 1; i <= (small ? 10 : 60); i++) addUser('local', `e2el${pad(i)}`, between(localFrom, localTo));
	if (!small) {
		for (let i = 1; i <= 30; i++) addUser('writerLocal', `e2ewl${pad(i)}`, between(localFrom, localTo));
		for (let i = 1; i <= 10; i++) addUser('threadLocal', `e2etl${pad(i)}`, between(localFrom, localTo));
	}
	for (let i = 1; i <= (small ? 10 : 40); i++) addUser('remote', `e2er${pad(i)}`, i <= 5 ? time2000 + (i + 1) * second : between(remoteFrom, remoteTo), remoteHosts[i % remoteHosts.length]);
	const floorUsers = small ? [] : Array.from({ length: 20 }, (_, i) => addUser('floor', `e2er${pad(41 + i)}`, between(Date.UTC(2026, 4, 1), Date.UTC(2026, 8, 1)), remoteHosts[i % remoteHosts.length]));
	if (!small) {
		for (let i = 1; i <= 30; i++) addUser('writerRemote', `e2ewr${pad(i)}`, between(remoteFrom, remoteTo), remoteHosts[i % remoteHosts.length]);
	}
	const specialUsers = small ? [] : Array.from({ length: 10 }, (_, i) => addUser('special', `e2es${pad(i + 1)}`, time2000 + minute + i * second, remoteHosts[i % remoteHosts.length], i >= 8));
	const specialAuthors = specialUsers.filter(user => !user.isBot);
	const specialBots = specialUsers.filter(user => user.isBot);
	const regularUsers = users.filter(user => user.kind !== 'special' && user.kind !== 'floor');
	const localUsers = users.filter(user => user.host == null);
	const usersById = new Map(users.map(user => [user.id, user]));

	const currentOrdinal = ordinalOfTime(now - day);
	const recentOrdinals = Array.from({ length: small ? 10 : 12 }, (_, i) => currentOrdinal - (small ? 9 : 11) + i);
	const midOrdinals = small ? [] : Array.from({ length: 88 }, (_, i) => currentOrdinal - 99 + i);
	const oldOrdinals = small ? [] : ['00', '20', '40', '5a', '61', '6x', '78'].map(prefixToOrdinal);
	const perPrefix = (ord: number) => scaled(small ? 20 : recentOrdinals.includes(ord) ? 600 : midOrdinals.includes(ord) ? 140 : 40);

	const drafts: { ord: number; t: number }[] = [];
	for (const ord of [...oldOrdinals, ...midOrdinals, ...recentOrdinals]) {
		const from = Math.max(prefixStart(ord), time2000 + 10 * minute);
		const to = Math.min(prefixStart(ord + 1) - 1, latest);
		for (let i = 0; i < perPrefix(ord); i++) drafts.push({ ord, t: between(from, to) });
	}
	drafts.sort((a, b) => a.t - b.t);

	const folders: Row[] = [];
	const files: Row[] = [];
	const filesByUser = new Map<string, Row[]>();
	if (!small) {
		for (let i = 0; i < 50; i++) {
			const owner = pick(localUsers);
			folders.push({ id: newId(between(owner.t + second, latest)), name: `e2e-folder-${i}`, userId: owner.id, parentId: null });
		}
		for (let i = 0; i < 1000; i++) {
			const owner = pick(localUsers);
			const ownFolders = folders.filter(folder => folder.userId === owner.id);
			const accessKey = token(32);
			const file: Row = {
				id: newId(between(owner.t + second, latest)),
				userId: owner.id,
				userHost: null,
				md5: token(32).replace(/[g-z]/g, 'a'),
				name: `e2e-${i}.png`,
				type: 'image/png',
				size: int(1024, 5 * 1024 * 1024),
				storedInternal: true,
				url: `${harnessUrl}/files/${accessKey}`,
				accessKey,
				thumbnailAccessKey: chance(0.7) ? `thumbnail-${token(32)}` : null,
				webpublicAccessKey: chance(0.7) ? `webpublic-${token(32)}` : null,
				folderId: ownFolders.length > 0 && chance(0.5) ? pick(ownFolders).id : null,
				isLink: chance(0.1),
			};
			files.push(file);
			filesByUser.set(owner.id, [...(filesByUser.get(owner.id) ?? []), file]);
		}
	}

	const channelOwners = localUsers.filter(user => user.t < Date.UTC(2020, 5, 1));
	const channels: Row[] = small ? [] : Array.from({ length: 10 }, (_, i) => {
		const owner = pick(channelOwners);
		return { id: newId(between(owner.t + second, Date.UTC(2020, 6, 1))), userId: owner.id, name: `e2e-channel-${i}`, notesCount: 0, usersCount: 0, pinnedNoteIds: [] as string[], lastNotedAt: null as string | null };
	});

	const notes: SeedNote[] = [];
	const notesById = new Map<string, SeedNote>();
	const parentsByOrdinal = new Map<number, SeedNote[]>();
	const parentOrdinals: number[] = [];
	const tags = Array.from({ length: 20 }, (_, i) => `e2etag${pad(i)}`);
	const tagUsers = new Map<string, Set<string>>();

	const eligible = (pool: SeedUser[], t: number) => pool.filter(user => user.t < t);
	const remoteNoteUri = (user: SeedUser) => newUri(user.host!, 'notes');
	const createNote = (id: string, t: number, user: SeedUser, special: boolean): SeedNote => {
		const uri = user.host != null ? remoteNoteUri(user) : null;
		const note: SeedNote = {
			id, t, user, special, pureRenote: false, replyId: null, renoteId: null, threadId: null, channelId: null, visibility: 'public', uri,
			row: {
				id, userId: user.id, userHost: user.host, uri, url: uri, visibility: 'public', text: null,
				replyId: null, renoteId: null, threadId: null, replyUserId: null, replyUserHost: null, renoteUserId: null, renoteUserHost: null, renoteChannelId: null, channelId: null,
				hasPoll: false, fileIds: [], attachedFileTypes: [], mentions: [], mentionedRemoteUsers: '[]', visibleUserIds: [], tags: [], emojis: [],
			},
			repliesCount: 0, renoteCount: 0, reactions: {}, pairs: [], clippedCount: 0,
		};
		notes.push(note);
		notesById.set(id, note);
		return note;
	};
	const setReply = (note: SeedNote, parent: SeedNote | { id: string; threadId: string | null; user: SeedUser | null }) => {
		note.replyId = parent.id;
		note.threadId = parent.threadId ?? parent.id;
		Object.assign(note.row, { replyId: parent.id, threadId: note.threadId, replyUserId: parent.user?.id ?? null, replyUserHost: parent.user?.host ?? null });
		const existing = notesById.get(parent.id);
		if (existing != null) existing.repliesCount++;
	};
	const setRenote = (note: SeedNote, target: SeedNote | { id: string; user: SeedUser | null; channelId: string | null }, quote: boolean) => {
		note.renoteId = target.id;
		note.pureRenote = !quote;
		Object.assign(note.row, { renoteId: target.id, renoteUserId: target.user?.id ?? null, renoteUserHost: target.user?.host ?? null, renoteChannelId: target.channelId });
		if (quote) note.row.text = `e2e:quote:${note.id}`;
		const existing = notesById.get(target.id);
		if (existing != null && !note.user.isBot && existing.user.id !== note.user.id) existing.renoteCount++;
	};
	const decorate = (note: SeedNote) => {
		const v = random();
		note.visibility = note.pureRenote ? (v < 0.9 ? 'public' : 'home') : v < 0.8 ? 'public' : v < 0.9 ? 'home' : v < 0.97 ? 'followers' : 'specified';
		note.row.visibility = note.visibility;
		if (!note.pureRenote) {
			note.row.text ??= `e2e:seed:${note.id}`;
			const mentioned = chance(0.1) ? Array.from(new Set([pick(regularUsers), pick(regularUsers)])).filter(user => user.t < note.t) : [];
			const visible = note.visibility === 'specified' ? Array.from(new Set([...mentioned, pick(regularUsers)])).filter(user => user.t < note.t) : [];
			const noteTags = chance(0.1) ? Array.from(new Set([pick(tags), pick(tags)])) : [];
			for (const tag of noteTags) tagUsers.set(tag, new Set([...(tagUsers.get(tag) ?? []), note.user.id]));
			Object.assign(note.row, {
				mentions: mentioned.map(user => user.id),
				mentionedRemoteUsers: JSON.stringify(mentioned.filter(user => user.host != null).map(user => ({ uri: user.uri, username: user.username, host: user.host }))),
				visibleUserIds: visible.map(user => user.id),
				tags: noteTags,
				emojis: chance(0.05) ? ['e2e_emoji'] : [],
				text: `${String(note.row.text)}${noteTags.map(tag => ` #${tag}`).join('')}`,
			});
		}
	};

	const floorDrafts = new Map<number, SeedUser>();
	for (const user of floorUsers) {
		const older = drafts.map((draft, i) => ({ draft, i })).filter(({ draft, i }) => draft.t < user.t && !floorDrafts.has(i));
		for (let k = 0; k < 3 && older.length > 0; k++) floorDrafts.set(older.splice(int(0, older.length - 1), 1)[0].i, user);
	}

	drafts.forEach((draft, i) => {
		const r = random();
		let type = r < 0.6 ? 'plain' : r < 0.75 ? 'reply' : r < 0.85 ? 'renote' : r < 0.9 ? 'quote' : r < 0.93 ? 'channel' : r < 0.96 ? 'poll' : 'files';
		const id = newId(draft.t);
		const locals = eligible(regularUsers.filter(user => user.host == null), draft.t);
		const remotes = eligible(regularUsers.filter(user => user.host != null), draft.t);
		let author = floorDrafts.get(i);
		if (author == null) {
			const local = locals.length > 0 && (type === 'channel' || type === 'files' || remotes.length === 0 || chance(0.55));
			author = local ? pick(locals) : pick(remotes);
		}
		if ((type === 'channel' && (author.host != null || channels.length === 0 || channels.every(channel => (channel.id as string) > id))) || (type === 'files' && (filesByUser.get(author.id) ?? []).length === 0)) type = 'plain';
		const note = createNote(id, draft.t, author, false);
		const earlierSame = parentsByOrdinal.get(draft.ord) ?? [];
		const olderOrdinals = parentOrdinals.filter(ord => ord < draft.ord);
		if (type === 'reply') {
			const parent = earlierSame.length > 0 && (olderOrdinals.length === 0 || chance(0.5)) ? pick(earlierSame) : olderOrdinals.length > 0 ? pick(parentsByOrdinal.get(pick(olderOrdinals))!) : null;
			if (parent != null && parent.id < id) setReply(note, parent);
		} else if (type === 'renote' || type === 'quote') {
			const ords = parentOrdinals.filter(ord => ord <= draft.ord);
			const pool = ords.length > 0 ? parentsByOrdinal.get(pick(ords))! : [];
			const target = pool.length > 0 ? pick(pool) : null;
			if (target != null && target.id < id) setRenote(note, target, type === 'quote');
		} else if (type === 'channel') {
			const channel = pick(channels.filter(row => (row.id as string) < id));
			note.channelId = channel.id as string;
			note.row.channelId = channel.id;
			channel.notesCount = (channel.notesCount as number) + 1;
			channel.lastNotedAt = new Date(draft.t).toISOString();
		} else if (type === 'poll') {
			note.row.hasPoll = true;
		} else if (type === 'files') {
			const own = filesByUser.get(author.id)!;
			const attached = Array.from(new Set([pick(own), pick(own)]));
			note.row.fileIds = attached.map(file => file.id);
			note.row.attachedFileTypes = attached.map(file => file.type);
		}
		decorate(note);
		if (!note.pureRenote) {
			if (!parentsByOrdinal.has(draft.ord)) {
				parentsByOrdinal.set(draft.ord, []);
				parentOrdinals.push(draft.ord);
			}
			parentsByOrdinal.get(draft.ord)!.push(note);
		}
	});
	const generalNotes = [...notes];

	const edgeCases: EdgeCase[] = [];
	const counterNotes = new Set<SeedNote>();
	const edgeOrdinals = small ? recentOrdinals : [...midOrdinals, ...recentOrdinals];
	const edgeTime = () => between(prefixStart(edgeOrdinals[0]) + day, latest - 2 * day);
	const parentAuthor = (t: number, i: number) => {
		const preferred = eligible(regularUsers.filter(user => (i % 2 === 0) === (user.host == null)), t);
		return pick(preferred.length > 0 ? preferred : eligible(regularUsers, t));
	};
	const pairAt = (childT: number, parentT: number): [string, string] => {
		for (;;) {
			const a = int(0, 1295);
			const b = int(0, 1295);
			const child = aid(childT, Math.min(a, b));
			const parent = aid(parentT, Math.max(a, b));
			if (child < parent && !ids.has(child) && !ids.has(parent)) {
				ids.add(child);
				ids.add(parent);
				return [child, parent];
			}
		}
	};
	const timings = (count: number) => Array.from({ length: count }, (_, i) => (i < count * 5 / 12 ? 'sameMillisecond' : i < count * 10 / 12 ? 'sameSecond' : 'earlier') as EdgeCase['timing']);
	const invertedPair = (timing: EdgeCase['timing'], index: number): { childT: number; parentT: number; child: string; parent: string } => {
		const parentT = edgeTime();
		const childT = timing === 'sameMillisecond' ? parentT
			: timing === 'sameSecond' ? Math.floor(parentT / second) * second
			: parentT - (index % 4 === 0 ? between(26 * day, 60 * day) : between(minute, 10 * day));
		const [child, parent] = pairAt(childT, timing === 'sameSecond' && childT === parentT ? parentT + 1 : parentT);
		return { childT, parentT: timing === 'sameSecond' && childT === parentT ? parentT + 1 : parentT, child, parent };
	};
	const record = (note: SeedNote, kind: EdgeCase['kind'], timing: EdgeCase['timing'], renoter: EdgeCase['renoter']) => {
		edgeCases.push({ id: note.id, kind, timing, renoter, original: { replyId: note.replyId, renoteId: note.renoteId, threadId: note.threadId }, expected: { replyId: note.replyId, renoteId: note.renoteId, threadId: note.threadId, unlinked: null } });
	};

	if (small) {
		timings(12).forEach((timing, i) => {
			const pair = invertedPair(timing, i);
			const parent = createNote(pair.parent, pair.parentT, parentAuthor(pair.parentT, i), false);
			decorate(parent);
			const child = createNote(pair.child, pair.childT, pick(eligible(regularUsers, pair.childT)), false);
			if (i % 2 === 0) setReply(child, parent);
			else setRenote(child, parent, i % 4 === 1);
			decorate(child);
		});
	} else {
		timings(120).forEach((timing, i) => {
			const pair = invertedPair(timing, i);
			const parent = createNote(pair.parent, pair.parentT, parentAuthor(pair.parentT, i), true);
			decorate(parent);
			const child = createNote(pair.child, pair.childT, pick(specialAuthors), true);
			setReply(child, parent);
			decorate(child);
			counterNotes.add(parent);
			record(child, 'invertedReply', timing, null);
		});
		timings(60).forEach((timing, i) => {
			const pair = invertedPair(timing, i);
			const renoter: EdgeCase['renoter'] = i % 10 === 2 || i % 10 === 3 ? 'bot' : i % 10 === 6 || i % 10 === 7 ? 'self' : 'other';
			const author = renoter === 'bot' ? pick(specialBots) : pick(specialAuthors);
			const parent = createNote(pair.parent, pair.parentT, renoter === 'self' ? author : parentAuthor(pair.parentT, i), true);
			decorate(parent);
			const child = createNote(pair.child, pair.childT, author, true);
			const quote = i % 2 === 1;
			setRenote(child, parent, quote);
			decorate(child);
			counterNotes.add(parent);
			record(child, quote ? 'invertedQuote' : 'invertedRenote', timing, renoter);
		});
		for (let i = 0; i < 3; i++) {
			const t = edgeTime();
			const id = newId(t);
			const note = createNote(id, t, pick(specialAuthors), true);
			if (i < 2) {
				setReply(note, note);
			} else {
				setRenote(note, note, false);
			}
			decorate(note);
			counterNotes.add(note);
			record(note, i < 2 ? 'selfReply' : 'selfRenote', null, i < 2 ? null : 'self');
		}
		for (let i = 0; i < 10; i++) {
			const pair = invertedPair(timings(10)[i], i);
			const parent = createNote(pair.parent, pair.parentT, parentAuthor(pair.parentT, i), true);
			decorate(parent);
			const root = createNote(pair.child, pair.childT, pick(specialAuthors), true);
			setReply(root, parent);
			decorate(root);
			counterNotes.add(parent);
			counterNotes.add(root);
			record(root, 'chainRoot', timings(10)[i], null);
			let previous = root;
			for (let depth = 0; depth < 3; depth++) {
				const t = Math.min(previous.t + between(second, 2 * day), latest);
				const descendant = createNote(newId(Math.max(t, previous.t + 1)), Math.max(t, previous.t + 1), pick(specialAuthors), true);
				setReply(descendant, previous);
				decorate(descendant);
				counterNotes.add(descendant);
				record(descendant, 'chainDescendant', null, null);
				previous = descendant;
			}
		}
		const populated = [...oldOrdinals, ...midOrdinals, ...recentOrdinals];
		const missingId = () => {
			const ord = pick(populated);
			const t = between(Math.max(prefixStart(ord), time2000 + 10 * minute), Math.min(prefixStart(ord + 1) - 1, latest));
			return newId(t);
		};
		for (let i = 0; i < 160; i++) {
			const t = edgeTime();
			const note = createNote(newId(t), t, pick(specialAuthors), true);
			const missing = missingId();
			const formerAuthor = pick(regularUsers.filter(user => user.host != null));
			if (i < 100) {
				setReply(note, { id: missing, threadId: null, user: formerAuthor });
			} else {
				setRenote(note, { id: missing, user: formerAuthor, channelId: null }, i % 2 === 1);
			}
			decorate(note);
			record(note, i < 100 ? 'danglingReply' : i % 2 === 1 ? 'danglingQuote' : 'danglingRenote', null, null);
		}
	}

	const uriOf = (id: string): string | null => {
		const parent = notesById.get(id);
		if (parent == null) return null;
		return parent.user.host == null ? localNoteUri(id) : parent.uri;
	};
	const expectedReplies = new Map<string, number>();
	const expectedRenotes = new Map<string, number>();
	const unlinkedReplyRoots: string[] = [];
	for (const edge of edgeCases) {
		const note = notesById.get(edge.id)!;
		const replyInverted = note.replyId != null && note.replyId >= note.id;
		const renoteInverted = note.renoteId != null && note.renoteId >= note.id;
		if (!replyInverted && !renoteInverted) continue;
		edge.expected.unlinked = {
			replyId: replyInverted ? note.replyId : null,
			renoteId: renoteInverted ? note.renoteId : null,
			replyUri: replyInverted ? uriOf(note.replyId!) : null,
			renoteUri: renoteInverted ? uriOf(note.renoteId!) : null,
		};
		if (replyInverted) {
			edge.expected.replyId = unreferenceableNoteId;
			edge.expected.threadId = null;
			unlinkedReplyRoots.push(note.id);
			expectedReplies.set(note.replyId!, (expectedReplies.get(note.replyId!) ?? 0) + 1);
		}
		if (renoteInverted) {
			edge.expected.renoteId = unreferenceableNoteId;
			const target = notesById.get(note.renoteId!);
			if (!note.user.isBot && target?.user.id !== note.user.id) expectedRenotes.set(note.renoteId!, (expectedRenotes.get(note.renoteId!) ?? 0) + 1);
		}
	}
	const childrenOf = new Map<string, SeedNote[]>();
	for (const note of notes) {
		if (note.replyId != null && note.replyId !== note.id) childrenOf.set(note.replyId, [...(childrenOf.get(note.replyId) ?? []), note]);
	}
	for (const root of unlinkedReplyRoots) {
		const visited = new Set([root]);
		let frontier = [root];
		while (frontier.length > 0) {
			const next: string[] = [];
			for (const id of frontier) {
				for (const child of childrenOf.get(id) ?? []) {
					if (visited.has(child.id) || (child.replyId != null && child.replyId >= child.id)) continue;
					visited.add(child.id);
					next.push(child.id);
					const edge = edgeCases.find(other => other.id === child.id);
					if (edge != null) edge.expected.threadId = root;
				}
			}
			frontier = next;
		}
	}

	const reactable = generalNotes.filter(note => !note.pureRenote);
	const reactions: Row[] = [];
	const reactionPairs = new Set<string>();
	const reactionTotal = small ? 300 : scaled(30000);
	const probeReactions = small ? 30 : scaled(300);
	for (let i = 0; i < reactionTotal; i++) {
		for (let attempt = 0; attempt < 50; attempt++) {
			const note = pick(reactable);
			const far = chance(0.05) && latest - note.t > 31 * day;
			let t = Math.min(note.t + (far ? between(30 * day, latest - note.t) : Math.round(minute * Math.exp(random() * Math.log(3 * day / minute)))), latest);
			const candidates = i < probeReactions ? [probe] : eligible(regularUsers, t);
			if (candidates.length === 0) continue;
			const user = pick(candidates);
			if (t <= user.t) t = between(user.t + second, latest);
			const key = `${user.id}/${note.id}`;
			if (reactionPairs.has(key) || t <= note.t) continue;
			reactionPairs.add(key);
			reactions.push({ id: newId(t), userId: user.id, noteId: note.id, reaction: pick(reactionKinds) });
			break;
		}
	}
	reactions.sort((a, b) => (a.id as string) < (b.id as string) ? -1 : 1);
	for (const reaction of reactions) {
		const note = notesById.get(reaction.noteId as string)!;
		const kind = reaction.reaction as string;
		note.reactions[kind] = (note.reactions[kind] ?? 0) + 1;
		if (note.pairs.length < pairCacheMax) note.pairs.push(`${reaction.userId as string}/${kind}`);
	}

	const afterBoth = (note: SeedNote, user: SeedUser) => Math.min(Math.max(note.t, user.t) + between(second, 30 * day), latest);
	const uniqueRows = <T>(count: number, make: () => [string, T] | null): T[] => {
		const seen = new Map<string, T>();
		for (let i = 0; seen.size < count && i < count * 20; i++) {
			const made = make();
			if (made != null && !seen.has(made[0])) seen.set(made[0], made[1]);
		}
		return [...seen.values()];
	};
	const localRegular = regularUsers.filter(user => user.host == null);
	const polls = generalNotes.filter(note => note.row.hasPoll === true);
	const votesByNote = new Map<string, number[]>(polls.map(note => [note.id, [0, 0, 0]]));
	const multiple = new Map(polls.map(note => [note.id, chance(0.3)]));
	const pollVotes = small || polls.length === 0 ? [] : uniqueRows(scaled(2000), () => {
		const note = pick(polls);
		const user = pick(regularUsers);
		const choice = int(0, 2);
		const key = multiple.get(note.id) === true ? `${user.id}/${note.id}/${choice}` : `${user.id}/${note.id}`;
		return [key, { id: newId(afterBoth(note, user)), userId: user.id, noteId: note.id, choice }];
	});
	for (const vote of pollVotes) votesByNote.get(vote.noteId)![vote.choice]++;
	const pollRows = polls.map(note => ({ noteId: note.id, expiresAt: null, multiple: multiple.get(note.id), choices: ['A', 'B', 'C'], votes: votesByNote.get(note.id), noteVisibility: note.visibility, userId: note.user.id, userHost: note.user.host, channelId: note.channelId }));

	const favorites = small ? [] : uniqueRows(scaled(1500), () => {
		const note = pick(reactable);
		const user = pick(localRegular);
		return [`${user.id}/${note.id}`, { id: newId(afterBoth(note, user)), userId: user.id, noteId: note.id }];
	});
	const clips = small ? [] : Array.from({ length: 100 }, (_, i) => {
		const user = pick(localRegular);
		return { id: newId(between(user.t + second, latest)), userId: user.id, name: `e2e-clip-${i}`, isPublic: chance(0.5), lastClippedAt: null as string | null };
	});
	const clipNotes = small ? [] : uniqueRows(scaled(1500), () => {
		const note = pick(reactable);
		const clip = pick(clips);
		return [`${note.id}/${clip.id}`, { id: newId(afterBoth(note, usersById.get(clip.userId)!)), noteId: note.id, clipId: clip.id }];
	});
	for (const clipNote of clipNotes) {
		notesById.get(clipNote.noteId)!.clippedCount++;
		const clip = clips.find(row => row.id === clipNote.clipId)!;
		clip.lastClippedAt = new Date(latest).toISOString();
	}
	const pinnings: Row[] = [];
	const pinCounts = new Map<string, number>();
	const ownLocalNotes = generalNotes.filter(note => note.user.host == null);
	for (let i = 0; !small && pinnings.length < 150 && i < 3000; i++) {
		const note = pick(ownLocalNotes);
		if ((pinCounts.get(note.user.id) ?? 0) >= 5 || pinnings.some(pin => pin.noteId === note.id)) continue;
		pinCounts.set(note.user.id, (pinCounts.get(note.user.id) ?? 0) + 1);
		pinnings.push({ id: newId(Math.min(note.t + second, latest)), userId: note.user.id, noteId: note.id });
	}
	const promoNotes = small ? [] : uniqueRows(10, () => {
		const note = pick(reactable.filter(other => other.user.host == null));
		return [note.id, { noteId: note.id, expiresAt: new Date(now + 30 * day).toISOString(), userId: note.user.id }];
	});
	const promoReads = small ? [] : uniqueRows(50, () => {
		const promo = pick(promoNotes);
		const user = pick(localRegular);
		return [`${user.id}/${promo.noteId}`, { id: newId(afterBoth(notesById.get(promo.noteId)!, user)), userId: user.id, noteId: promo.noteId }];
	});
	const threads = [...new Set(generalNotes.flatMap(note => note.threadId != null ? [note.threadId] : []))];
	const threadMutings = small || threads.length === 0 ? [] : uniqueRows(200, () => {
		const user = pick(localRegular);
		const threadId = pick(threads);
		return [`${user.id}/${threadId}`, { id: newId(between(user.t + second, latest)), userId: user.id, threadId }];
	});
	const unlinkMutes = edgeCases.flatMap(edge => ((edge.kind === 'invertedReply' || edge.kind === 'chainRoot') && edge.original.threadId != null && chance(0.5)
		? [{ noteId: edge.id, threadId: edge.original.threadId, users: [...new Set(Array.from({ length: int(1, 2) }, () => pick(localRegular)))] }]
		: []));
	for (const mute of unlinkMutes) {
		for (const user of mute.users) {
			if (!threadMutings.some(row => row.userId === user.id && row.threadId === mute.threadId)) threadMutings.push({ id: newId(between(user.t + second, latest)), userId: user.id, threadId: mute.threadId });
		}
	}
	const noteDrafts = small ? [] : Array.from({ length: 100 }, () => {
		const user = pick(localRegular);
		const live = pick(reactable);
		const missing = aid(between(live.t, latest), int(0, 1295));
		const target = chance(0.5) ? live.id : ids.has(missing) ? live.id : missing;
		const asReply = chance(0.5);
		return { id: newId(between(user.t + second, latest)), userId: user.id, replyId: asReply ? target : null, renoteId: asReply ? null : target, text: 'e2e:draft', visibility: 'public', pollMultiple: false };
	});
	const unreads = small ? [] : uniqueRows(200, () => {
		const note = pick(reactable);
		const user = pick(localRegular);
		return [`${user.id}/${note.id}`, { id: newId(afterBoth(note, user)), userId: user.id, noteId: note.id, noteUserId: note.user.id, isSpecified: false, isMentioned: chance(0.5), noteChannelId: note.channelId }];
	});
	const watchings = small ? [] : uniqueRows(200, () => {
		const note = pick(reactable);
		const user = pick(localRegular);
		const t = afterBoth(note, user);
		return [`${user.id}/${note.id}`, { id: newId(t), createdAt: new Date(t).toISOString(), userId: user.id, noteId: note.id, noteUserId: note.user.id }];
	});
	const channelNotes = generalNotes.filter(note => note.channelId != null);
	const channelPinnings = small || channelNotes.length === 0 ? [] : uniqueRows(10, () => {
		const note = pick(channelNotes);
		return [`${note.channelId}/${note.id}`, { id: newId(Math.min(note.t + second, latest)), createdAt: new Date(Math.min(note.t + second, latest)).toISOString(), channelId: note.channelId, noteId: note.id }];
	});
	for (const channel of channels) {
		const own = channelNotes.filter(note => note.channelId === channel.id);
		channel.pinnedNoteIds = Array.from(new Set(Array.from({ length: Math.min(own.length, int(1, 3)) }, () => pick(own).id)));
	}
	const channelFollowings = small ? [] : uniqueRows(50, () => {
		const channel = pick(channels);
		const user = pick(localRegular);
		return [`${user.id}/${channel.id}`, { id: newId(between(Math.max(user.t, Date.UTC(2020, 6, 2)), latest)), followeeId: channel.id, followerId: user.id }];
	});
	for (const following of channelFollowings) {
		const channel = channels.find(row => row.id === following.followeeId)!;
		channel.usersCount = (channel.usersCount as number) + 1;
	}
	const followings = small ? [] : uniqueRows(600, () => {
		const follower = chance(0.7) ? pick(localRegular) : pick(regularUsers.filter(user => user.host != null));
		const followee = follower.host == null ? pick(regularUsers) : pick(localRegular);
		if (follower.id === followee.id) return null;
		const t = between(Math.max(follower.t, followee.t) + second, latest);
		return [`${follower.id}/${followee.id}`, {
			id: newId(t),
			followerId: follower.id,
			followeeId: followee.id,
			followerHost: follower.host,
			followerInbox: follower.host != null ? `${follower.uri}/inbox` : null,
			followerSharedInbox: follower.host != null ? `https://${follower.host}/inbox` : null,
			followeeHost: followee.host,
			followeeInbox: followee.host != null ? `${followee.uri}/inbox` : null,
			followeeSharedInbox: followee.host != null ? `https://${followee.host}/inbox` : null,
		}];
	});
	const hashtags = [...tagUsers].map(([name, userIds]) => {
		const all = [...userIds];
		const local = all.filter(id => usersById.get(id)!.host == null);
		const remote = all.filter(id => usersById.get(id)!.host != null);
		return {
			id: newId(latest), name,
			mentionedUserIds: all, mentionedUsersCount: all.length,
			mentionedLocalUserIds: local, mentionedLocalUsersCount: local.length,
			mentionedRemoteUserIds: remote, mentionedRemoteUsersCount: remote.length,
			attachedUserIds: [], attachedLocalUserIds: [], attachedRemoteUserIds: [],
		};
	});

	notes.sort((a, b) => a.id < b.id ? -1 : 1);
	const notesCount = new Map<string, number>();
	for (const note of notes) {
		notesCount.set(note.user.id, (notesCount.get(note.user.id) ?? 0) + 1);
		Object.assign(note.row, {
			repliesCount: note.repliesCount,
			renoteCount: note.renoteCount,
			reactions: note.reactions,
			reactionAndUserPairCache: note.pairs,
			clippedCount: note.clippedCount,
		});
	}
	const followersCount = new Map<string, number>();
	const followingCount = new Map<string, number>();
	for (const following of followings) {
		followersCount.set(following.followeeId, (followersCount.get(following.followeeId) ?? 0) + 1);
		followingCount.set(following.followerId, (followingCount.get(following.followerId) ?? 0) + 1);
	}
	const tokens = new Set<string>();
	const userRows = users.map(user => {
		let userToken: string | null = null;
		if (user.host == null) {
			do userToken = token(16); while (tokens.has(userToken));
			tokens.add(userToken);
		}
		return {
			id: user.id,
			username: user.username,
			usernameLower: user.username.toLowerCase(),
			host: user.host,
			uri: user.uri,
			inbox: user.host != null ? `${user.uri}/inbox` : null,
			sharedInbox: user.host != null ? `https://${user.host}/inbox` : null,
			featured: user.host != null ? `${user.uri}/collections/featured` : null,
			token: userToken,
			isBot: user.isBot,
			notesCount: notesCount.get(user.id) ?? 0,
			followersCount: followersCount.get(user.id) ?? 0,
			followingCount: followingCount.get(user.id) ?? 0,
			lastFetchedAt: user.host != null ? new Date(latest).toISOString() : null,
		};
	});
	const profiles = users.map(user => ({ userId: user.id, userHost: user.host, publicReactions: user.kind === 'probe' }));
	if (!small) {
		const favoritedByProbe = new Set(favorites.filter(row => row.userId === probe.id).map(row => row.noteId));
		const spread = [...Map.groupBy(reactable.filter(note => note.visibility === 'public' && ['local', 'remote', 'floor'].includes(note.user.kind) && !favoritedByProbe.has(note.id)), note => prefixOf(note.id)).values()];
		spread.forEach((group, i) => favorites.push({ id: newId(latest - (i + 1) * second), userId: probe.id, noteId: group[group.length - 1].id }));
	}

	const notesPerPrefix: Record<string, number> = {};
	for (const note of notes) notesPerPrefix[prefixOf(note.id)] = (notesPerPrefix[prefixOf(note.id)] ?? 0) + 1;
	const reactionsPerPrefix: Record<string, number> = {};
	for (const reaction of reactions) reactionsPerPrefix[prefixOf(reaction.noteId as string)] = (reactionsPerPrefix[prefixOf(reaction.noteId as string)] ?? 0) + 1;
	const counters: SeedModel['counters'] = {};
	for (const note of counterNotes) {
		counters[note.id] = {
			repliesCount: { seed: note.repliesCount, expected: Math.max(note.repliesCount - (expectedReplies.get(note.id) ?? 0), 0) },
			renoteCount: { seed: note.renoteCount, expected: Math.max(note.renoteCount - (expectedRenotes.get(note.id) ?? 0), 0) },
		};
	}
	const floors: Record<string, string | null> = {};
	for (const user of users.filter(other => other.host != null)) {
		const own = notes.filter(note => note.user.id === user.id).map(note => note.id).sort();
		floors[user.id] = own.length > 0 && own[0] < user.id ? own[0] : null;
	}
	const byKind = (kind: UserKind) => users.filter(user => user.kind === kind).map(user => user.id);

	return {
		users,
		notes,
		model: {
			seed: options.seed,
			scale: options.scale,
			variant: options.variant,
			now,
			populatedPrefixes: Array.from({ length: PARTITION_COUNT }, (_, ord) => ordinalToPrefix(ord)).filter(prefix => notesPerPrefix[prefix] != null),
			notesPerPrefix,
			reactionsPerPrefix,
			users: { local: byKind('local'), writerLocal: byKind('writerLocal'), threadLocal: byKind('threadLocal'), probe: byKind('probe'), remote: byKind('remote'), floor: byKind('floor'), writerRemote: byKind('writerRemote'), special: byKind('special') },
			bots: users.filter(user => user.isBot).map(user => user.id),
			special: { userIds: specialUsers.map(user => user.id), noteIds: notes.filter(note => note.special).map(note => note.id) },
			edgeCases,
			counters,
			floors,
			unlinkMutes: unlinkMutes.map(mute => ({ noteId: mute.noteId, threadId: mute.threadId, userIds: mute.users.map(user => user.id) })),
		},
		tables: [
			['user', userRows],
			['user_profile', profiles],
			['meta', [{ id: 'x', federation: 'all' }]],
			['drive_folder', folders],
			['drive_file', files],
			['channel', channels],
			['channel_following', channelFollowings],
			['following', followings],
			['note', notes.map(note => note.row)],
			['poll', pollRows],
			['poll_vote', pollVotes],
			['note_reaction', reactions],
			['note_favorite', favorites],
			['clip', clips],
			['clip_note', clipNotes],
			['user_note_pining', pinnings],
			['promo_note', promoNotes],
			['promo_read', promoReads],
			['note_thread_muting', threadMutings],
			['note_draft', noteDrafts],
			['note_unread', unreads],
			['note_watching', watchings],
			['channel_note_pining', channelPinnings],
			['hashtag', hashtags],
		],
	};
}

function toText(value: unknown): string | null {
	if (value == null) return null;
	if (Array.isArray(value)) return `{${value.map(item => `"${String(item).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(',')}}`;
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

export async function insertSeed(client: pg.Client, tables: [string, Row[]][]): Promise<void> {
	for (const [table, rows] of tables) {
		if (rows.length === 0) continue;
		const catalog = (await client.query<{ name: string; type: string; notNull: boolean; hasDefault: boolean }>(
			'SELECT attname AS "name", format_type(atttypid, atttypmod) AS "type", attnotnull AS "notNull", atthasdef AS "hasDefault" FROM pg_attribute WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped',
			[`"${table}"`],
		)).rows;
		const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
		const unknown = columns.filter(column => !catalog.some(attribute => attribute.name === column));
		const missing = catalog.filter(attribute => attribute.notNull && !attribute.hasDefault && !columns.includes(attribute.name)).map(attribute => attribute.name);
		if (unknown.length > 0 || missing.length > 0) throw new Error(`the seed of ${table} does not have the shape of HEAD: unknown ${unknown.join(', ')}, missing ${missing.join(', ')}`);
		const types = columns.map(column => catalog.find(attribute => attribute.name === column)!.type);
		const nulls = columns.filter(column => catalog.find(attribute => attribute.name === column)!.notNull && rows.some(row => row[column] == null));
		if (nulls.length > 0) throw new Error(`the seed of ${table} leaves NOT NULL ${nulls.join(', ')} empty`);
		const sql = `INSERT INTO "${table}" (${columns.map(column => `"${column}"`).join(', ')}) SELECT ${columns.map((column, i) => `u."${column}"::${types[i]}`).join(', ')} FROM unnest(${columns.map((_, i) => `$${i + 1}::text[]`).join(', ')}) AS u(${columns.map(column => `"${column}"`).join(', ')})`;
		await client.query('BEGIN');
		try {
			for (let offset = 0; offset < rows.length; offset += 2000) {
				const batch = rows.slice(offset, offset + 2000);
				await client.query(sql, columns.map(column => batch.map(row => toText(row[column]))));
			}
			await client.query('COMMIT');
		} catch (e) {
			await client.query('ROLLBACK');
			throw new Error(`seeding ${table} failed: ${String(e)}`);
		}
	}
}
