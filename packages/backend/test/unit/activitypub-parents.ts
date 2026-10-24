/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

process.env.NODE_ENV = 'test';

import * as assert from 'assert';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { describe, beforeAll, beforeEach, test, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { AbortError, FetchError } from 'node-fetch';
import { EntityNotFoundError } from 'typeorm';

import { MockResolver } from '../misc/mock-resolver.js';
import type { IActivity, IActor, IAnnounce, ICreate, ILike, IObject, IPost, IUndo } from '@/core/activitypub/type.js';
import { getApId } from '@/core/activitypub/type.js';
import type { MiRemoteUser } from '@/models/User.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { ApNoteService } from '@/core/activitypub/models/ApNoteService.js';
import type { NoteParentReference } from '@/core/activitypub/models/ApNoteService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import type { Resolver } from '@/core/activitypub/ApResolverService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { CoreModule } from '@/core/CoreModule.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { HttpRequestService } from '@/core/HttpRequestService.js';
import { IdService } from '@/core/IdService.js';
import { LoggerService } from '@/core/LoggerService.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import { NoteDeleteService } from '@/core/NoteDeleteService.js';
import { RelayService } from '@/core/RelayService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { MiMeta, MiNote, MiUser, NotesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { DownloadService } from '@/core/DownloadService.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { StatusError } from '@/misc/status-error.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import type { Config } from '@/config.js';
import type { DataSource } from 'typeorm';
import type * as Redis from 'ioredis';

const _filename = fileURLToPath(import.meta.url);
const _dirname = dirname(_filename);

const host = 'https://host1.test';

type NonTransientIActor = IActor & { id: string };
type NonTransientIPost = IPost & { id: string };

function createRandomActor({ actorHost = host } = {}): NonTransientIActor {
	const preferredUsername = secureRndstr(8);
	const actorId = `${actorHost}/users/${preferredUsername.toLowerCase()}`;

	return {
		'@context': 'https://www.w3.org/ns/activitystreams',
		id: actorId,
		type: 'Person',
		preferredUsername,
		inbox: `${actorId}/inbox`,
		outbox: `${actorId}/outbox`,
	};
}

function createRandomNote(actor: NonTransientIActor): NonTransientIPost {
	const id = secureRndstr(8);
	const noteId = `${new URL(actor.id).origin}/notes/${id}`;

	return {
		id: noteId,
		type: 'Note',
		attributedTo: actor.id,
		content: 'test test foo',
	};
}

describe('ActivityPub', () => {
	let userProfilesRepository: UserProfilesRepository;
	let noteService: ApNoteService;
	let personService: ApPersonService;
	let rendererService: ApRendererService;
	let resolver: MockResolver;
	let loggerService: LoggerService;
	let db: DataSource;
	let redis: Redis.Redis;
	let config: Config;
	let idService: IdService;
	let utilityService: UtilityService;
	let noteCreateService: NoteCreateService;
	let noteDeleteService: NoteDeleteService;
	let downloadService: DownloadService;
	let usersRepository: UsersRepository;
	let notesRepository: NotesRepository;
	let inboxService: ApInboxService;
	let apDbResolverService: ApDbResolverService;
	let apResolverService: ApResolverService;
	let apDeliverManagerService: ApDeliverManagerService;
	let httpRequestService: HttpRequestService;
	let relayService: RelayService;
	let globalEventService: GlobalEventService;

	const metaInitial = {
		cacheRemoteFiles: true,
		cacheRemoteSensitiveFiles: true,
		enableFanoutTimeline: true,
		enableFanoutTimelineDbFallback: true,
		perUserHomeTimelineCacheMax: 100,
		perLocalUserUserTimelineCacheMax: 100,
		perRemoteUserUserTimelineCacheMax: 100,
		blockedHosts: [] as string[],
		sensitiveWords: [] as string[],
		prohibitedWords: [] as string[],
	} as MiMeta;
	const meta = { ...metaInitial };

	function updateMeta(newMeta: Partial<MiMeta>): void {
		for (const key in meta) {
			delete (meta as any)[key];
		}
		Object.assign(meta, newMeta);
	}

	beforeAll(async () => {
		const app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
		})
			.overrideProvider(DownloadService).useValue({
				async downloadUrl(url: string, path: string): Promise<{ filename: string }> {
					if (url.endsWith('.png')) {
						fs.copyFileSync(
							_dirname + '/../resources/hw.png',
							path,
						);
					}
					return {
						filename: 'dummy.tmp',
					};
				},
			})
			.overrideProvider(DI.meta).useFactory({ factory: () => meta })
			.compile();

		await app.init();
		app.enableShutdownHooks();

		userProfilesRepository = app.get(DI.userProfilesRepository);

		noteService = app.get<ApNoteService>(ApNoteService);
		personService = app.get<ApPersonService>(ApPersonService);
		rendererService = app.get<ApRendererService>(ApRendererService);
		loggerService = await app.resolve<LoggerService>(LoggerService);
		resolver = new MockResolver(loggerService);
		db = app.get(DI.db);
		redis = app.get(DI.redis);
		config = app.get(DI.config);
		idService = app.get(IdService);
		utilityService = app.get(UtilityService);
		noteCreateService = app.get(NoteCreateService);
		noteDeleteService = app.get(NoteDeleteService);
		downloadService = app.get(DownloadService);
		usersRepository = app.get(DI.usersRepository);
		notesRepository = app.get(DI.notesRepository);
		inboxService = app.get(ApInboxService);
		apDbResolverService = app.get(ApDbResolverService);
		apResolverService = app.get(ApResolverService);
		apDeliverManagerService = app.get(ApDeliverManagerService);
		httpRequestService = app.get(HttpRequestService);
		relayService = app.get(RelayService);
		globalEventService = app.select(CoreModule).get(GlobalEventService, { strict: true });

		const federatedInstanceService = app.get<FederatedInstanceService>(FederatedInstanceService);
		vi.spyOn(federatedInstanceService, 'fetch').mockImplementation(() => new Promise(() => { }));
	});

	beforeEach(() => {
		resolver.clear();
	});

	describe('Parent links', () => {
		test('A reply to an unfetchable parent is retried before the last attempt', async () => {
			const actor = createRandomActor();
			const reply = { ...createRandomNote(actor), inReplyTo: `${host}/notes/${secureRndstr(8)}` };
			resolver.register(actor.id, actor);
			resolver.register(reply.id, reply);

			await assert.rejects(noteService.createNote(reply.id, undefined, resolver, true));
		});

		test('A reply to an unfetchable parent waits for it on the last attempt', async () => {
			const lastAttemptResolver = new MockResolver(loggerService);
			lastAttemptResolver.markLastAttempt();
			const actor = createRandomActor();
			const parentUri = `${host}/notes/${secureRndstr(8)}`;
			const reply = { ...createRandomNote(actor), inReplyTo: parentUri };
			lastAttemptResolver.register(actor.id, actor);
			lastAttemptResolver.register(reply.id, reply);

			const note = await noteService.createNote(reply.id, undefined, lastAttemptResolver, true);

			assert.strictEqual(note?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await db.query('SELECT "parentUri" FROM "note_pending_parent" WHERE "childId" = $1', [note.id]), [{ parentUri }]);
		});

		test('A reply to a deleted parent is linked to the former id without fetching the parent again', async () => {
			const actor = createRandomActor();
			const parent = { ...createRandomNote(actor), published: '2024-01-01T00:00:00.000Z' };
			resolver.register(actor.id, actor);
			resolver.register(parent.id, parent);
			const parentNote = await noteService.createNote(parent.id, undefined, resolver, true);
			assert.ok(parentNote);
			await db.query('DELETE FROM "note" WHERE "id" = $1', [parentNote.id]);

			const reply = { ...createRandomNote(actor), inReplyTo: parent.id, published: '2024-01-01T00:00:10.000Z' };
			resolver.register(reply.id, reply);
			const parentTrials = resolver.remoteGetTrials().filter(uri => uri === parent.id).length;

			const note = await noteService.createNote(reply.id, undefined, resolver, true);

			assert.strictEqual(note?.replyId, parentNote.id);
			assert.strictEqual(resolver.remoteGetTrials().filter(uri => uri === parent.id).length, parentTrials);
		});

		test('A reply published before its parent is created with an unreferenceable parent', async () => {
			const actor = createRandomActor();
			const parent = { ...createRandomNote(actor), published: '2024-01-02T00:00:10.000Z' };
			const reply = { ...createRandomNote(actor), inReplyTo: parent.id, published: '2024-01-02T00:00:00.000Z' };
			resolver.register(actor.id, actor);
			resolver.register(parent.id, parent);
			resolver.register(reply.id, reply);

			const note = await noteService.createNote(reply.id, undefined, resolver, true);

			assert.strictEqual(note?.replyId, UNREFERENCEABLE_NOTE_ID);
		});

		async function createLocalNote(): Promise<MiNote> {
			const userId = idService.gen();
			const username = secureRndstr(16);
			await usersRepository.insert({ id: userId, username, usernameLower: username.toLowerCase() });
			await userProfilesRepository.insert({ userId });
			const id = idService.gen();
			await notesRepository.insert({ id, text: 'local', userId, userHost: null, visibility: 'public' });
			return await notesRepository.findOneByOrFail({ id });
		}

		test('A reply to a deleted local note is linked to its former id when the deletion was recorded', async () => {
			const parent = await createLocalNote();
			await noteDeleteService.delete(await usersRepository.findOneByOrFail({ id: parent.userId }), parent, true);
			const actor = createRandomActor();
			const reply = { ...createRandomNote(actor), inReplyTo: `${config.url}/notes/${parent.id}` };
			resolver.register(actor.id, actor);
			resolver.register(reply.id, reply);

			const note = await noteService.createNote(reply.id, undefined, resolver, true);

			assert.strictEqual(note?.replyId, parent.id);
			assert.strictEqual(note.threadId, parent.id);
			assert.deepStrictEqual(await db.query('SELECT "parentId" FROM "note_relation" WHERE "childId" = $1 AND "kind" = 0', [note.id]), [{ parentId: parent.id }]);
			assert.deepStrictEqual(resolver.remoteGetTrials().filter(uri => uri === reply.inReplyTo), []);
		});

		test('A reply to a local id that has edges but no recorded deletion is created with an unreferenceable parent', async () => {
			vi.spyOn(utilityService, 'isSynonymousUriLocal').mockImplementation(uri => new URL(uri).origin === new URL(config.url).origin);
			const parentId = idService.gen(Date.now() - 1000);
			await db.query('INSERT INTO "note_relation" ("childId", "parentId", "kind") VALUES ($1, $2, 0)', [idService.gen(), parentId]);
			const actor = createRandomActor();
			const reply = { ...createRandomNote(actor), inReplyTo: `${config.url}/notes/${parentId}` };
			resolver.register(actor.id, actor);
			resolver.register(reply.id, reply);

			const note = await noteService.createNote(reply.id, undefined, resolver, true);

			assert.strictEqual(note?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await db.query('SELECT "parentId" FROM "note_relation" WHERE "childId" = $1', [note.id]), []);
			assert.deepStrictEqual(await db.query('SELECT 1 FROM "note_pending_parent" WHERE "childId" = $1', [note.id]), []);
		});

		test('A reply to an evicted parent is created with an unreferenceable parent and waits for it', async () => {
			const actor = createRandomActor();
			const parent = { ...createRandomNote(actor), published: '2024-01-03T00:00:00.000Z' };
			resolver.register(actor.id, actor);
			resolver.register(parent.id, parent);
			const parentNote = await noteService.createNote(parent.id, undefined, resolver, true);
			assert.ok(parentNote);
			await db.query('DELETE FROM "note" WHERE "id" = $1', [parentNote.id]);
			await db.query('DELETE FROM "note_uri" WHERE "noteId" = $1', [parentNote.id]);

			const lastAttemptResolver = new MockResolver(loggerService);
			lastAttemptResolver.markLastAttempt();
			const reply = { ...createRandomNote(actor), inReplyTo: parent.id, published: '2024-01-03T00:00:10.000Z' };
			lastAttemptResolver.register(actor.id, actor);
			lastAttemptResolver.register(reply.id, reply);

			const note = await noteService.createNote(reply.id, undefined, lastAttemptResolver, true);

			assert.strictEqual(note?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await db.query('SELECT "parentUri" FROM "note_pending_parent" WHERE "childId" = $1', [note.id]), [{ parentUri: parent.id }]);
		});
	});

	describe('Parent rendering', () => {
		async function createUser(host: string | null): Promise<MiUser> {
			const id = idService.gen();
			const username = secureRndstr(16);
			await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), host, uri: host != null ? `https://${host}/users/${username}` : null });
			await userProfilesRepository.insert({ userId: id });
			return await usersRepository.findOneByOrFail({ id });
		}

		async function createNote(user: MiUser, data: Partial<MiNote> = {}): Promise<MiNote> {
			const id = idService.gen();
			const uri = user.host != null ? `https://${user.host}/notes/${id}` : null;
			await notesRepository.insert({ id, text: `note_${id}`, userId: user.id, userHost: user.host, uri, visibility: 'public', ...data });
			if (uri != null) await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [uri, id]);
			return await notesRepository.findOneByOrFail({ id });
		}

		async function recordOriginal(note: MiNote, original: { replyId?: MiNote['id']; renoteId?: MiNote['id'] }): Promise<void> {
			await db.query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId") VALUES ($1, $2, $3)', [note.id, original.replyId ?? null, original.renoteId ?? null]);
		}

		async function evict(note: MiNote): Promise<void> {
			await db.query('DELETE FROM "note" WHERE "id" = $1', [note.id]);
			await db.query('DELETE FROM "note_uri" WHERE "noteId" = $1', [note.id]);
		}

		test('A local reply and quote of a deleted remote note render the uri of the note', async () => {
			const remoteUser = await createUser('remote.example.com');
			const localUser = await createUser(null);
			const parent = await createNote(remoteUser);
			const reply = await createNote(localUser, { replyId: parent.id });
			const quote = await createNote(localUser, { renoteId: parent.id });
			await noteDeleteService.delete(remoteUser, parent, true);

			assert.strictEqual((await rendererService.renderNote(reply, false)).inReplyTo, parent.uri);
			const rendered = await rendererService.renderNote(quote, false);
			assert.strictEqual(rendered.quoteUrl, parent.uri);
			assert.strictEqual(rendered._misskey_quote, parent.uri);
		});

		test('A local reply and quote of a deleted local note render the local url of the note', async () => {
			const localUser = await createUser(null);
			const parent = await createNote(localUser);
			const reply = await createNote(localUser, { replyId: parent.id });
			const quote = await createNote(localUser, { renoteId: parent.id });
			await noteDeleteService.delete(localUser, parent, true);

			assert.strictEqual((await rendererService.renderNote(reply, false)).inReplyTo, `${config.url}/notes/${parent.id}`);
			assert.strictEqual((await rendererService.renderNote(quote, false)).quoteUrl, `${config.url}/notes/${parent.id}`);
		});

		test('A local note whose parents could not be linked renders the uris of the recorded originals', async () => {
			const remoteUser = await createUser('remote.example.com');
			const localUser = await createUser(null);
			const replied = await createNote(remoteUser);
			const quoted = await createNote(localUser);
			const deletedReplied = await createNote(remoteUser);
			const deletedQuoted = await createNote(localUser);
			const live = await createNote(localUser, { replyId: UNREFERENCEABLE_NOTE_ID, renoteId: UNREFERENCEABLE_NOTE_ID });
			const deleted = await createNote(localUser, { replyId: UNREFERENCEABLE_NOTE_ID, renoteId: UNREFERENCEABLE_NOTE_ID });
			await recordOriginal(live, { replyId: replied.id, renoteId: quoted.id });
			await recordOriginal(deleted, { replyId: deletedReplied.id, renoteId: deletedQuoted.id });
			await noteDeleteService.delete(remoteUser, deletedReplied, true);
			await noteDeleteService.delete(localUser, deletedQuoted, true);

			const renderedLive = await rendererService.renderNote(live, false);
			assert.strictEqual(renderedLive.inReplyTo, replied.uri);
			assert.strictEqual(renderedLive.quoteUrl, `${config.url}/notes/${quoted.id}`);
			const renderedDeleted = await rendererService.renderNote(deleted, false);
			assert.strictEqual(renderedDeleted.inReplyTo, deletedReplied.uri);
			assert.strictEqual(renderedDeleted.quoteUrl, `${config.url}/notes/${deletedQuoted.id}`);
		});

		test('A local note whose parents could not be linked renders nothing for them when no original is recorded', async () => {
			const localUser = await createUser(null);
			const note = await createNote(localUser, { replyId: UNREFERENCEABLE_NOTE_ID, renoteId: UNREFERENCEABLE_NOTE_ID });

			const rendered = await rendererService.renderNote(note, false);

			assert.strictEqual(rendered.inReplyTo, undefined);
			assert.strictEqual(rendered.quoteUrl, undefined);
			assert.strictEqual(rendered._misskey_quote, undefined);
			assert.ok(!JSON.stringify(rendered).includes(UNREFERENCEABLE_NOTE_ID));
		});

		test('A local note does not render a local url for an evicted remote parent', async () => {
			const remoteUser = await createUser('remote.example.com');
			const localUser = await createUser(null);
			const parent = await createNote(remoteUser);
			const original = await createNote(remoteUser);
			const reply = await createNote(localUser, { replyId: parent.id });
			const unlinked = await createNote(localUser, { replyId: UNREFERENCEABLE_NOTE_ID });
			await recordOriginal(unlinked, { replyId: original.id });
			await evict(parent);
			await evict(original);

			for (const note of [reply, unlinked]) {
				const rendered = await rendererService.renderNote(note, false);
				assert.strictEqual(rendered.inReplyTo, undefined);
				assert.ok(!JSON.stringify(rendered).includes(`${config.url}/notes/${note === reply ? parent.id : original.id}`));
			}
		});

		async function deliveredOnDeletion(user: MiUser, note: MiNote): Promise<IActivity> {
			const deliverToFollowers = vi.spyOn(apDeliverManagerService, 'deliverToFollowers').mockResolvedValue(undefined);
			const deliverToUsers = vi.spyOn(apDeliverManagerService, 'deliverToUsers').mockResolvedValue(undefined);
			vi.spyOn(relayService, 'deliverToRelays').mockResolvedValue(undefined);
			deliverToFollowers.mockClear();
			deliverToUsers.mockClear();

			await noteDeleteService.delete(user, note);
			await vi.waitFor(() => assert.strictEqual(deliverToUsers.mock.calls.length, 1));

			assert.strictEqual(deliverToFollowers.mock.calls.length, 1);
			return deliverToFollowers.mock.calls[0][1];
		}

		function assertUndoOfAnnounce(activity: IActivity, renote: MiNote, object: string | null): void {
			assert.strictEqual(activity.type, 'Undo');
			const announce = activity.object as IAnnounce;
			assert.strictEqual(announce.type, 'Announce');
			assert.strictEqual(announce.id, `${config.url}/notes/${renote.id}/activity`);
			assert.strictEqual(announce.object, object);
		}

		test('Deleting a local renote undoes the Announce of the uri of its target, also when the target is gone', async () => {
			const remoteUser = await createUser('remote.example.com');
			const localUser = await createUser(null);
			const live = await createNote(remoteUser);
			const deletedRemote = await createNote(remoteUser);
			const deletedLocal = await createNote(localUser);
			const original = await createNote(remoteUser);
			const evicted = await createNote(remoteUser);
			const renoteOfLive = await createNote(localUser, { text: null, renoteId: live.id });
			const renoteOfDeletedRemote = await createNote(localUser, { text: null, renoteId: deletedRemote.id });
			const renoteOfDeletedLocal = await createNote(localUser, { text: null, renoteId: deletedLocal.id });
			const unlinked = await createNote(localUser, { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			const unlinkedOfEvicted = await createNote(localUser, { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			await recordOriginal(unlinked, { renoteId: original.id });
			await db.query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId", "renoteUri") VALUES ($1, NULL, $2, $3)', [unlinkedOfEvicted.id, evicted.id, evicted.uri]);
			await noteDeleteService.delete(remoteUser, deletedRemote, true);
			await noteDeleteService.delete(localUser, deletedLocal, true);
			await noteDeleteService.delete(remoteUser, original, true);
			await evict(evicted);

			assertUndoOfAnnounce(await deliveredOnDeletion(localUser, renoteOfLive), renoteOfLive, live.uri);
			assertUndoOfAnnounce(await deliveredOnDeletion(localUser, renoteOfDeletedRemote), renoteOfDeletedRemote, deletedRemote.uri);
			assertUndoOfAnnounce(await deliveredOnDeletion(localUser, renoteOfDeletedLocal), renoteOfDeletedLocal, `${config.url}/notes/${deletedLocal.id}`);
			assertUndoOfAnnounce(await deliveredOnDeletion(localUser, unlinked), unlinked, original.uri);
			assertUndoOfAnnounce(await deliveredOnDeletion(localUser, unlinkedOfEvicted), unlinkedOfEvicted, evicted.uri);
		});

		test('Deleting a local renote that could not be linked undoes the Announce of the uri recorded for its target, not of a note that took the id of the evicted target', async () => {
			const remoteUser = await createUser('remote.example.com');
			const localUser = await createUser(null);
			const evicted = await createNote(remoteUser);
			const renote = await createNote(localUser, { text: null, renoteId: UNREFERENCEABLE_NOTE_ID });
			await db.query('INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId", "renoteUri") VALUES ($1, NULL, $2, $3)', [renote.id, evicted.id, evicted.uri]);
			await evict(evicted);
			const reissuedUri = `https://${remoteUser.host}/notes/${secureRndstr(16)}`;
			await notesRepository.insert({ id: evicted.id, text: 'another note', userId: remoteUser.id, userHost: remoteUser.host, uri: reissuedUri, visibility: 'public' });
			await db.query('INSERT INTO "note_uri" ("uri", "noteId") VALUES ($1, $2)', [reissuedUri, evicted.id]);

			assertUndoOfAnnounce(await deliveredOnDeletion(localUser, renote), renote, evicted.uri);
		});

		test('Deleting a local quote of a note that is gone deletes the quote', async () => {
			const remoteUser = await createUser('remote.example.com');
			const localUser = await createUser(null);
			const target = await createNote(remoteUser);
			const quote = await createNote(localUser, { renoteId: target.id });
			await noteDeleteService.delete(remoteUser, target, true);

			const activity = await deliveredOnDeletion(localUser, quote);

			assert.strictEqual(activity.type, 'Delete');
			assert.deepStrictEqual(activity.object, { id: `${config.url}/notes/${quote.id}`, type: 'Tombstone' });
		});
	});

	describe('Announce and parent references', () => {
		const responses = new Map<string, (IObject | Error)[]>();
		const fetched: string[] = [];
		const failingDownloads = new Map<string, Error>();

		beforeEach(() => {
			responses.clear();
			fetched.length = 0;
			failingDownloads.clear();
			vi.spyOn(httpRequestService, 'getActivityJson').mockImplementation(async url => {
				fetched.push(url);
				const queue = responses.get(url);
				const response = queue != null && queue.length > 1 ? queue.shift() : queue?.[0];
				if (response instanceof Error) throw response;
				if (response == null) throw new Error('Not registered for mock');
				return structuredClone(response);
			});
			const downloadUrl = downloadService.downloadUrl;
			vi.spyOn(downloadService, 'downloadUrl').mockImplementation(async (url, path) => {
				const failure = failingDownloads.get(url);
				if (failure != null) throw failure;
				return await downloadUrl(url, path);
			});
		});

		function respond(uri: string, ...queue: (IObject | Error)[]): void {
			responses.set(uri, queue);
		}

		function fetchesOf(uri: string): number {
			return fetched.filter(x => x === uri).length;
		}

		async function createJobResolver(lastAttempt = false): Promise<Resolver> {
			const jobResolver = await apResolverService.createResolver();
			if (lastAttempt) jobResolver.markLastAttempt();
			return jobResolver;
		}

		async function createActor(actorHost = host): Promise<{ actor: NonTransientIActor; user: MiRemoteUser }> {
			const actor = createRandomActor({ actorHost });
			respond(actor.id, actor);
			return { actor, user: await personService.createPerson(actor.id, await createJobResolver()) };
		}

		function createPost(actor: NonTransientIActor, data: Partial<IPost> = {}): NonTransientIPost {
			return {
				'@context': 'https://www.w3.org/ns/activitystreams',
				...createRandomNote(actor),
				to: 'https://www.w3.org/ns/activitystreams#Public',
				published: '2024-02-01T00:00:00.000Z',
				...data,
			};
		}

		function createAnnounce(actor: NonTransientIActor, object: string | IObject, data: Partial<IAnnounce> = {}): IAnnounce & { id: string } {
			return {
				'@context': 'https://www.w3.org/ns/activitystreams',
				id: `${actor.id}/statuses/${secureRndstr(8)}/activity`,
				type: 'Announce',
				actor: actor.id,
				object,
				published: '2024-02-01T00:00:10.000Z',
				to: 'https://www.w3.org/ns/activitystreams#Public',
				cc: `${actor.id}/followers`,
				...data,
			};
		}

		function unfetchableUri(): string {
			return `${host}/notes/${secureRndstr(8)}`;
		}

		function statusError(statusCode: number): StatusError {
			return new StatusError(`${statusCode}`, statusCode);
		}

		async function pendingParentsOf(note: MiNote): Promise<{ parentUri: string; kind: number }[]> {
			return await db.query('SELECT "parentUri", "kind" FROM "note_pending_parent" WHERE "childId" = $1', [note.id]);
		}

		async function waitingFor(uri: string): Promise<unknown[]> {
			return await db.query('SELECT 1 FROM "note_pending_parent" WHERE "parentUri" = $1', [uri]);
		}

		async function waitFor(check: () => Promise<boolean>): Promise<void> {
			for (let i = 0; i < 100; i++) {
				if (await check()) return;
				await setTimeout(50);
			}
			throw new Error('timed out');
		}

		test('A renote of a note in the database is created without fetching the note even if its server fails', async () => {
			const { actor: author } = await createActor();
			const post = createPost(author);
			respond(post.id, post);
			const target = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
			assert.ok(target);
			respond(post.id, statusError(503));
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			const trials = fetchesOf(post.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
			assert.strictEqual(fetchesOf(post.id), trials);
		});

		test('A fetched target is created from the first fetch, so a failure fetching it again cannot drop the renote', async () => {
			const { actor: author } = await createActor();
			const post = createPost(author);
			respond(post.id, post, statusError(503));
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.text, 'test test foo');
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
			assert.strictEqual(fetchesOf(post.id), 1);
		});

		test('An embedded object from the origin of the Announce is used without fetching it', async () => {
			const { actor, user } = await createActor();
			const followers = `${actor.id}/followers`;
			const post = createPost(actor, { to: followers });
			const announce = createAnnounce(actor, post, { to: followers, cc: [] });

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.visibility, 'followers');
			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, target.id);
			assert.strictEqual(renote.visibility, 'followers');
			assert.strictEqual(fetchesOf(post.id), 0);
		});

		test('An embedded object from another origin is fetched once and the fetched object is used', async () => {
			const { actor: author } = await createActor();
			const post = createPost(author);
			respond(post.id, post);
			const { actor, user } = await createActor('https://host2.test');
			const announce = createAnnounce(actor, { ...post, content: 'test test bar' });

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.text, 'test test foo');
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
			assert.strictEqual(fetchesOf(post.id), 1);
		});

		test('A failure fetching the parent of the target follows the reply rules instead of dropping the renote', async () => {
			const { actor: author } = await createActor();
			const parentUri = unfetchableUri();
			respond(parentUri, statusError(503));
			const post = createPost(author, { inReplyTo: parentUri });
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			await assert.rejects(inboxService.performOneActivity(user, announce, await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 503);
			assert.strictEqual(await noteService.fetchNote(announce), null);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(target), [{ parentUri, kind: 0 }]);
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
			assert.strictEqual(fetchesOf(post.id), 2);
		});

		test('A failure fetching the quote of the target follows the quote rules instead of dropping the renote', async () => {
			const { actor: author } = await createActor();
			const quoteUri = unfetchableUri();
			respond(quoteUri, statusError(503));
			const post = createPost(author, { _misskey_quote: quoteUri });
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			await assert.rejects(inboxService.performOneActivity(user, announce, await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 503);
			assert.strictEqual(await noteService.fetchNote(announce), null);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(target), [{ parentUri: quoteUri, kind: 1 }]);
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
		});

		test('A failure fetching the author of the target is retried instead of dropping the renote', async () => {
			const author = createRandomActor();
			respond(author.id, statusError(503));
			const post = createPost(author);
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			await assert.rejects(inboxService.performOneActivity(user, announce, await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 503);
			assert.strictEqual(await noteService.fetchNote(announce), null);

			respond(author.id, author);
			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.ok(target);
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
		});

		test.each([
			{ statusCode: 404, waiting: true },
			{ statusCode: 410, waiting: false },
		])('A target whose author responds $statusCode is announced at once with an unreferenceable target, waited for: $waiting', async ({ statusCode, waiting }) => {
			const author = createRandomActor();
			respond(author.id, statusError(statusCode));
			const post = createPost(author);
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			assert.strictEqual(await noteService.fetchNote(post.id), null);
			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(renote), waiting ? [{ parentUri: post.id, kind: 2 }] : []);
			assert.strictEqual(fetchesOf(post.id), 1);
		});

		test('A target whose author still fails on the last attempt is announced with an unreferenceable target waiting for it', async () => {
			const author = createRandomActor();
			respond(author.id, statusError(503));
			const post = createPost(author);
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), undefined);

			assert.strictEqual(await noteService.fetchNote(post.id), null);
			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(renote), [{ parentUri: post.id, kind: 2 }]);
		});

		test.each([
			{ parent: 'a Tombstone', reject: (uri: string) => respond(uri, { '@context': 'https://www.w3.org/ns/activitystreams', id: uri, type: 'Tombstone' }) },
			{ parent: 'an invalid note', reject: (uri: string, author: NonTransientIActor) => respond(uri, { ...createPost(author), id: uri, attributedTo: `https://host2.test/users/${secureRndstr(8)}` }) },
			{ parent: 'a note with prohibited words', reject: (uri: string, author: NonTransientIActor) => respond(uri, { ...createPost(author), id: uri, content: 'prohibited' }) },
		])('A target replying to $parent is created at once with an unreferenceable parent that is not waited for, and is renoted', async ({ reject }) => {
			const { actor: author } = await createActor();
			const parentUri = unfetchableUri();
			reject(parentUri, author);
			const post = createPost(author, { inReplyTo: parentUri });
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			const previous = { ...meta };
			updateMeta({ ...previous, prohibitedWords: ['prohibited'] });
			try {
				assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			} finally {
				updateMeta(previous);
			}

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.strictEqual(target.threadId, null);
			assert.deepStrictEqual(await pendingParentsOf(target), []);
			assert.strictEqual(await noteService.fetchNote(parentUri), null);
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
		});

		test('A note quoting a rejected note is created at once with an unreferenceable target that is not waited for', async () => {
			const { actor: author } = await createActor();
			const quoteUri = unfetchableUri();
			respond(quoteUri, { '@context': 'https://www.w3.org/ns/activitystreams', id: quoteUri, type: 'Tombstone' });
			const post = createPost(author, { _misskey_quote: quoteUri });
			respond(post.id, post);

			const note = await noteService.createNote(post.id, undefined, await createJobResolver(), true);

			assert.strictEqual(note?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.strictEqual(note.text, 'test test foo');
			assert.deepStrictEqual(await pendingParentsOf(note), []);
		});

		test('A fetched target without an audience is stored as public as when it was fetched again, and is renoted', async () => {
			const { actor: author } = await createActor();
			const post = createPost(author);
			delete post.to;
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.visibility, 'public');
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
			assert.strictEqual(fetchesOf(post.id), 1);
		});

		test('An embedded self-boost without an audience is fetched again, stored as public as when it was fetched, and renoted', async () => {
			const { actor, user } = await createActor();
			const post = createPost(actor);
			delete post.to;
			respond(post.id, post);
			const announce = createAnnounce(actor, { ...post, content: 'test test bar' });

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const target = await noteService.fetchNote(post.id);
			assert.strictEqual(target?.visibility, 'public');
			assert.strictEqual(target.text, 'test test foo');
			assert.strictEqual((await noteService.fetchNote(announce))?.renoteId, target.id);
			assert.strictEqual(fetchesOf(post.id), 1);
		});

		test('A local URL without an id does not pick an arbitrary note or user', async () => {
			vi.spyOn(utilityService, 'isSynonymousUriLocal').mockImplementation(uri => new URL(uri).origin === new URL(config.url).origin);
			const { actor: author } = await createActor();
			const post = createPost(author);
			respond(post.id, post);
			assert.ok(await noteService.createNote(post.id, undefined, await createJobResolver(), true));
			const { actor, user } = await createActor();
			const notesUrl = new URL('/notes', config.url).href;
			const announce = createAnnounce(actor, notesUrl);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), `skip: announce target ${notesUrl} is rejected - unfetchable uri`);

			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(await apDbResolverService.getNoteFromApId(notesUrl), null);
			assert.deepStrictEqual(await apDbResolverService.getNoteReferenceFromApId(notesUrl), { note: null, formerId: null });
			assert.strictEqual(await apDbResolverService.getUserFromApId(new URL('/users', config.url).href), null);
			await assert.rejects((await createJobResolver()).resolve(notesUrl), EntityNotFoundError);
		});

		test('A target URL with a fragment completes at once without creating anything', async () => {
			const { actor, user } = await createActor();
			const targetUri = `${unfetchableUri()}#main`;
			const announce = createAnnounce(actor, targetUri);

			const result = await inboxService.performOneActivity(user, announce, await createJobResolver());

			assert.strictEqual(result, `skip: announce target ${targetUri} is rejected - unfetchable uri`);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.deepStrictEqual(await waitingFor(targetUri), []);
			assert.strictEqual(fetchesOf(targetUri), 0);
		});

		test('A target whose response has no @context completes at once without creating anything', async () => {
			const { actor: author } = await createActor();
			const post = createPost(author);
			delete post['@context'];
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			const result = await inboxService.performOneActivity(user, announce, await createJobResolver());

			assert.strictEqual(result, `skip: announce target ${post.id} is rejected - invalid response`);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(await noteService.fetchNote(post.id), null);
			assert.deepStrictEqual(await waitingFor(post.id), []);
		});

		test.each([
			{ statusCode: 404, waiting: true },
			{ statusCode: 403, waiting: true },
			{ statusCode: 410, waiting: false },
		])('A target that responds $statusCode is announced at once with an unreferenceable target, waited for: $waiting', async ({ statusCode, waiting }) => {
			const { actor, user } = await createActor();
			const targetUri = unfetchableUri();
			respond(targetUri, statusError(statusCode));
			const announce = createAnnounce(actor, targetUri);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.strictEqual(renote.text, null);
			assert.deepStrictEqual(await pendingParentsOf(renote), waiting ? [{ parentUri: targetUri, kind: 2 }] : []);
		});

		test.each([
			{ failure: 'a 5xx', error: () => statusError(503) },
			{ failure: 'a 429', error: () => statusError(429) },
			{ failure: 'a timeout', error: () => new AbortError('The operation was aborted.') },
			{ failure: 'a connection failure', error: () => new FetchError('request failed, reason: connect ECONNREFUSED', 'system', { code: 'ECONNREFUSED' }) },
		])('A target that fails with $failure is retried and announced with an unreferenceable target on the last attempt', async ({ error }) => {
			const { actor, user } = await createActor();
			const targetUri = unfetchableUri();
			respond(targetUri, error());
			const announce = createAnnounce(actor, targetUri);

			await assert.rejects(inboxService.performOneActivity(user, announce, await createJobResolver()));
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.deepStrictEqual(await waitingFor(targetUri), []);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), undefined);

			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(renote), [{ parentUri: targetUri, kind: 2 }]);
		});

		test('A target whose response is malformed in another way is retried and announced with an unreferenceable target waiting for it on the last attempt', async () => {
			const { actor, user } = await createActor();
			const targetUri = unfetchableUri();
			respond(targetUri, new Error('Validate content type of AP response: Content type is not application/activity+json or application/ld+json'));
			const announce = createAnnounce(actor, targetUri);

			await assert.rejects(inboxService.performOneActivity(user, announce, await createJobResolver()), /Validate content type/);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.deepStrictEqual(await waitingFor(targetUri), []);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), undefined);

			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(renote), [{ parentUri: targetUri, kind: 2 }]);
		});

		test('A target that arrives later is linked to the renote that waited for it', async () => {
			const { actor: author } = await createActor();
			const post = createPost(author);
			respond(post.id, statusError(404));
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);

			respond(post.id, post);
			const target = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
			assert.ok(target);
			await waitFor(async () => (await notesRepository.findOneByOrFail({ id: renote.id })).renoteId === target.id);

			assert.deepStrictEqual(await pendingParentsOf(renote), []);
			assert.deepStrictEqual(await db.query('SELECT "parentId", "kind" FROM "note_relation" WHERE "childId" = $1', [renote.id]), [{ parentId: target.id, kind: 2 }]);
			assert.strictEqual((await notesRepository.findOneByOrFail({ id: target.id })).renoteCount, 1);
		});

		test('A target that is a Tombstone is announced at once with an unreferenceable target that is not waited for', async () => {
			const { actor, user } = await createActor();
			const targetUri = unfetchableUri();
			respond(targetUri, { '@context': 'https://www.w3.org/ns/activitystreams', id: targetUri, type: 'Tombstone' });
			const announce = createAnnounce(actor, targetUri);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);

			const renote = await noteService.fetchNote(announce);
			assert.strictEqual(renote?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(renote), []);
		});

		test('A target that is neither a post nor a Tombstone is skipped', async () => {
			const { actor, user } = await createActor();
			const other = createRandomActor();
			respond(other.id, other);
			const announce = createAnnounce(actor, other.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), `skip: announce target ${other.id} is rejected - invalid Note: invalid object type Person`);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.deepStrictEqual(await waitingFor(other.id), []);
		});

		async function createRenoteInDatabase(): Promise<IAnnounce & { id: string }> {
			const { actor: author } = await createActor();
			const post = createPost(author);
			respond(post.id, post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			assert.ok(await noteService.fetchNote(announce));
			return announce;
		}

		test('An Announce of a pure renote in the database is skipped', async () => {
			const boost = await createRenoteInDatabase();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, boost.id);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), 'skip: announce target is a pure renote');
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(fetchesOf(boost.id), 0);
		});

		test('An embedded object that is not a post is skipped without being looked up', async () => {
			const boost = await createRenoteInDatabase();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, boost);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), 'skip: unknown object type Announce');
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(fetchesOf(boost.id), 0);
		});

		test('An Announce of a target that can neither be fetched nor waited for is skipped without resolving it', async () => {
			vi.spyOn(utilityService, 'isSynonymousUriLocal').mockImplementation(uri => new URL(uri).origin === new URL(config.url).origin);
			const { actor, user } = await createActor();
			const localUri = new URL(`/notes/${idService.gen()}`, config.url).href;
			const urn = `urn:example:${secureRndstr(8)}`;

			for (const [object, result] of [
				[localUri, `skip: announce target ${localUri} is rejected - unfetchable uri`],
				[urn, `skip: announce target ${urn} is rejected - unfetchable uri`],
				['not a url', 'skip: announce target not a url is rejected - invalid uri'],
			]) {
				const announce = createAnnounce(actor, object);
				assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), result);
				assert.strictEqual(await noteService.fetchNote(announce), null);
			}
			assert.deepStrictEqual(fetched.filter(uri => uri !== actor.id), []);
		});

		test('A relay Announce of a target that cannot be fetched creates nothing', async () => {
			const { actor, user } = await createActor();
			vi.spyOn(relayService, 'isRelayActor').mockResolvedValue(true);
			const targetUri = unfetchableUri();
			respond(targetUri, statusError(404));
			const announce = createAnnounce(actor, targetUri);

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), 'skip: announce target is unresolvable');
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.deepStrictEqual(await waitingFor(targetUri), []);
		});

		test('An Announce of a note on a blocked host is skipped even if the note is in the database', async () => {
			const { actor: author } = await createActor('https://blocked.test');
			const live = createPost(author);
			respond(live.id, live);
			assert.ok(await noteService.createNote(live.id, undefined, await createJobResolver(), true));
			const deleted = createPost(author);
			respond(deleted.id, deleted);
			const deletedNote = await noteService.createNote(deleted.id, undefined, await createJobResolver(), true);
			assert.ok(deletedNote);
			await db.query('DELETE FROM "note" WHERE "id" = $1', [deletedNote.id]);
			const { actor, user } = await createActor();
			const announces = [createAnnounce(actor, live.id), createAnnounce(actor, deleted.id)];
			const previous = { ...meta };
			updateMeta({ ...previous, blockedHosts: ['blocked.test'] });
			try {
				for (const announce of announces) {
					assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), `skip: announce target ${getApId(announce.object)} is rejected - blocked instance`);
				}
			} finally {
				updateMeta(previous);
			}

			for (const announce of announces) {
				assert.strictEqual(await noteService.fetchNote(announce), null);
			}
		});

		test.each(['1999-12-31T23:59:59.999Z', '2000-01-01T00:00:00.000Z', 'not a date'])('An Announce published at %s is skipped without generating an id from it', async published => {
			const { actor: author } = await createActor();
			const live = createPost(author);
			respond(live.id, live);
			assert.ok(await noteService.createNote(live.id, undefined, await createJobResolver(), true));
			const deleted = createPost(author);
			respond(deleted.id, deleted);
			const deletedNote = await noteService.createNote(deleted.id, undefined, await createJobResolver(), true);
			assert.ok(deletedNote);
			await db.query('DELETE FROM "note" WHERE "id" = $1', [deletedNote.id]);
			const unfetchable = unfetchableUri();
			respond(unfetchable, statusError(404));
			const { actor, user } = await createActor();
			const gen = vi.spyOn(idService, 'gen');

			for (const object of [live.id, deleted.id, unfetchable]) {
				const announce = createAnnounce(actor, object, { published });
				assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), 'skip: malformed createdAt');
				assert.strictEqual(await noteService.fetchNote(announce), null);
			}

			assert.strictEqual(fetchesOf(unfetchable), 0);
			assert.ok(gen.mock.results.every(result => !String(result.value).startsWith('00000000')));
		});

		function tombstone(uri: string): IObject {
			return { '@context': 'https://www.w3.org/ns/activitystreams', id: uri, type: 'Tombstone' };
		}

		function createCreate(actor: NonTransientIActor, object: NonTransientIPost): ICreate {
			return { '@context': 'https://www.w3.org/ns/activitystreams', id: `${object.id}/activity`, type: 'Create', actor: actor.id, object, to: object.to, cc: object.cc };
		}

		function createUndo(actor: NonTransientIActor, object: string | IAnnounce): IUndo {
			return { '@context': 'https://www.w3.org/ns/activitystreams', id: `${actor.id}#undo/${secureRndstr(8)}`, type: 'Undo', actor: actor.id, object };
		}

		async function postedParent(data: Partial<IPost> = {}, author?: NonTransientIActor): Promise<NonTransientIPost> {
			const post = createPost(author ?? (await createActor()).actor, data);
			respond(post.id, post);
			return post;
		}

		function receiveChild(kind: number, actor: NonTransientIActor, parentUri: string): { uri: string; activity: IObject } {
			if (kind === 2) {
				const announce = createAnnounce(actor, parentUri);
				return { uri: announce.id, activity: announce };
			}
			const post = createPost(actor, {
				to: `${actor.id}/followers`,
				published: '2024-02-01T00:00:20.000Z',
				...(kind === 0 ? { inReplyTo: parentUri } : { _misskey_quote: parentUri }),
			});
			return { uri: post.id, activity: createCreate(actor, post) };
		}

		type ParentOutcome = 'note' | 'former' | 'waiting' | 'gone' | 'rejected' | 'retry';

		type ParentSetup = { uri: string; noteUri?: string; formerId?: MiNote['id']; meta?: Partial<MiMeta>; check?: (parent: MiNote) => Promise<void>; verify?: () => Promise<void> };

		function respondingParent(response: (uri: string) => IObject | Error): () => Promise<ParentSetup> {
			return async () => {
				const uri = unfetchableUri();
				respond(uri, response(uri));
				return { uri };
			};
		}

		function parentWithAuthor(response: (author: NonTransientIActor) => IObject | Error): () => Promise<ParentSetup> {
			return async () => {
				const author = createRandomActor();
				respond(author.id, response(author));
				return { uri: (await postedParent({}, author)).id };
			};
		}

		function parentWithAttachment(statusCode: number): () => Promise<ParentSetup> {
			return async () => {
				const url = `${host}/files/${secureRndstr(8)}.png`;
				failingDownloads.set(url, statusError(statusCode));
				return { uri: (await postedParent({ attachment: [{ type: 'Document', mediaType: 'image/png', url }] })).id };
			};
		}

		function parentReplyingTo(response: (uri: string) => IObject | Error, waiting: boolean): () => Promise<ParentSetup> {
			return async () => {
				const grandparentUri = unfetchableUri();
				respond(grandparentUri, response(grandparentUri));
				return {
					uri: (await postedParent({ inReplyTo: grandparentUri })).id,
					check: async parent => {
						assert.strictEqual(parent.replyId, UNREFERENCEABLE_NOTE_ID);
						assert.deepStrictEqual(await pendingParentsOf(parent), waiting ? [{ parentUri: grandparentUri, kind: 0 }] : []);
					},
				};
			};
		}

		function knownParentReferencedWithWww(deleted: boolean, response: (uri: string) => IObject | Error): () => Promise<ParentSetup> {
			return async () => {
				const { actor: author, user: authorUser } = await createActor();
				const post = await postedParent({}, author);
				const note = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
				assert.ok(note);
				if (deleted) await noteDeleteService.delete(authorUser, note, true);
				const uri = post.id.replace('https://', 'https://www.');
				respond(uri, response(uri));
				return { uri, noteUri: post.id, formerId: deleted ? note.id : undefined, verify: async () => assert.strictEqual(fetchesOf(uri), 0) };
			};
		}

		function overlongParent(): () => Promise<ParentSetup> {
			return async () => {
				const uri = `${host}/notes/${'a'.repeat(512)}`;
				return { uri, verify: async () => assert.strictEqual(fetchesOf(uri), 0) };
			};
		}

		const malformedResponse = () => new Error('Validate content type of AP response: Content type is not application/activity+json or application/ld+json');

		const parentCases: { parent: string; outcome: ParentOutcome; lastAttempt?: boolean; setup: () => Promise<ParentSetup> }[] = [
			{
				parent: 'a note in the database',
				outcome: 'note',
				setup: async () => {
					const post = await postedParent();
					assert.ok(await noteService.createNote(post.id, undefined, await createJobResolver(), true));
					respond(post.id, statusError(503));
					return { uri: post.id };
				},
			},
			{
				parent: 'a note referenced by its id with www.',
				outcome: 'note',
				setup: async () => {
					const post = await postedParent();
					const uri = post.id.replace('https://', 'https://www.');
					respond(uri, post);
					return { uri, noteUri: post.id };
				},
			},
			{
				parent: 'a note in the database referenced by its id with www.',
				outcome: 'note',
				setup: async () => {
					const post = await postedParent();
					assert.ok(await noteService.createNote(post.id, undefined, await createJobResolver(), true));
					const uri = post.id.replace('https://', 'https://www.');
					respond(uri, post);
					return { uri, noteUri: post.id };
				},
			},
			{
				parent: 'a deleted note referenced by its id with www.',
				outcome: 'former',
				setup: async () => {
					const { actor: author, user: authorUser } = await createActor();
					const post = await postedParent({}, author);
					const note = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
					assert.ok(note);
					await noteDeleteService.delete(authorUser, note, true);
					const uri = post.id.replace('https://', 'https://www.');
					respond(uri, post);
					return { uri, formerId: note.id };
				},
			},
			{ parent: 'a note in the database referenced by its id with www. whose server responds 410', outcome: 'note', setup: knownParentReferencedWithWww(false, () => statusError(410)) },
			{ parent: 'a note in the database referenced by its id with www. whose server returns a Tombstone', outcome: 'note', setup: knownParentReferencedWithWww(false, tombstone) },
			{ parent: 'a note in the database referenced by its id with www. whose server responds 503', outcome: 'note', setup: knownParentReferencedWithWww(false, () => statusError(503)) },
			{ parent: 'a deleted note referenced by its id with www. whose server responds 410', outcome: 'former', setup: knownParentReferencedWithWww(true, () => statusError(410)) },
			{ parent: 'a deleted note referenced by its id with www. whose server returns a Tombstone', outcome: 'former', setup: knownParentReferencedWithWww(true, tombstone) },
			{ parent: 'a deleted note referenced by its id with www. whose server responds 503', outcome: 'former', setup: knownParentReferencedWithWww(true, () => statusError(503)) },
			{
				parent: 'a deleted note',
				outcome: 'former',
				setup: async () => {
					const { actor: author, user: authorUser } = await createActor();
					const post = await postedParent({}, author);
					const note = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
					assert.ok(note);
					await noteDeleteService.delete(authorUser, note, true);
					return { uri: post.id, formerId: note.id };
				},
			},
			{ parent: 'a Tombstone', outcome: 'gone', setup: respondingParent(tombstone) },
			{ parent: 'a note that responds 410', outcome: 'gone', setup: respondingParent(() => statusError(410)) },
			{ parent: 'a note that responds 404', outcome: 'waiting', setup: respondingParent(() => statusError(404)) },
			{ parent: 'a note that responds 403', outcome: 'waiting', setup: respondingParent(() => statusError(403)) },
			{ parent: 'a note that responds 503 before the last attempt', outcome: 'retry', setup: respondingParent(() => statusError(503)) },
			{ parent: 'a note that responds 503 on the last attempt', outcome: 'waiting', lastAttempt: true, setup: respondingParent(() => statusError(503)) },
			{ parent: 'a note that times out on the last attempt', outcome: 'waiting', lastAttempt: true, setup: respondingParent(() => new AbortError('The operation was aborted.')) },
			{ parent: 'a note whose response is malformed before the last attempt', outcome: 'retry', setup: respondingParent(malformedResponse) },
			{ parent: 'a note whose response is malformed on the last attempt', outcome: 'waiting', lastAttempt: true, setup: respondingParent(malformedResponse) },
			{
				parent: 'a note attributed to something that is not a URL on the last attempt',
				outcome: 'waiting',
				lastAttempt: true,
				setup: async () => ({ uri: (await postedParent({ attributedTo: 'not a url' })).id }),
			},
			{
				parent: 'a note with prohibited words',
				outcome: 'rejected',
				setup: async () => ({ uri: (await postedParent({ content: 'prohibited' })).id, meta: { prohibitedWords: ['prohibited'] } }),
			},
			{
				parent: 'a note of a suspended author',
				outcome: 'rejected',
				setup: async () => {
					const author = createRandomActor();
					const username = author.preferredUsername as string;
					const id = idService.gen();
					await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), host: new URL(author.id).host, uri: author.id, inbox: author.inbox as string, isSuspended: true });
					await userProfilesRepository.insert({ userId: id });
					return { uri: (await postedParent({}, author)).id };
				},
			},
			{
				parent: 'a note with too many mentions',
				outcome: 'rejected',
				setup: async () => ({ uri: (await postedParent({ tag: Array.from({ length: 21 }, (_, i) => ({ type: 'Mention', href: `${host}/users/${secureRndstr(8)}`, name: `@mention${i}` })) })).id }),
			},
			{
				parent: 'a note attributed to another host',
				outcome: 'rejected',
				setup: async () => ({ uri: (await postedParent({ attributedTo: `https://host2.test/users/${secureRndstr(8)}` })).id }),
			},
			{
				parent: 'a note quoting a note that is not public',
				outcome: 'rejected',
				setup: async () => {
					const { actor: other } = await createActor();
					const hidden = await postedParent({ to: `${other.id}/followers` }, other);
					assert.strictEqual((await noteService.createNote(hidden.id, undefined, await createJobResolver(), true))?.visibility, 'followers');
					return { uri: (await postedParent({ _misskey_quote: hidden.id })).id };
				},
			},
			{
				parent: 'a note whose fetched object claims an id on another host',
				outcome: 'rejected',
				setup: async () => {
					const { actor: spoofed } = await createActor('https://host2.test');
					const object = createPost(spoofed);
					const uri = unfetchableUri();
					respond(uri, object);
					return { uri, verify: async () => assert.strictEqual(await noteService.fetchNote(object.id), null) };
				},
			},
			{
				parent: 'a note on a blocked host',
				outcome: 'rejected',
				setup: async () => ({ uri: `https://blocked.test/notes/${secureRndstr(8)}`, meta: { blockedHosts: ['blocked.test'] } }),
			},
			{ parent: 'a URL with a fragment', outcome: 'rejected', setup: async () => ({ uri: `${(await postedParent()).id}#main` }) },
			{ parent: 'a URI that is not http(s)', outcome: 'rejected', setup: async () => ({ uri: `urn:example:${secureRndstr(8)}` }) },
			{ parent: 'a string that is not a URL', outcome: 'rejected', setup: async () => ({ uri: 'not a url' }) },
			{ parent: 'a URI longer than a note URI can be', outcome: 'rejected', setup: overlongParent() },
			{ parent: 'a URI longer than a note URI can be on the last attempt', outcome: 'rejected', lastAttempt: true, setup: overlongParent() },
			{
				parent: 'a note whose response has no @context',
				outcome: 'rejected',
				setup: async () => {
					const post = createPost((await createActor()).actor);
					delete post['@context'];
					respond(post.id, post);
					return { uri: post.id };
				},
			},
			{ parent: 'a note whose author responds 404', outcome: 'waiting', setup: parentWithAuthor(() => statusError(404)) },
			{ parent: 'a note whose author responds 410', outcome: 'gone', setup: parentWithAuthor(() => statusError(410)) },
			{ parent: 'a note whose author document is invalid', outcome: 'waiting', setup: parentWithAuthor(author => ({ ...author, inbox: 'https://host2.test/inbox' })) },
			{ parent: 'a note whose author responds 503 before the last attempt', outcome: 'retry', setup: parentWithAuthor(() => statusError(503)) },
			{
				parent: 'a note whose author row is gone while it is created',
				outcome: 'gone',
				setup: async () => {
					const { actor: author, user: authorUser } = await createActor();
					assert.ok(await personService.fetchPerson(author.id));
					await db.query('DELETE FROM "user" WHERE "id" = $1', [authorUser.id]);
					return { uri: (await postedParent({}, author)).id };
				},
			},
			{ parent: 'a note whose author responds 503 on the last attempt', outcome: 'waiting', lastAttempt: true, setup: parentWithAuthor(() => statusError(503)) },
			{ parent: 'a note whose attachment responds 404', outcome: 'waiting', setup: parentWithAttachment(404) },
			{ parent: 'a note whose attachment responds 410', outcome: 'gone', setup: parentWithAttachment(410) },
			{ parent: 'a note replying to a Tombstone', outcome: 'note', setup: parentReplyingTo(tombstone, false) },
			{ parent: 'a note replying to a note that responds 404', outcome: 'note', setup: parentReplyingTo(() => statusError(404), true) },
		];

		const childPaths = [
			{ child: 'A reply', kind: 0, parentIdOf: (note: MiNote) => note.replyId },
			{ child: 'A quote', kind: 1, parentIdOf: (note: MiNote) => note.renoteId },
			{ child: 'An Announce', kind: 2, parentIdOf: (note: MiNote) => note.renoteId },
		];

		test.each(childPaths.flatMap(path => parentCases.map(parentCase => [path.child, parentCase.parent, parentCase.outcome, { ...path, ...parentCase }] as const)))('%s of %s is decided as %s', async (_child, _parent, _outcome, { kind, parentIdOf, outcome, lastAttempt, setup }) => {
			const parent = await setup();
			const previous = { ...meta };
			updateMeta({ ...previous, ...parent.meta });
			try {
				const { actor, user } = await createActor();
				const child = receiveChild(kind, actor, parent.uri);
				const receiving = inboxService.performOneActivity(user, child.activity, await createJobResolver(lastAttempt));

				if (outcome === 'retry') {
					await assert.rejects(receiving);
					assert.strictEqual(await noteService.fetchNote(child.uri), null);
					assert.deepStrictEqual(await waitingFor(parent.uri), []);
					return;
				}

				const result = await receiving;
				await parent.verify?.();
				const note = await noteService.fetchNote(child.uri);
				if (outcome === 'rejected' && kind === 2) {
					assert.match(String(result), /^skip: announce target .* is rejected - /);
					assert.strictEqual(note, null);
					return;
				}

				assert.ok(note, String(result));
				const parentNote = outcome === 'note' ? await noteService.fetchNote(parent.noteUri ?? parent.uri) : null;
				const expected = outcome === 'note' ? parentNote?.id : outcome === 'former' ? parent.formerId : UNREFERENCEABLE_NOTE_ID;
				assert.ok(expected);
				assert.strictEqual(parentIdOf(note), expected);
				assert.deepStrictEqual(await pendingParentsOf(note), outcome === 'waiting' ? [{ parentUri: parent.uri, kind }] : []);
				if (parent.check != null) {
					assert.ok(parentNote);
					await parent.check(parentNote);
				}
			} finally {
				updateMeta(previous);
			}
		});

		test('A quote whose two URIs are decided differently takes the rejected one over the one waited for', async () => {
			const waitedUri = unfetchableUri();
			respond(waitedUri, statusError(404));
			const rejected = await postedParent({ content: 'prohibited' });
			const { actor, user } = await createActor();
			const post = createPost(actor, { to: `${actor.id}/followers`, published: '2024-02-01T00:00:20.000Z', _misskey_quote: waitedUri, quoteUrl: rejected.id });
			const previous = { ...meta };
			updateMeta({ ...previous, prohibitedWords: ['prohibited'] });
			try {
				assert.strictEqual(await inboxService.performOneActivity(user, createCreate(actor, post), await createJobResolver()), undefined);
			} finally {
				updateMeta(previous);
			}

			const note = await noteService.fetchNote(post.id);
			assert.strictEqual(note?.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(note), []);
		});

		test('A reply that quotes its parent decides the parent once', async () => {
			const parentUri = unfetchableUri();
			respond(parentUri, statusError(404));
			const { actor, user } = await createActor();
			const post = createPost(actor, { to: `${actor.id}/followers`, published: '2024-02-01T00:00:20.000Z', inReplyTo: parentUri, _misskey_quote: parentUri });

			assert.strictEqual(await inboxService.performOneActivity(user, createCreate(actor, post), await createJobResolver()), undefined);

			const note = await noteService.fetchNote(post.id);
			assert.strictEqual(note?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.strictEqual(note.renoteId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual((await pendingParentsOf(note)).sort((a, b) => a.kind - b.kind), [{ parentUri, kind: 0 }, { parentUri, kind: 1 }]);
			assert.strictEqual(fetchesOf(parentUri), 1);
		});

		test.each([
			{ referenced: 'with www.', authorHost: host, toReference: (uri: string) => uri.replace('https://', 'https://www.') },
			{ referenced: 'without www.', authorHost: 'https://www.host1.test', toReference: (uri: string) => uri.replace('https://www.', 'https://') },
		])('A reply waiting for a parent referenced $referenced is linked when the parent arrives with an id that differs only by www.', async ({ authorHost, toReference }) => {
			const { actor: author } = await createActor(authorHost);
			const post = createPost(author);
			const reference = toReference(post.id);
			respond(reference, statusError(404));
			const { actor, user } = await createActor();
			const reply = createPost(actor, { to: `${actor.id}/followers`, published: '2024-02-01T00:00:20.000Z', inReplyTo: reference });

			assert.strictEqual(await inboxService.performOneActivity(user, createCreate(actor, reply), await createJobResolver()), undefined);
			const child = await noteService.fetchNote(reply.id);
			assert.strictEqual(child?.replyId, UNREFERENCEABLE_NOTE_ID);
			assert.deepStrictEqual(await pendingParentsOf(child), [{ parentUri: reference.replace('https://www.', 'https://'), kind: 0 }]);

			respond(post.id, post);
			const parent = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
			assert.ok(parent);
			await waitFor(async () => (await pendingParentsOf(child)).length === 0);
			assert.strictEqual((await notesRepository.findOneByOrFail({ id: child.id })).replyId, parent.id);
		});

		async function onLocalHost(run: () => Promise<void>, localHost = 'local.test'): Promise<void> {
			const original = { url: config.url, host: config.host };
			Object.assign(config, { url: `https://${localHost}`, host: localHost });
			try {
				await run();
			} finally {
				Object.assign(config, original);
			}
		}

		function localFetches(): string[] {
			return fetched.filter(uri => new URL(uri).host.endsWith('local.test'));
		}

		async function localParentsReferencedOn(referencedHost: string): Promise<{ uri: string; parentId: MiNote['id'] | null; decision: string }[]> {
			const userId = idService.gen();
			const username = secureRndstr(16);
			await usersRepository.insert({ id: userId, username, usernameLower: username.toLowerCase(), host: null });
			await userProfilesRepository.insert({ userId });
			const [liveId, deletedId, unknownId] = [0, 1, 2].map(() => idService.gen(Date.parse('2024-01-15T00:00:00.000Z')));
			await notesRepository.insert([liveId, deletedId].map(id => ({ id, text: 'local', userId, userHost: null, visibility: 'public' as const })));
			await noteDeleteService.delete(await usersRepository.findOneByOrFail({ id: userId }), await notesRepository.findOneByOrFail({ id: deletedId }), true);
			return [
				{ uri: `https://${referencedHost}/notes/${liveId}`, parentId: liveId, decision: `note ${liveId}` },
				{ uri: `https://${referencedHost}/notes/${deletedId}`, parentId: deletedId, decision: `former ${deletedId}` },
				{ uri: `https://${referencedHost}/notes/${unknownId}`, parentId: null, decision: 'rejected - unfetchable uri' },
			];
		}

		function decisionOf(reference: NoteParentReference): string {
			switch (reference.type) {
				case 'note': return `note ${reference.note.id}`;
				case 'former': return `former ${reference.formerId}`;
				case 'waiting': return `waiting ${reference.uri}`;
				default: return `${reference.type} - ${reference.reason}`;
			}
		}

		test.each(['all', 'specified'] as const)('With federation %s, a reply, a quote and an Announce of a local note referenced with www. are linked to it or to its former id without fetching it, and a local id that is not known is decided at once without waiting for it', async federation => {
			await onLocalHost(async () => {
				const references = await localParentsReferencedOn('www.local.test');
				const children = await Promise.all(childPaths.flatMap(path => references.map(async reference => ({ ...path, ...reference, ...await createActor() }))));
				const previous = { ...meta };
				updateMeta({ ...previous, federation, federationHosts: ['host1.test'] });
				try {
					for (const { kind, parentIdOf, uri, parentId, actor, user } of children) {
						const child = receiveChild(kind, actor, uri);
						const result = await inboxService.performOneActivity(user, child.activity, await createJobResolver());
						const note = await noteService.fetchNote(child.uri);
						if (parentId == null && kind === 2) {
							assert.strictEqual(result, `skip: announce target ${uri} is rejected - unfetchable uri`);
							assert.strictEqual(note, null);
							continue;
						}
						assert.ok(note, String(result));
						assert.strictEqual(parentIdOf(note), parentId ?? UNREFERENCEABLE_NOTE_ID);
						assert.deepStrictEqual(await pendingParentsOf(note), []);
					}
				} finally {
					updateMeta(previous);
				}
				assert.deepStrictEqual(localFetches(), []);
			});
		});

		test('With federation none, a reply and a quote of a local note referenced with www. are linked to it or to its former id, and a local id that is not known is decided at once without waiting for it, without fetching them', async () => {
			await onLocalHost(async () => {
				const references = await localParentsReferencedOn('www.local.test');
				const children = await Promise.all(childPaths.filter(path => path.kind !== 2).flatMap(path => references.map(async reference => ({ ...path, ...reference, ...await createActor() }))));
				const previous = { ...meta };
				updateMeta({ ...previous, federation: 'none' });
				try {
					for (const { kind, parentIdOf, uri, parentId, actor, user } of children) {
						const child = receiveChild(kind, actor, uri);
						assert.strictEqual(await inboxService.performOneActivity(user, child.activity, await createJobResolver()), undefined);
						const note = await noteService.fetchNote(child.uri);
						assert.ok(note);
						assert.strictEqual(parentIdOf(note), parentId ?? UNREFERENCEABLE_NOTE_ID);
						assert.deepStrictEqual(await pendingParentsOf(note), []);
					}
				} finally {
					updateMeta(previous);
				}
				assert.deepStrictEqual(localFetches(), []);
			});
		});

		test('With federation none, the target of an Announce of a local note referenced with www. is decided as the note or its former id, and a local id that is not known is rejected at once, without fetching them', async () => {
			await onLocalHost(async () => {
				const references = await localParentsReferencedOn('www.local.test');
				const { actor } = await createActor();
				const previous = { ...meta };
				updateMeta({ ...previous, federation: 'none' });
				try {
					for (const { uri, decision } of references) {
						const announce = createAnnounce(actor, uri);
						assert.strictEqual(decisionOf(await noteService.resolveParent(announce.object, await createJobResolver(), announce.id, new URL(announce.id))), decision);
					}
				} finally {
					updateMeta(previous);
				}
				assert.deepStrictEqual(localFetches(), []);
			});
		});

		test('With federation specified, the parent of a reply, a quote and an Announce on another server is fetched or blocked by its host as the host lists name it, so www. is not taken as the same host there', async () => {
			await onLocalHost(async () => {
				const linked = await Promise.all(childPaths.map(async () => [
					(await postedParent()).id,
					(await postedParent({}, (await createActor('https://www.host3.test')).actor)).id,
				]));
				const blocked = [
					`https://host2.test/notes/${secureRndstr(8)}`,
					`https://host3.test/notes/${secureRndstr(8)}`,
					`https://www.host1.test/notes/${secureRndstr(8)}`,
				];
				const children = await Promise.all(childPaths.flatMap((path, i) => [
					...linked[i].map(uri => ({ uri, fetchable: true })),
					...blocked.map(uri => ({ uri, fetchable: false })),
				].map(async reference => ({ ...path, ...reference, ...await createActor() }))));
				const previous = { ...meta };
				updateMeta({ ...previous, federation: 'specified', federationHosts: ['host1.test', 'www.host3.test'], blockedHosts: ['www.host1.test'] });
				try {
					for (const { kind, parentIdOf, uri, fetchable, actor, user } of children) {
						const child = receiveChild(kind, actor, uri);
						const result = await inboxService.performOneActivity(user, child.activity, await createJobResolver());
						const note = await noteService.fetchNote(child.uri);
						if (!fetchable && kind === 2) {
							assert.strictEqual(result, `skip: announce target ${uri} is rejected - blocked instance`);
							assert.strictEqual(note, null);
							continue;
						}
						assert.ok(note, String(result));
						const expected = fetchable ? (await noteService.fetchNote(uri))?.id : UNREFERENCEABLE_NOTE_ID;
						assert.ok(expected);
						assert.strictEqual(parentIdOf(note), expected);
						assert.deepStrictEqual(await pendingParentsOf(note), []);
					}
				} finally {
					updateMeta(previous);
				}
				assert.deepStrictEqual(linked.flat().map(fetchesOf), linked.flat().map(() => 1));
				assert.deepStrictEqual(blocked.map(fetchesOf), blocked.map(() => 0));
			});
		});

		test.each(['all', 'specified', 'none'] as const)('With federation %s on a server whose host has www., a reply, a quote and an Announce of a local note referenced with or without www. are linked to it or to its former id, and a local id that is not known is decided at once without waiting for it, without fetching them', async federation => {
			await onLocalHost(async () => {
				const references = [...await localParentsReferencedOn('local.test'), ...await localParentsReferencedOn('www.local.test')];
				const children = await Promise.all(childPaths.flatMap(path => references.map(async reference => ({ ...path, ...reference, ...await createActor() }))));
				const previous = { ...meta };
				updateMeta({ ...previous, federation, federationHosts: ['host1.test'] });
				try {
					for (const { kind, parentIdOf, uri, parentId, decision, actor, user } of children) {
						if (kind === 2 && federation === 'none') {
							const announce = createAnnounce(actor, uri);
							assert.strictEqual(decisionOf(await noteService.resolveParent(announce.object, await createJobResolver(), announce.id, new URL(announce.id))), decision);
							continue;
						}
						const child = receiveChild(kind, actor, uri);
						const result = await inboxService.performOneActivity(user, child.activity, await createJobResolver());
						const note = await noteService.fetchNote(child.uri);
						if (parentId == null && kind === 2) {
							assert.strictEqual(result, `skip: announce target ${uri} is rejected - unfetchable uri`);
							assert.strictEqual(note, null);
							continue;
						}
						assert.ok(note, String(result));
						assert.strictEqual(parentIdOf(note), parentId ?? UNREFERENCEABLE_NOTE_ID);
						assert.deepStrictEqual(await pendingParentsOf(note), []);
					}
				} finally {
					updateMeta(previous);
				}
				assert.deepStrictEqual(localFetches(), []);
			}, 'www.local.test');
		});

		test('A parent that is decided from the database alone is decided without its lock, so that a held lock does not change a reply, a quote or an Announce on the last attempt', async () => {
			await onLocalHost(async () => {
				const fragment = `${(await postedParent()).id}#main`;
				const references = [
					...await localParentsReferencedOn('local.test'),
					...await localParentsReferencedOn('www.local.test'),
					{ uri: fragment, parentId: null },
				];
				const children = await Promise.all(childPaths.flatMap(path => references.map(async reference => ({ ...path, ...reference, ...await createActor() }))));
				const unlocks = await Promise.all(references.map(({ uri }) => acquireApObjectLock(redis, uri)));
				try {
					await Promise.all(children.map(async ({ kind, parentIdOf, uri, parentId, actor, user }) => {
						const child = receiveChild(kind, actor, uri);
						const result = await inboxService.performOneActivity(user, child.activity, await createJobResolver(true));
						const note = await noteService.fetchNote(child.uri);
						if (parentId == null && kind === 2) {
							assert.strictEqual(result, `skip: announce target ${uri} is rejected - unfetchable uri`);
							assert.strictEqual(note, null);
							return;
						}
						assert.ok(note, String(result));
						assert.strictEqual(parentIdOf(note), parentId ?? UNREFERENCEABLE_NOTE_ID);
						assert.deepStrictEqual(await pendingParentsOf(note), []);
					}));
				} finally {
					for (const unlock of unlocks) await unlock();
				}
				assert.deepStrictEqual(localFetches(), []);
				assert.strictEqual(fetchesOf(fragment), 0);
			});
		});

		test.each([
			{ hosts: 'blockedHosts names its host with www.', storedOn: 'https://www.host1.test', toReference: (uri: string) => uri.replace('https://www.', 'https://'), hostMeta: { blockedHosts: ['www.host1.test'] } },
			{ hosts: 'federationHosts names its host only with www.', storedOn: 'https://host3.test', toReference: (uri: string) => uri.replace('https://', 'https://www.'), hostMeta: { federation: 'specified' as const, federationHosts: ['host1.test', 'www.host3.test'] } },
		])('When $hosts, a note in the database is neither linked nor announced through the other form of its id, alive or deleted, also from a relay', async ({ storedOn, toReference, hostMeta }) => {
			const { actor: author, user: authorUser } = await createActor(storedOn);
			const parents: { uri: string; deleted: boolean }[] = [];
			for (const deleted of [false, true]) {
				const post = await postedParent({}, author);
				const note = await noteService.createNote(post.id, undefined, await createJobResolver(), true);
				assert.ok(note);
				if (deleted) await noteDeleteService.delete(authorUser, note, true);
				parents.push({ uri: toReference(post.id), deleted });
			}
			const children = await Promise.all(childPaths.flatMap(path => parents.map(async parent => ({ ...path, ...parent, ...await createActor() }))));
			const relay = await createActor();
			const previous = { ...meta };
			updateMeta({ ...previous, ...hostMeta });
			try {
				vi.spyOn(relayService, 'isRelayActor').mockResolvedValue(false);
				for (const { kind, parentIdOf, uri, actor, user } of children) {
					const child = receiveChild(kind, actor, uri);
					const result = await inboxService.performOneActivity(user, child.activity, await createJobResolver());
					const note = await noteService.fetchNote(child.uri);
					if (kind === 2) {
						assert.strictEqual(result, `skip: announce target ${uri} is rejected - blocked instance`);
						assert.strictEqual(note, null);
						continue;
					}
					assert.ok(note, String(result));
					assert.strictEqual(parentIdOf(note), UNREFERENCEABLE_NOTE_ID);
					assert.deepStrictEqual(await pendingParentsOf(note), []);
				}
				vi.spyOn(relayService, 'isRelayActor').mockResolvedValue(true);
				const published = vi.spyOn(globalEventService, 'publishNotesStream');
				for (const { uri, deleted } of parents) {
					const announce = createAnnounce(relay.actor, uri);
					assert.strictEqual(await inboxService.performOneActivity(relay.user, announce, await createJobResolver()), deleted ? `skip: announce target ${uri} is rejected - blocked instance` : undefined);
					assert.strictEqual(await noteService.fetchNote(announce), null);
				}
				assert.deepStrictEqual(published.mock.calls, []);
			} finally {
				updateMeta(previous);
			}
			assert.deepStrictEqual(parents.map(({ uri }) => fetchesOf(uri)), parents.map(() => 0));
		});

		test('A parent whose fetched object has the id with www. on a blocked host is rejected without waiting for it, for a reply, a quote and an Announce', async () => {
			const { actor: author } = await createActor('https://www.host1.test');
			const children = await Promise.all(childPaths.map(async path => {
				const object = createPost(author);
				const uri = object.id.replace('https://www.', 'https://');
				respond(uri, object);
				return { ...path, uri, ...await createActor() };
			}));
			const previous = { ...meta };
			updateMeta({ ...previous, blockedHosts: ['www.host1.test'] });
			try {
				for (const { kind, parentIdOf, uri, actor, user } of children) {
					const child = receiveChild(kind, actor, uri);
					const result = await inboxService.performOneActivity(user, child.activity, await createJobResolver());
					const note = await noteService.fetchNote(child.uri);
					if (kind === 2) {
						assert.strictEqual(result, `skip: announce target ${uri} is rejected - blocked instance`);
						assert.strictEqual(note, null);
						continue;
					}
					assert.ok(note, String(result));
					assert.strictEqual(parentIdOf(note), UNREFERENCEABLE_NOTE_ID);
					assert.deepStrictEqual(await pendingParentsOf(note), []);
				}
			} finally {
				updateMeta(previous);
			}
			assert.deepStrictEqual(children.map(({ uri }) => fetchesOf(uri)), children.map(() => 1));
		});

		test.each(['all', 'specified'] as const)('With federation %s, a relay Announce of a note in the database referenced by the other form of its id publishes nothing, while one of a note that is not in the database publishes it', async federation => {
			await onLocalHost(async () => {
				const remote = await postedParent();
				assert.ok(await noteService.createNote(remote.id, undefined, await createJobResolver(), true));
				const remoteUri = remote.id.replace('https://', 'https://www.');
				const [local] = await localParentsReferencedOn('www.local.test');
				const fresh = await postedParent();
				const { actor, user } = await createActor();
				vi.spyOn(relayService, 'isRelayActor').mockResolvedValue(true);
				const published = vi.spyOn(globalEventService, 'publishNotesStream');
				const previous = { ...meta };
				updateMeta({ ...previous, federation, federationHosts: ['host1.test'] });
				try {
					for (const uri of [remoteUri, local.uri, fresh.id]) {
						assert.strictEqual(await inboxService.performOneActivity(user, createAnnounce(actor, uri), await createJobResolver()), undefined);
					}
				} finally {
					updateMeta(previous);
				}
				const freshNote = await noteService.fetchNote(fresh.id);
				assert.ok(freshNote);
				assert.deepStrictEqual(published.mock.calls.map(([note]) => note.id), [freshNote.id]);
				assert.strictEqual(fetchesOf(remoteUri), 0);
				assert.deepStrictEqual(localFetches(), []);
			});
		});

		test('A parent given without an id is decided at once as an invalid URI for a reply, a quote and an Announce, also from a relay', async () => {
			const { actor: author } = await createActor();
			const { id: _, ...withoutId } = createPost(author);
			const { actor, user } = await createActor();

			for (const object of [withoutId, 42 as unknown as IObject]) {
				for (const fromRelay of [false, true]) {
					vi.spyOn(relayService, 'isRelayActor').mockResolvedValue(fromRelay);
					const announce = createAnnounce(actor, object);
					assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), 'skip: announce target null is rejected - invalid uri');
					assert.strictEqual(await noteService.fetchNote(announce), null);
				}
			}

			for (const data of [{ inReplyTo: withoutId }, { quoteUrl: withoutId as unknown as string }]) {
				const post = createPost(actor, { to: `${actor.id}/followers`, published: '2024-02-01T00:00:20.000Z', ...data });
				assert.strictEqual(await inboxService.performOneActivity(user, createCreate(actor, post), await createJobResolver()), undefined);
				const note = await noteService.fetchNote(post.id);
				assert.ok(note);
				assert.strictEqual('inReplyTo' in data ? note.replyId : note.renoteId, UNREFERENCEABLE_NOTE_ID);
				assert.deepStrictEqual(await pendingParentsOf(note), []);
			}
		});

		test('A parent whose lock cannot be acquired is retried before the last attempt and waited for on the last attempt, for a reply, a quote and an Announce', async () => {
			const parentUri = unfetchableUri();
			const children = await Promise.all(childPaths.map(async path => {
				const { actor, user } = await createActor();
				return { ...path, user, child: receiveChild(path.kind, actor, parentUri) };
			}));
			const unlock = await acquireApObjectLock(redis, parentUri);
			try {
				await Promise.all(children.map(async ({ user, child }) => {
					await assert.rejects(inboxService.performOneActivity(user, child.activity, await createJobResolver()), /Failed to acquire lock/);
					assert.strictEqual(await noteService.fetchNote(child.uri), null);
				}));

				await Promise.all(children.map(async ({ user, child, kind, parentIdOf }) => {
					await inboxService.performOneActivity(user, child.activity, await createJobResolver(true));
					const note = await noteService.fetchNote(child.uri);
					assert.ok(note);
					assert.strictEqual(parentIdOf(note), UNREFERENCEABLE_NOTE_ID);
					assert.deepStrictEqual(await pendingParentsOf(note), [{ parentUri, kind }]);
				}));
			} finally {
				await unlock();
			}
			assert.strictEqual(fetchesOf(parentUri), 0);
		});

		test('A note that replies to or quotes itself is created at once with an unreferenceable parent that is not waited for, and an Announce of itself is skipped at once', async () => {
			const { actor, user } = await createActor();
			for (const [data, parentIdOf] of [
				[(id: string) => ({ inReplyTo: id }), (note: MiNote) => note.replyId],
				[(id: string) => ({ inReplyTo: id.replace('https://', 'https://www.') }), (note: MiNote) => note.replyId],
				[(id: string) => ({ _misskey_quote: id }), (note: MiNote) => note.renoteId],
			] as const) {
				const post = createPost(actor, { to: `${actor.id}/followers`, published: '2024-02-01T00:00:20.000Z' });
				Object.assign(post, data(post.id));
				respond(post.id, post);

				assert.strictEqual(await inboxService.performOneActivity(user, createCreate(actor, post), await createJobResolver()), undefined);

				const note = await noteService.fetchNote(post.id);
				assert.ok(note);
				assert.strictEqual(parentIdOf(note), UNREFERENCEABLE_NOTE_ID);
				assert.deepStrictEqual(await pendingParentsOf(note), []);
			}

			const announce = createAnnounce(actor, '');
			announce.object = announce.id;
			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), `skip: announce target ${announce.id} is rejected - self reference`);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(fetchesOf(announce.id), 0);
		});

		async function recordedFormerIdOf(uri: string): Promise<MiNote['id'] | null> {
			const reference = await apDbResolverService.getNoteReferenceFromApId(uri);
			assert.strictEqual(reference.note, null);
			return reference.formerId;
		}

		test('An Undo of an Announce that has not been received keeps the Announce from being created when it arrives', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);

			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce), await createJobResolver()), 'ok: recorded');

			const formerId = await recordedFormerIdOf(announce.id);
			assert.ok(formerId);
			assert.deepStrictEqual(await db.query('SELECT "id" FROM "deleted_note" WHERE "id" = $1', [formerId]), [{ id: formerId }]);
			assert.deepStrictEqual(await apDbResolverService.getNoteReferenceFromApId(`${config.url}/notes/${formerId}`), { note: null, formerId: null });

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(fetchesOf(post.id), 0);
			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce), await createJobResolver()), 'skip: no such Announce');
			assert.strictEqual(await recordedFormerIdOf(announce.id), formerId);
		});

		test('An Undo of an Announce given only by its URI is recorded when the URI is on the host of the actor and the fetched Announce shows no other actor', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const anonymous = createAnnounce(actor, post.id);
			const { actor: _, ...served } = anonymous;
			respond(anonymous.id, served);
			const own = createAnnounce(actor, post.id);
			respond(own.id, own);

			for (const announce of [anonymous, own]) {
				assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce.id), await createJobResolver()), 'ok: recorded');

				assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
				assert.strictEqual(await noteService.fetchNote(announce), null);
			}
		});

		test('An Undo from another actor neither keeps the Announce from being created nor deletes it', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			respond(announce.id, announce);
			const { actor: other, user: otherUser } = await createActor();
			const { actor: remote, user: remoteUser } = await createActor('https://host2.test');
			const undos: [MiRemoteUser, IUndo][] = [
				[otherUser, createUndo(other, announce)],
				[otherUser, createUndo(other, announce.id)],
				[remoteUser, createUndo(remote, { ...announce, actor: remote.id })],
				[remoteUser, createUndo(remote, announce.id)],
			];

			for (const [undoer, undo] of undos) {
				assert.strictEqual(await inboxService.performOneActivity(undoer, undo, await createJobResolver()), 'skip: no such Announce');
			}
			assert.deepStrictEqual(await apDbResolverService.getNoteReferenceFromApId(announce.id), { note: null, formerId: null });

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			const renote = await noteService.fetchNote(announce);
			assert.ok(renote);

			for (const [undoer, undo] of undos) {
				assert.strictEqual(await inboxService.performOneActivity(undoer, undo, await createJobResolver()), 'skip: no such Announce');
			}
			assert.ok(await noteService.fetchNote(announce));

			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce), await createJobResolver()), 'ok: deleted');
			assert.strictEqual(await recordedFormerIdOf(announce.id), renote.id);
		});

		function gated(): { arrival: Promise<void>; arrived: () => void; gate: Promise<void>; release: () => void } {
			let arrived!: () => void;
			let release!: () => void;
			const arrival = new Promise<void>(resolve => { arrived = resolve; });
			const gate = new Promise<void>(resolve => { release = resolve; });
			return { arrival, arrived, gate, release };
		}

		test('An Undo that arrives while the Announce is fetching its target keeps the renote from being created', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			const { arrival, arrived, gate, release } = gated();
			const getActivityJson = vi.mocked(httpRequestService.getActivityJson);
			const respondFromQueue = getActivityJson.getMockImplementation();
			assert.ok(respondFromQueue);
			getActivityJson.mockImplementation(async (url, ...args) => {
				if (url === post.id) {
					arrived();
					await gate;
				}
				return await respondFromQueue(url, ...args);
			});

			const announcing = inboxService.performOneActivity(user, announce, await createJobResolver());
			await arrival;
			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce), await createJobResolver()), 'ok: recorded');
			release();

			assert.strictEqual(await announcing, undefined);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.ok(await noteService.fetchNote(post.id));
			assert.ok(await recordedFormerIdOf(announce.id));
		});

		test('An Undo that arrives while the renote is being created waits for it and deletes it', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			const { arrival, arrived, gate, release } = gated();
			const create = noteCreateService.create;
			vi.spyOn(noteCreateService, 'create').mockImplementation(async (...args) => {
				if (args[1].uri === announce.id) {
					arrived();
					await gate;
				}
				return await create(...args);
			});

			const announcing = inboxService.performOneActivity(user, announce, await createJobResolver());
			await arrival;
			const undoing = inboxService.performOneActivity(user, createUndo(actor, announce), await createJobResolver());
			await setTimeout(300);
			release();

			assert.strictEqual(await announcing, undefined);
			assert.strictEqual(await undoing, 'ok: deleted');
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.ok(await recordedFormerIdOf(announce.id));
		});

		test('An Announce and its Undo received at the same time never leave a renote', async () => {
			for (let i = 0; i < 5; i++) {
				const post = await postedParent();
				const { actor, user } = await createActor();
				const announce = createAnnounce(actor, post.id);
				const [announceResolver, undoResolver] = await Promise.all([createJobResolver(), createJobResolver()]);

				const [, undone] = await Promise.all([
					inboxService.performOneActivity(user, announce, announceResolver),
					inboxService.performOneActivity(user, createUndo(actor, announce), undoResolver),
				]);

				assert.ok(undone === 'ok: recorded' || undone === 'ok: deleted', String(undone));
				assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
				assert.strictEqual(await noteService.fetchNote(announce), null);
			}
		});

		test('A URI-only Undo of an Announce that can no longer be fetched keeps the retried Announce from creating the renote, while one from another host does not', async () => {
			const post = await postedParent();
			respond(post.id, statusError(503), statusError(503), post);
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			respond(announce.id, statusError(404));
			const other = createAnnounce(actor, post.id);
			respond(other.id, statusError(410));
			const { actor: remote, user: remoteUser } = await createActor('https://host2.test');

			await assert.rejects(inboxService.performOneActivity(user, announce, await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 503);
			await assert.rejects(inboxService.performOneActivity(user, other, await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 503);
			assert.strictEqual(fetchesOf(post.id), 2);

			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce.id), await createJobResolver()), 'ok: recorded');
			await assert.rejects(inboxService.performOneActivity(remoteUser, createUndo(remote, other.id), await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 410);

			const formerId = await recordedFormerIdOf(announce.id);
			assert.ok(formerId);
			assert.deepStrictEqual(await db.query('SELECT "id" FROM "deleted_note" WHERE "id" = $1', [formerId]), [{ id: formerId }]);
			assert.deepStrictEqual(await apDbResolverService.getNoteReferenceFromApId(other.id), { note: null, formerId: null });

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver(true)), undefined);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(fetchesOf(post.id), 2);

			assert.strictEqual(await inboxService.performOneActivity(user, other, await createJobResolver(true)), undefined);
			assert.strictEqual((await noteService.fetchNote(other))?.renoteId, (await noteService.fetchNote(post.id))?.id);
		});

		test('A URI-only Undo of an Announce whose server fails for a while is retried and recorded on the last attempt, and one that can never be fetched is recorded at once', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const announce = createAnnounce(actor, post.id);
			respond(announce.id, statusError(503));
			const fragment = `${actor.id}#announces/${secureRndstr(8)}`;

			await assert.rejects(inboxService.performOneActivity(user, createUndo(actor, announce.id), await createJobResolver()), (err: unknown) => err instanceof StatusError && err.statusCode === 503);
			assert.deepStrictEqual(await apDbResolverService.getNoteReferenceFromApId(announce.id), { note: null, formerId: null });

			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce.id), await createJobResolver(true)), 'ok: recorded');
			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, fragment), await createJobResolver()), 'ok: recorded');
			assert.ok(await recordedFormerIdOf(announce.id));
			assert.ok(await recordedFormerIdOf(fragment));

			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(fetchesOf(post.id), 0);
		});

		test('A URI-only Undo of an Announce that can no longer be fetched deletes the renote created from it, but not a renote of another actor', async () => {
			const post = await postedParent();
			const { actor, user } = await createActor();
			const { actor: other, user: otherUser } = await createActor();
			const announce = createAnnounce(actor, post.id);
			assert.strictEqual(await inboxService.performOneActivity(user, announce, await createJobResolver()), undefined);
			const renote = await noteService.fetchNote(announce);
			assert.ok(renote);
			respond(announce.id, statusError(410));

			assert.strictEqual(await inboxService.performOneActivity(otherUser, createUndo(other, announce.id), await createJobResolver()), 'skip: no such Announce');
			assert.ok(await noteService.fetchNote(announce));

			assert.strictEqual(await inboxService.performOneActivity(user, createUndo(actor, announce.id), await createJobResolver()), 'ok: deleted');
			assert.strictEqual(await noteService.fetchNote(announce), null);
			assert.strictEqual(await recordedFormerIdOf(announce.id), renote.id);
		});

		test('A Create and a Like from an actor whose user row is gone fail with the errors the inbox completes as a skip', async () => {
			const post = await postedParent();
			assert.ok(await noteService.createNote(post.id, undefined, await createJobResolver(), true));
			const { actor, user } = await createActor();
			await db.query('DELETE FROM "user" WHERE "id" = $1', [user.id]);
			const note = createPost(actor, { to: `${actor.id}/followers` });
			const like: ILike = { '@context': 'https://www.w3.org/ns/activitystreams', id: `${actor.id}/likes/${secureRndstr(8)}`, type: 'Like', actor: actor.id, object: post.id, content: '👍' };

			await assert.rejects(inboxService.performOneActivity(user, createCreate(actor, note), await createJobResolver()), (err: unknown) => err instanceof IdentifiableError && err.id === 'e3e4eb00-3a45-49d7-bf8d-959a02f5d2eb');
			await assert.rejects(inboxService.performOneActivity(user, like, await createJobResolver()), (err: unknown) => err instanceof IdentifiableError && err.id === 'cc7e1130-6bf7-4105-adeb-25f799da854f');
			assert.strictEqual(await noteService.fetchNote(note.id), null);
		});
	});
});
