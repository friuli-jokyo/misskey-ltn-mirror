/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { appendFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { setTimeout } from 'node:timers/promises';
import { In, QueryFailedError } from 'typeorm';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { ClipService } from '@/core/ClipService.js';
import { IdService } from '@/core/IdService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { NotePiningService } from '@/core/NotePiningService.js';
import { PollService } from '@/core/PollService.js';
import { ReactionService } from '@/core/ReactionService.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { nextPrefix, prefixOf, prefixToOrdinal } from '@/misc/partition.js';
import { EndpointsModule } from '@/server/api/EndpointsModule.js';
import { ApiError } from '@/server/api/error.js';
import type { ChannelsRepository, ClipNotesRepository, ClipsRepository, MiChannel, MiNote, MiUser, NoteThreadMutingsRepository, NotesRepository, PollVotesRepository, UserNotePiningsRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { mulberry32, prefixSpan, prefixStart, time2000 } from '../lib/seed.js';
import { bootstrap, captureNow, emit, installHandlers, settled } from './common.js';
import type { SeedModel } from '../lib/seed.js';
import type { DataSource } from 'typeorm';

type Endpoint = { exec: (params: Record<string, unknown>, user: MiLocalUser, token: null) => Promise<unknown> };

type Args = Record<string, unknown>;

type ThreadStep = 'reply' | 'mute' | 'unmute';

type ThreadNote = { id: string; userId: string; local: boolean };

type Thread = { childId: string; childUserId: string; parentUri: string; parentT: number; oldest: boolean; notes: ThreadNote[]; muted: MiLocalUser[]; plan: ThreadStep[]; nextSeq: number; afterSeq: number };

type Step = [string, (args: Args, text: string) => Promise<unknown>];

type CreateData = Parameters<NoteCreateService['create']>[1];

installHandlers();

const writer = process.env.MK_E2E_WRITER === 'b' ? 'b' : 'a';
const name = (process.env.PGAPPNAME ?? `mk-e2e-writer-${writer}-0`).replace(/^mk-e2e-/, '');
const runDir = process.env.MK_E2E_RUN_DIR!;
const random = mulberry32(Number(process.env.MK_E2E_WRITER_SEED ?? '1'));
const interval = 1000 / Number(process.env.MK_E2E_WRITER_RATE ?? '15');
const oplog = join(runDir, 'oplog', `${name}.jsonl`);
const reactionKinds = ['👍', '❤', '🎉'];
const hosts = ['a.e2e.invalid', 'b.e2e.invalid', 'c.e2e.invalid'];
const second = 1000;
const minute = 60 * second;
const day = 24 * 60 * minute;
const oldestPerProcess = 3;
const shares: [string, number][] = writer === 'a'
	? [['reactionCreate', 0.34], ['reactionDelete', 0.12], ['localNote', 0.35], ['noteDelete', 0.09], ['dependent', 0.10]]
	: [['reactionCreate', 0.36], ['reactionDelete', 0.12], ['remoteNote', 0.25], ['pendingReply', 0.06], ['noteDelete', 0.10], ['dependent', 0.11]];

let stage = process.env.MK_E2E_STAGE ?? 'S2';
let paused = false;
let stopping = false;
let wake: (() => void) | null = null;

const int = (min: number, max: number) => min + Math.floor(random() * (max - min + 1));
const chance = (p: number) => random() < p;
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
const token = (length: number) => Array.from({ length }, () => '0123456789abcdefghijklmnopqrstuvwxyz'[int(0, 35)]).join('');

function errorInfo(e: unknown): Record<string, unknown> {
	const error = e as { name?: string; message?: string; code?: unknown; id?: unknown; driverError?: { code?: string } } | null;
	const clipError = ([['NoSuchNoteError', ClipService.NoSuchNoteError], ['NoSuchClipError', ClipService.NoSuchClipError], ['AlreadyAddedError', ClipService.AlreadyAddedError], ['TooManyClipNotesError', ClipService.TooManyClipNotesError]] as const)
		.find(([, type]) => e instanceof type)?.[0];
	return {
		class: clipError != null ? `ClipService.${clipError}` : e instanceof IdentifiableError ? 'IdentifiableError' : e instanceof ApiError ? 'ApiError' : e instanceof QueryFailedError ? 'QueryFailedError' : (e as object | null)?.constructor?.name ?? typeof e,
		name: error?.name ?? null,
		message: error?.message ?? String(e),
		code: typeof error?.code === 'string' ? error.code : null,
		identifiableId: e instanceof IdentifiableError || e instanceof ApiError ? error?.id ?? null : null,
		sqlState: e instanceof QueryFailedError ? error?.driverError?.code ?? null : null,
	};
}

createInterface({ input: process.stdin }).on('line', line => {
	const [command, arg] = line.trim().split(/\s+/);
	if (command === 'pause') paused = true;
	if (command === 'stop') stopping = true;
	if (command === 'stage' && arg != null) stage = arg;
	wake?.();
});

try {
	const model = JSON.parse(readFileSync(join(runDir, 'artifacts', 'seed-model.json'), 'utf-8')) as SeedModel;
	const app = await bootstrap([GlobalModule, EndpointsModule]);
	const db = app.get<DataSource>(DI.db);
	const idService = app.get(IdService);
	const noteCreateService = app.get(NoteCreateService);
	const noteDeleteService = app.get(NoteDeleteService);
	const reactionService = app.get(ReactionService);
	const notePiningService = app.get(NotePiningService);
	const clipService = app.get(ClipService);
	const pollService = app.get(PollService);
	const notesRepository = app.get<NotesRepository>(DI.notesRepository);
	const usersRepository = app.get<UsersRepository>(DI.usersRepository);
	const channelsRepository = app.get<ChannelsRepository>(DI.channelsRepository);
	const clipsRepository = app.get<ClipsRepository>(DI.clipsRepository);
	const clipNotesRepository = app.get<ClipNotesRepository>(DI.clipNotesRepository);
	const userNotePiningsRepository = app.get<UserNotePiningsRepository>(DI.userNotePiningsRepository);
	const pollVotesRepository = app.get<PollVotesRepository>(DI.pollVotesRepository);
	const noteThreadMutingsRepository = app.get<NoteThreadMutingsRepository>(DI.noteThreadMutingsRepository);
	const favoritesCreate = app.get<Endpoint>('ep:notes/favorites/create');
	const favoritesDelete = app.get<Endpoint>('ep:notes/favorites/delete');
	const threadMutingCreate = app.get<Endpoint>('ep:notes/thread-muting/create');
	const threadMutingDelete = app.get<Endpoint>('ep:notes/thread-muting/delete');

	const special = new Set(model.special.noteIds);
	const specialUsers = new Set(model.special.userIds);
	const actorIds = writer === 'a' ? model.users.writerLocal : model.users.writerRemote;
	const actors = await usersRepository.findBy({ id: In(actorIds) });
	const visibleCandidates = await usersRepository.findBy({ id: In([...model.users.local, ...model.users.remote]) });
	const channels: MiChannel[] = writer === 'a' ? await channelsRepository.find() : [];
	const threadUsers = writer === 'b' ? await usersRepository.findBy({ id: In(model.users.threadLocal) }) as MiLocalUser[] : [];

	let seq = 0;
	let current: MiNote[] = [];
	let older: MiNote[] = [];
	let own: MiNote[] = [];
	const reactions: { noteId: string; userId: string }[] = [];
	const favorites: { noteId: string; userId: string }[] = [];
	const clipped: { clipId: string; noteId: string; userId: string }[] = [];
	const threads: Thread[] = [];
	const threadNoteIds = new Set<string>();
	let oldestStarted = 0;
	let partitioned = { at: 0, value: false };

	const notesIn = async (prefix: string, where: string, parameters: Record<string, unknown>, take: number, skip: number): Promise<MiNote[]> => {
		const upper = nextPrefix(prefix);
		const query = notesRepository.createQueryBuilder('note').where('note.id >= :lower', { lower: prefix });
		if (upper != null) query.andWhere('note.id < :upper', { upper });
		return await query.andWhere(where, parameters).orderBy('note.id', 'ASC').take(take).skip(skip).getMany();
	};

	const usable = (note: MiNote) => !special.has(note.id) && !specialUsers.has(note.userId) && (writer === 'a' || !note.localOnly);

	const visible = { visibilities: ['public', 'home'] };

	const refresh = async () => {
		const now = prefixOf(idService.gen());
		const offset = (prefix: string) => int(0, Math.max(0, (model.notesPerPrefix[prefix] ?? 0) - 100));
		current = (await notesIn(now, 'note.visibility IN (:...visibilities)', visible, 100, offset(now))).filter(usable);
		const olderNotes: MiNote[] = [];
		for (let i = 0; i < 3; i++) {
			const prefix = pick(model.populatedPrefixes.filter(other => other !== now));
			olderNotes.push(...(await notesIn(prefix, 'note.visibility IN (:...visibilities)', visible, 100, offset(prefix))).filter(usable));
		}
		older = olderNotes;
		own = [...own.slice(-200), ...(await notesIn(pick(model.populatedPrefixes), 'note.userId IN (:...userIds)', { userIds: actorIds }, 200, 0)).filter(note => usable(note) && !threadNoteIds.has(note.id))];
	};

	const target = (reactable: boolean): MiNote | null => {
		const pool = (chance(0.7) && current.length > 0 ? current : older).filter(note => !reactable || note.renoteId == null || note.text != null || note.cw != null || note.replyId != null || note.hasPoll || note.fileIds.length > 0);
		return pool.length > 0 ? pick(pool) : null;
	};

	const actorOf = (userId: string): MiUser => actors.find(actor => actor.id === userId)!;

	const marker = () => `e2e:${name}:${seq}`;

	const remoteTime = (after: number | null): number => {
		const latest = Date.now() - minute;
		if (after != null && chance(0.9)) return Math.min(latest, after + int(1000, 30 * day));
		const ord = prefixToOrdinal(pick(model.populatedPrefixes));
		return int(Math.max(time2000 + 10 * minute, prefixStart(ord)), Math.min(prefixStart(ord) + prefixSpan - 1, latest));
	};

	const remoteCreate = async (user: MiUser, createdAt: number, extra: CreateData): Promise<MiNote> => {
		const uri = extra.uri ?? `https://${user.host}/notes/${token(16)}`;
		return await noteCreateService.create(user, { createdAt: new Date(createdAt), visibility: 'public', uri, url: uri, apMentions: [], apHashtags: [], apEmojis: [], ...extra });
	};

	const ops: Record<string, (args: Args) => Promise<unknown>> = {
		reactionCreate: async args => {
			const note = target(true);
			if (note == null) return 'noTarget';
			const user = pick(actors);
			Object.assign(args, { noteId: note.id, userId: user.id, reaction: pick(reactionKinds) });
			await reactionService.create(user, note, args.reaction as string);
			reactions.push({ noteId: note.id, userId: user.id });
			const [row]: { id: string }[] = await db.query('SELECT "id" FROM "note_reaction" WHERE "noteId" = $1 AND "userId" = $2', [note.id, user.id]);
			return row?.id ?? null;
		},
		reactionDelete: async args => {
			if (reactions.length === 0) return 'noTarget';
			const { noteId, userId } = reactions.splice(int(0, reactions.length - 1), 1)[0];
			Object.assign(args, { noteId, userId });
			const note = await notesRepository.findOneBy({ id: noteId });
			if (note == null) return 'noteGone';
			await reactionService.delete(actorOf(userId), note);
			return 'deleted';
		},
		localNote: async args => {
			const user = pick(actors);
			const parent = target(false);
			const r = random();
			const kind = parent == null || r < 0.4 ? 'plain' : r < 0.6 ? 'reply' : r < 0.7 ? 'renote' : r < 0.8 ? 'quote' : r < 0.88 ? 'poll' : r < 0.95 ? 'channel' : 'specified';
			const data: CreateData = { visibility: 'public' };
			if (kind !== 'renote') data.text = marker();
			if (kind === 'reply') data.reply = parent;
			if (kind === 'renote' || kind === 'quote') data.renote = parent;
			if (kind === 'poll') data.poll = { choices: ['a', 'b', 'c'], multiple: chance(0.3), expiresAt: null };
			if (kind === 'channel' && channels.length > 0) data.channel = pick(channels);
			if (kind === 'specified') {
				data.visibility = 'specified';
				data.visibleUsers = [pick(visibleCandidates)];
			}
			Object.assign(args, { kind, userId: user.id, replyId: data.reply?.id ?? null, renoteId: data.renote?.id ?? null, text: data.text ?? null });
			const note = await noteCreateService.create(user, data);
			own.push(note);
			return note.id;
		},
		remoteNote: async args => {
			const user = pick(actors);
			const parent = target(false);
			const r = random();
			const kind = parent == null || r < 0.4 ? 'plain' : r < 0.7 ? 'reply' : r < 0.85 ? 'renote' : 'quote';
			const createdAt = remoteTime(parent != null && kind !== 'plain' ? idService.parse(parent.id).date.getTime() : null);
			const data: CreateData = {};
			if (kind !== 'renote') data.text = marker();
			if (kind === 'reply') data.reply = parent;
			if (kind === 'renote' || kind === 'quote') data.renote = parent;
			Object.assign(args, { kind, userId: user.id, createdAt, replyId: data.reply?.id ?? null, renoteId: data.renote?.id ?? null, text: data.text ?? null });
			const note = await remoteCreate(user, createdAt, data);
			own.push(note);
			return note.id;
		},
		pendingReply: async args => await startThread(args, marker(), false),
		noteDelete: async args => {
			const candidates = own.filter(note => actorIds.includes(note.userId) && !threadNoteIds.has(note.id));
			if (candidates.length === 0) return 'noTarget';
			const picked = pick(candidates);
			own = own.filter(note => note.id !== picked.id);
			args.noteId = picked.id;
			const note = await notesRepository.findOneBy({ id: picked.id });
			if (note == null) return 'noteGone';
			Object.assign(args, { userId: note.userId, uri: note.uri });
			await noteDeleteService.delete(actorOf(note.userId), note);
			return 'deleted';
		},
		dependent: async args => {
			const user = pick(actors);
			const me = user as MiLocalUser;
			const r = random();
			if (writer === 'b' || r < 0.15) {
				args.kind = 'vote';
				const polls = [...current, ...older].filter(note => note.hasPoll);
				if (polls.length === 0) return 'noTarget';
				const note = pick(polls);
				Object.assign(args, { noteId: note.id, userId: user.id, choice: int(0, 2) });
				if ((await pollVotesRepository.findBy({ noteId: note.id, userId: user.id })).length > 0) return 'alreadyVoted';
				await pollService.vote(user, note, args.choice as number);
				return 'voted';
			}
			if (r < 0.4) {
				args.kind = 'favorite';
				const note = target(false);
				if (note == null) return 'noTarget';
				Object.assign(args, { noteId: note.id, userId: user.id });
				await favoritesCreate.exec({ noteId: note.id }, me, null);
				favorites.push({ noteId: note.id, userId: user.id });
				return 'favorited';
			}
			if (r < 0.5) {
				args.kind = 'unfavorite';
				const index = favorites.findIndex(favorite => favorite.userId === user.id);
				if (index < 0) return 'noTarget';
				const [{ noteId }] = favorites.splice(index, 1);
				Object.assign(args, { noteId, userId: user.id });
				await favoritesDelete.exec({ noteId }, me, null);
				return 'unfavorited';
			}
			if (r < 0.65) {
				const pins = await userNotePiningsRepository.findBy({ userId: user.id });
				if (pins.length >= 5) {
					const pin = pick(pins);
					Object.assign(args, { kind: 'unpin', noteId: pin.noteId, userId: user.id });
					await notePiningService.removePinned(user, pin.noteId);
					return 'unpinned';
				}
				args.kind = 'pin';
				const candidates = own.filter(note => note.userId === user.id && !pins.some(pin => pin.noteId === note.id));
				if (candidates.length === 0) return 'noTarget';
				const note = pick(candidates);
				Object.assign(args, { noteId: note.id, userId: user.id });
				await notePiningService.addPinned(user, note.id);
				return 'pinned';
			}
			if (r < 0.85) {
				const mine = clipped.filter(clip => clip.userId === user.id);
				if (mine.length > 0 && chance(0.4)) {
					const clip = pick(mine);
					clipped.splice(clipped.indexOf(clip), 1);
					Object.assign(args, { kind: 'unclip', clipId: clip.clipId, noteId: clip.noteId, userId: user.id });
					await clipService.removeNote(me, clip.clipId, clip.noteId);
					return 'unclipped';
				}
				args.kind = 'clip';
				const note = target(false);
				if (note == null) return 'noTarget';
				const clips = await clipsRepository.findBy({ userId: user.id });
				const clip = clips.length > 0 ? pick(clips) : await clipService.create(me, `e2e-${name}-${seq}`, false, null);
				Object.assign(args, { clipId: clip.id, noteId: note.id, userId: user.id });
				if (await clipNotesRepository.exists({ where: { clipId: clip.id, noteId: note.id } })) return 'alreadyClipped';
				await clipService.addNote(me, clip.id, note.id);
				clipped.push({ clipId: clip.id, noteId: note.id, userId: user.id });
				return 'clipped';
			}
			args.kind = 'threadMute';
			const note = target(false);
			if (note == null) return 'noTarget';
			Object.assign(args, { noteId: note.id, userId: user.id, threadId: note.threadId ?? note.id });
			if (await noteThreadMutingsRepository.exists({ where: { userId: user.id, threadId: note.threadId ?? note.id } })) return 'alreadyMuted';
			await threadMutingCreate.exec({ noteId: note.id }, me, null);
			return 'muted';
		},
	};

	const isPartitioned = async (fresh: boolean): Promise<boolean> => {
		if (fresh || Date.now() - partitioned.at > 2000) {
			const rows: { kind: string }[] = await db.query('SELECT "relkind" AS "kind" FROM "pg_class" WHERE "relnamespace" = \'public\'::regnamespace AND "relname" = \'note\'');
			partitioned = { at: Date.now(), value: rows.at(0)?.kind === 'p' };
		}
		return partitioned.value;
	};

	const threadPlan = (oldest: boolean): ThreadStep[] => {
		if (oldest) return ['reply', 'reply', 'reply', 'mute', 'mute'];
		if (threadUsers.length === 0 || !chance(0.5)) return [];
		const mutes = int(0, 2);
		return [...Array.from({ length: int(1, 3) }, () => 'reply' as const), ...Array.from({ length: mutes }, () => 'mute' as const), ...(mutes > 0 && chance(0.2) ? ['unmute' as const] : [])];
	};

	const startThread = async (args: Args, text: string, oldest: boolean): Promise<string> => {
		const user = pick(actors);
		const parentUri = `https://${pick(hosts)}/notes/${token(16)}`;
		const parentT = oldest ? time2000 + int(2 * day, 10 * day) : remoteTime(null);
		const createdAt = oldest ? parentT + int(second, day) : Math.min(Date.now() - minute, parentT + int(1000, 2 * day));
		const plan = threadPlan(oldest);
		Object.assign(args, { userId: user.id, createdAt, parentUri, parentT, text, oldest, plan, ...(oldest ? { partitioned: true } : {}) });
		if (oldest) oldestStarted++;
		const note = await remoteCreate(user, createdAt, { text, unresolvedReplyUri: parentUri });
		if (plan.length > 0) threadNoteIds.add(note.id);
		else own.push(note);
		threads.push({ childId: note.id, childUserId: user.id, parentUri, parentT, oldest, notes: [], muted: [], plan, nextSeq: seq + (oldest ? 1 : int(2, 8)), afterSeq: seq + (oldest ? plan.length + 1 : plan.length * 5 + int(5, 50)) });
		return note.id;
	};

	const threadTargets = (thread: Thread): ThreadNote[] => [{ id: thread.childId, userId: thread.childUserId, local: false }, ...thread.notes];

	const threadReply = async (args: Args, text: string, thread: Thread, local: boolean): Promise<unknown> => {
		const target = pick(threadTargets(thread));
		Object.assign(args, { childId: thread.childId, targetId: target.id, local, text });
		const parent = await notesRepository.findOneBy({ id: target.id });
		if (parent == null) return 'targetGone';
		const user = local ? pick(threadUsers) : pick(actors);
		args.userId = user.id;
		let note: MiNote;
		if (local) {
			note = await noteCreateService.create(user, { text, reply: parent, visibility: 'public' });
		} else {
			const createdAt = Date.now();
			args.createdAt = createdAt;
			note = await remoteCreate(user, createdAt, { text, reply: parent });
		}
		thread.notes.push({ id: note.id, userId: user.id, local });
		threadNoteIds.add(note.id);
		return note.id;
	};

	const threadMute = async (args: Args, thread: Thread): Promise<unknown> => {
		const users = threadUsers.filter(user => !thread.muted.includes(user));
		if (users.length === 0) return 'noTarget';
		const user = pick(users);
		const target = pick(threadTargets(thread));
		Object.assign(args, { childId: thread.childId, noteId: target.id, userId: user.id, via: target.id === thread.childId ? 'child' : 'reply' });
		await threadMutingCreate.exec({ noteId: target.id }, user, null);
		thread.muted.push(user);
		return 'muted';
	};

	const threadUnmute = async (args: Args, thread: Thread): Promise<unknown> => {
		if (thread.muted.length === 0) return 'noTarget';
		const user = pick(thread.muted);
		const target = pick(threadTargets(thread));
		Object.assign(args, { childId: thread.childId, noteId: target.id, userId: user.id, via: target.id === thread.childId ? 'child' : 'reply' });
		await threadMutingDelete.exec({ noteId: target.id }, user, null);
		thread.muted = thread.muted.filter(other => other !== user);
		return 'unmuted';
	};

	const threadDelete = async (args: Args, thread: Thread, role: 'child' | 'reply'): Promise<unknown> => {
		const candidates = role === 'child' ? threadTargets(thread).slice(0, 1) : thread.notes;
		if (candidates.length === 0) return 'noTarget';
		const target = pick(candidates);
		Object.assign(args, { noteId: target.id, childId: thread.childId, role, thread: true });
		const note = await notesRepository.findOneBy({ id: target.id });
		if (note == null) return 'noteGone';
		Object.assign(args, { userId: note.userId, uri: note.uri });
		const author = [...actors, ...threadUsers].find(user => user.id === note.userId);
		if (author == null) return 'noAuthor';
		await noteDeleteService.delete(author, note);
		thread.notes = thread.notes.filter(other => other.id !== target.id);
		return 'deleted';
	};

	const joinSteps = (thread: Thread): Step[] => {
		if (!thread.oldest && thread.notes.length === 0 && thread.muted.length === 0) return [];
		const steps: Step[] = Array.from({ length: thread.oldest ? 2 : int(0, 2) }, () => ['joinReply', async (args, text) => await threadReply(args, text, thread, chance(0.5))]);
		if (thread.muted.length > 0 && (thread.oldest || chance(0.6))) steps.push(['joinUnmute', async args => await threadUnmute(args, thread)]);
		if (chance(thread.oldest ? 0.7 : 0.3)) steps.push(['noteDelete', async args => await threadDelete(args, thread, thread.notes.length > 0 && chance(0.6) ? 'reply' : 'child')]);
		return steps;
	};

	const parentArrives = async (args: Args, text: string, thread: Thread): Promise<string> => {
		threads.splice(threads.indexOf(thread), 1);
		const user = pick(actors);
		Object.assign(args, { userId: user.id, createdAt: thread.parentT, parentUri: thread.parentUri, childId: thread.childId, text, oldest: thread.oldest, ...(thread.oldest ? { partitioned: await isPartitioned(true) } : {}) });
		const note = await remoteCreate(user, thread.parentT, { text, uri: thread.parentUri });
		own.push(note);
		const window = thread.oldest ? 1500 : 250;
		await Promise.all(joinSteps(thread).map(async ([op, run], i) => {
			await setTimeout(int(0, window));
			await perform(op, {}, run, i + 1);
		}));
		return note.id;
	};

	const threadStep = async (): Promise<Step | null> => {
		if (writer !== 'b') return null;
		if (oldestStarted < oldestPerProcess && !threads.some(thread => thread.oldest) && await isPartitioned(false)) return ['pendingReply', async (args, text) => await startThread(args, text, true)];
		const planned = threads.find(thread => thread.plan.length > 0 && thread.nextSeq <= seq);
		if (planned != null) {
			const [step] = planned.plan.splice(0, 1);
			planned.nextSeq = seq + (planned.oldest ? 1 : int(2, 8));
			if (step === 'reply') {
				const local = planned.oldest ? planned.notes.length % 2 === 1 : chance(0.5);
				return ['waitingReply', async (args, text) => await threadReply(args, text, planned, local)];
			}
			return step === 'mute' ? ['waitingMute', async args => await threadMute(args, planned)] : ['waitingUnmute', async args => await threadUnmute(args, planned)];
		}
		const ready = threads.find(thread => thread.plan.length === 0 && thread.afterSeq <= seq);
		return ready != null ? ['pendingParent', async (args, text) => await parentArrives(args, text, ready)] : null;
	};

	const reconcile = async (op: string, args: Args, begin: number): Promise<unknown> => {
		if (['localNote', 'remoteNote', 'pendingReply', 'pendingParent', 'waitingReply', 'joinReply'].includes(op) && typeof args.userId === 'string') {
			const at = typeof args.createdAt === 'number' ? args.createdAt : begin;
			const found: string[] = [];
			for (const prefix of new Set([prefixOf(idService.gen(at)), prefixOf(idService.gen(Math.max(at, Date.now())))])) {
				const upper = nextPrefix(prefix);
				const condition = args.text != null ? '"text" LIKE $3' : '"renoteId" = $3';
				const values = [prefix, args.userId, args.text != null ? `${String(args.text)}%` : args.renoteId];
				const rows: { id: string }[] = upper == null
					? await db.query(`SELECT "id" FROM "note" WHERE "id" >= $1 AND "userId" = $2 AND ${condition}`, values)
					: await db.query(`SELECT "id" FROM "note" WHERE "id" >= $1 AND "id" < $4 AND "userId" = $2 AND ${condition}`, [...values, upper]);
				found.push(...rows.map(row => row.id));
			}
			return found;
		}
		if (op === 'noteDelete' && typeof args.noteId === 'string') {
			const rows: unknown[] = await db.query('SELECT 1 FROM "note" WHERE "id" = $1', [args.noteId]);
			return rows.length === 0 ? 'deleted' : 'exists';
		}
		if ((op === 'reactionCreate' || op === 'reactionDelete') && typeof args.noteId === 'string') {
			const [row]: { id: string }[] = await db.query('SELECT "id" FROM "note_reaction" WHERE "noteId" = $1 AND "userId" = $2', [args.noteId, args.userId]);
			return row?.id ?? null;
		}
		return null;
	};

	const perform = async (op: string, args: Args, run: (args: Args, text: string) => Promise<unknown>, sub: number | null = null): Promise<void> => {
		const at = seq;
		const begin = captureNow();
		const started = performance.now();
		const text = sub == null ? marker() : `${marker()}.${sub}`;
		let entry: Record<string, unknown>;
		try {
			const result = await run(args, text);
			entry = { seq: at, ...(sub != null ? { sub } : {}), t: begin, stage, op, args, result, latencyMs: performance.now() - started };
		} catch (e) {
			const latencyMs = performance.now() - started;
			let reconciled: unknown;
			try {
				reconciled = await reconcile(op, args, begin);
			} catch (reconcileError) {
				reconciled = { error: String(reconcileError) };
			}
			entry = { seq: at, ...(sub != null ? { sub } : {}), t: begin, stage, op, args, result: null, error: errorInfo(e), reconciled, latencyMs };
		}
		appendFileSync(oplog, `${JSON.stringify(entry)}\n`);
	};

	await refresh();
	emit({ type: 'ready', actors: actors.length });

	while (!stopping) {
		if (paused) {
			emit({ type: 'paused', seq, ...await settled(1000, 2 * 60 * 1000) });
			while (!stopping) await new Promise<void>(resolve => { wake = resolve; });
			break;
		}
		const begin = Date.now();
		seq++;
		if (seq % 200 === 0) {
			try {
				await refresh();
			} catch (e) {
				appendFileSync(oplog, `${JSON.stringify({ seq, t: begin, stage, op: 'refresh', args: {}, result: null, error: errorInfo(e), latencyMs: Date.now() - begin })}\n`);
			}
		}
		let step: Step | null = null;
		try {
			step = await threadStep();
		} catch (e) {
			appendFileSync(oplog, `${JSON.stringify({ seq, t: begin, stage, op: 'threadStep', args: {}, result: null, error: errorInfo(e), latencyMs: Date.now() - begin })}\n`);
		}
		if (step == null) {
			const r = random();
			let sum = 0;
			const op = shares.find(([, share]) => (sum += share) > r)?.[0] ?? 'reactionCreate';
			step = [op, async args => await ops[op](args)];
		}
		await perform(step[0], {}, step[1]);
		const rest = interval - (Date.now() - begin);
		if (rest > 0) await setTimeout(rest);
	}
	emit({ type: 'stopped', seq, ...await settled(1000, 2 * 60 * 1000) });
	process.exit(0);
} catch (e) {
	emit({ type: 'error', message: String(e), stack: e instanceof Error ? e.stack : undefined });
	process.exit(1);
}
