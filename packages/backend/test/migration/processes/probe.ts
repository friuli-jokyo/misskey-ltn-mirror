/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { setTimeout } from 'node:timers/promises';
import Fastify from 'fastify';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { DI } from '@/di-symbols.js';
import { EndpointsModule } from '@/server/api/EndpointsModule.js';
import { ActivityPubServerService } from '@/server/ActivityPubServerService.js';
import type { ClipsRepository, NoteReactionsRepository, UserListsRepository, UserNotePiningsRepository, UsersRepository } from '@/models/_.js';
import type { MiLocalUser } from '@/models/User.js';
import { bootstrap, emit, installHandlers, tagCapture } from './common.js';
import type { ProbeCall, ProbeOutput, ProbeRoute, ProbeTargets } from '../lib/checks.js';

type Endpoint = { exec: (params: Record<string, unknown>, user: MiLocalUser | null, token: null) => Promise<unknown> };

installHandlers();

try {
	if (process.env.MK_E2E_PROBE_TARGETS == null) throw new Error('MK_E2E_PROBE_TARGETS is not set');
	const targets = JSON.parse(readFileSync(process.env.MK_E2E_PROBE_TARGETS, 'utf-8')) as ProbeTargets;
	const startedAt = Date.now();
	const app = await bootstrap([GlobalModule, CoreModule, EndpointsModule], [ActivityPubServerService], true);
	const fastify = Fastify();
	await fastify.register(app.get(ActivityPubServerService).createServer);
	await fastify.ready();
	const usersRepository = app.get<UsersRepository>(DI.usersRepository);
	const userListsRepository = app.get<UserListsRepository>(DI.userListsRepository);
	const clipsRepository = app.get<ClipsRepository>(DI.clipsRepository);
	const noteReactionsRepository = app.get<NoteReactionsRepository>(DI.noteReactionsRepository);
	const userNotePiningsRepository = app.get<UserNotePiningsRepository>(DI.userNotePiningsRepository);
	const me = await usersRepository.findOneByOrFail({ id: targets.probeUserId }) as MiLocalUser;
	const calls: ProbeCall[] = [];
	const routes: ProbeRoute[] = [];

	const call = async (name: string, params: Record<string, unknown>, user: MiLocalUser | null = me): Promise<unknown> => {
		tagCapture(name);
		const begin = performance.now();
		try {
			const result = await app.get<Endpoint>(`ep:${name}`).exec(params, user, null);
			const items = Array.isArray(result) ? result as { id?: unknown }[] : [];
			const object = (result as { object?: { id?: unknown } } | null)?.object;
			calls.push({ name, params, ms: performance.now() - begin, ok: true, ids: items.map(item => item.id).filter((id): id is string => typeof id === 'string'), objectId: typeof object?.id === 'string' ? object.id : null, error: null });
			return result;
		} catch (e) {
			calls.push({ name, params, ms: performance.now() - begin, ok: false, ids: [], objectId: null, error: { id: typeof (e as { id?: unknown }).id === 'string' ? (e as { id: string }).id : null, message: String(e) } });
			return null;
		} finally {
			tagCapture(null);
		}
	};

	const route = async (name: string, url: string): Promise<ProbeRoute> => {
		tagCapture(name);
		const begin = performance.now();
		try {
			const response = await fastify.inject({ method: 'GET', url, headers: { accept: 'application/activity+json' } });
			let body: { type?: unknown; id?: unknown } | null = null;
			try {
				body = JSON.parse(response.body) as { type?: unknown; id?: unknown };
			} catch {
				body = null;
			}
			const result: ProbeRoute = { name, url, ms: performance.now() - begin, status: response.statusCode, type: typeof body?.type === 'string' ? body.type : null, id: typeof body?.id === 'string' ? body.id : null };
			routes.push(result);
			return result;
		} finally {
			tagCapture(null);
		}
	};

	for (const noteId of [...targets.notes, targets.missingNoteId, ...(targets.deletedNoteId != null ? [targets.deletedNoteId] : [])]) await call('notes/show', { noteId });
	await call('notes/show-partial-bulk', { noteIds: targets.spreadNoteIds });
	let list = await userListsRepository.findOneBy({ userId: me.id, name: 'e2e-probe' });
	if (list == null) {
		await call('users/lists/create', { name: 'e2e-probe' });
		list = await userListsRepository.findOneByOrFail({ userId: me.id, name: 'e2e-probe' });
		for (const userId of targets.listUserIds) await call('users/lists/push', { listId: list.id, userId });
	}
	const notifier = await usersRepository.findOneByOrFail({ id: targets.notifications.userId }) as MiLocalUser;
	for (const noteId of targets.notifications.noteIds) await call('notes/reactions/create', { noteId, reaction: '🎉' }, notifier);
	await setTimeout(1000);
	await call('users/notes', { userId: targets.remoteUserId, limit: 100 });
	await call('notes/reactions', { noteId: targets.reactionNoteId, limit: 100 }, null);
	const usersReactions: Record<string, string[]> = {};
	for (const limit of [10, 100]) {
		const ids: string[] = [];
		for (let untilId: string | null = null, page = 0; page < 500; page++) {
			const result = await call('users/reactions', { userId: me.id, limit, ...(untilId != null ? { untilId } : {}) }, null) as { id: string }[] | null;
			if (result == null || result.length === 0) break;
			ids.push(...result.map(reaction => reaction.id));
			untilId = result[result.length - 1].id;
		}
		usersReactions[limit] = ids;
	}
	for (const limit of [20, 100]) {
		await call('notes/timeline', { limit });
		await call('notes/local-timeline', { limit });
		await call('notes/hybrid-timeline', { limit });
		await call('notes/global-timeline', { limit });
		await call('notes/user-list-timeline', { listId: list.id, limit });
		await call('channels/timeline', { channelId: targets.channelId, limit });
		await call('users/notes', { userId: targets.localUserId, limit });
		await call('notes/replies', { noteId: targets.replyParentId, limit });
		await call('notes/renotes', { noteId: targets.renoteTargetId, limit });
		await call('notes/children', { noteId: targets.replyParentId, limit });
		await call('notes/conversation', { noteId: targets.conversationId, limit });
		await call('i/favorites', { limit });
		await call('clips/notes', { clipId: targets.clipId, limit });
		await call('notes/featured', { limit });
		await call('users/featured-notes', { userId: targets.localUserId, limit });
		await call('notes/mentions', { limit });
		await call('notes/search-by-tag', { tag: targets.tag, limit });
		await call('notes/polls/recommendation', { limit });
		await call('i/notifications', { limit });
		await call('i/notifications-grouped', { limit });
		await call('users/get-frequently-replied-users', { userId: targets.remoteUserId, limit });
	}
	for (const noteId of targets.notifications.noteIds) await call('notes/reactions/delete', { noteId }, notifier);
	await call('ap/show', { uri: targets.remoteNote.uri });
	await call('ap/show', { uri: targets.localNote.uri });
	await route('note', `/notes/${targets.localNote.id}`);
	await route('note activity', `/notes/${targets.localNote.id}/activity`);
	await route('missing note', `/notes/${targets.missingNoteId}`);
	if (targets.deletedNoteId != null) await route('deleted note', `/notes/${targets.deletedNoteId}`);
	await route('featured', `/users/${me.id}/collections/featured`);
	for (const like of targets.likes) {
		await route(`like ${like.kind}`, `/likes/${like.noteId}/${like.id}`);
		await route(`like ${like.kind} by id`, `/likes/${like.id}`);
	}

	const created = await call('notes/create', { text: `e2e:probe:${targets.stage}:${targets.index}` }) as { createdNote?: { id: string } } | null;
	const createdNoteId = created?.createdNote?.id ?? null;
	if (createdNoteId != null) {
		const pins = await userNotePiningsRepository.find({ where: { userId: me.id }, order: { id: 'ASC' } });
		if (pins.length >= 5) await call('i/unpin', { noteId: pins[0].noteId });
		await call('i/pin', { noteId: createdNoteId });
	}
	await call('notes/reactions/create', { noteId: targets.writes.reactionNoteId, reaction: '👍' });
	tagCapture('reaction lookup');
	const reaction = await noteReactionsRepository.findOneBy({ noteId: targets.writes.reactionNoteId, userId: me.id });
	tagCapture(null);
	await call('notes/reactions/delete', { noteId: targets.writes.reactionNoteId });
	await call('notes/favorites/create', { noteId: targets.writes.favoriteNoteId });
	let clip = await clipsRepository.findOneBy({ userId: me.id, name: 'e2e-probe' });
	if (clip == null) {
		await call('clips/create', { name: 'e2e-probe', isPublic: true });
		clip = await clipsRepository.findOneByOrFail({ userId: me.id, name: 'e2e-probe' });
	}
	await call('clips/add-note', { clipId: clip.id, noteId: targets.writes.clipNoteId });
	await call('notes/polls/vote', { noteId: targets.writes.pollNoteId, choice: 0 });
	if (createdNoteId != null) {
		await call('notes/delete', { noteId: createdNoteId });
		await route('deleted own note', `/notes/${createdNoteId}`);
	}
	if (reaction != null) {
		await route('deleted like', `/likes/${reaction.noteId}/${reaction.id}`);
		await route('deleted like by id', `/likes/${reaction.id}`);
	}

	const output: ProbeOutput = { startedAt, endedAt: Date.now(), calls, routes, usersReactions, createdNoteId, reaction: reaction != null ? { id: reaction.id, noteId: reaction.noteId } : null };
	writeFileSync(targets.output, JSON.stringify(output, null, '\t'));
	emit({ type: 'result', calls: calls.length, routes: routes.length });
	process.exit(0);
} catch (e) {
	emit({ type: 'error', message: String(e), stack: e instanceof Error ? e.stack : undefined });
	process.exit(1);
}
