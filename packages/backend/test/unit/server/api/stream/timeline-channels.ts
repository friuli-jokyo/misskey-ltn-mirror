/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { EventEmitter } from 'node:events';
import { setImmediate } from 'node:timers/promises';
import { describe, expect, test } from 'vitest';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { HomeTimelineChannel } from '@/server/api/stream/channels/home-timeline.js';
import { HybridTimelineChannel } from '@/server/api/stream/channels/hybrid-timeline.js';
import { LocalTimelineChannel } from '@/server/api/stream/channels/local-timeline.js';
import { UserListChannel } from '@/server/api/stream/channels/user-list.js';
import type { MetaService } from '@/core/MetaService.js';
import type { RoleService } from '@/core/RoleService.js';
import type { NoteEntityService } from '@/core/entities/NoteEntityService.js';
import type { Packed } from '@/misc/json-schema.js';
import type { UserListMembershipsRepository, UserListsRepository } from '@/models/_.js';
import type Channel from '@/server/api/stream/channel.js';
import type Connection from '@/server/api/stream/Connection.js';
import type { NoteStreamingHidingService } from '@/server/api/stream/NoteStreamingHidingService.js';

const authorId = 'author0000';
const viewerId = 'viewer0000';
const otherId = 'other00000';

type Opened = { channel: Channel; deliver: (note: Packed<'Note'>) => Promise<boolean> };

type Opener = (viewer: string, withReplies: boolean) => Promise<Opened>;

const noteEntityService = { populateMyReaction: async () => null, withMyRenoteReaction: async (note: Packed<'Note'>) => note } as unknown as NoteEntityService;
const noteStreamingHidingService = { filter: async (note: Packed<'Note'>) => note } as unknown as NoteStreamingHidingService;
const metaService = {} as MetaService;
const roleService = { getUserPolicies: async () => ({ ltlAvailable: true }) } as unknown as RoleService;

function packed(id: string, data: Partial<Packed<'Note'>> = {}, userId = authorId): Packed<'Note'> {
	return {
		id,
		createdAt: new Date().toISOString(),
		userId,
		user: { id: userId, username: userId, host: null } as Packed<'UserLite'>,
		text: `note ${id}`,
		cw: null,
		visibility: 'public',
		localOnly: false,
		reactionAcceptance: null,
		renoteCount: 0,
		repliesCount: 0,
		reactionCount: 0,
		reactions: {},
		reactionEmojis: {},
		fileIds: [],
		files: [],
		replyId: null,
		renoteId: null,
		...data,
	} as Packed<'Note'>;
}

function connect(viewer: string, following: Connection['following']): { connection: Connection; subscriber: EventEmitter; sent: string[] } {
	const subscriber = new EventEmitter();
	const sent: string[] = [];
	const connection = {
		user: { id: viewer },
		userProfile: null,
		following,
		followingChannels: new Set<string>(),
		mutingChannels: new Set<string>(),
		userIdsWhoMeMuting: new Set<string>(),
		userIdsWhoBlockingMe: new Set<string>(),
		userIdsWhoMeMutingRenotes: new Set<string>(),
		userMutedInstances: new Set<string>(),
		subscriber,
		sendMessageToWs: (_: string, payload: { body: { id: string } }) => {
			sent.push(payload.body.id);
		},
	} as unknown as Connection;
	return { connection, subscriber, sent };
}

function opened(channel: Channel, subscriber: EventEmitter, sent: string[]): Opened {
	return {
		channel,
		deliver: async note => {
			sent.length = 0;
			await Promise.all(subscriber.listeners('notesStream').map(listener => listener(note)));
			return sent.includes(note.id);
		},
	};
}

const following = (viewer: string, withReplies: boolean): Connection['following'] => viewer === authorId ? {} : { [authorId]: { withReplies } };

const homeTimeline: Opener = async (viewer, withReplies) => {
	const { connection, subscriber, sent } = connect(viewer, following(viewer, withReplies));
	const channel = new HomeTimelineChannel({ id: 'channel', connection }, noteEntityService, noteStreamingHidingService);
	await channel.init({});
	return opened(channel, subscriber, sent);
};

const hybridTimeline: Opener = async (viewer, withReplies) => {
	const { connection, subscriber, sent } = connect(viewer, following(viewer, false));
	const channel = new HybridTimelineChannel({ id: 'channel', connection }, metaService, roleService, noteEntityService, noteStreamingHidingService);
	await channel.init({ withReplies, withPromotes: false });
	return opened(channel, subscriber, sent);
};

const localTimeline: Opener = async (viewer, withReplies) => {
	const { connection, subscriber, sent } = connect(viewer, following(viewer, withReplies));
	const channel = new LocalTimelineChannel({ id: 'channel', connection }, metaService, roleService, noteEntityService, noteStreamingHidingService);
	await channel.init({ withPromotes: false });
	return opened(channel, subscriber, sent);
};

const userList: Opener = async (viewer, withReplies) => {
	const { connection, subscriber, sent } = connect(viewer, {});
	const userListsRepository = { exists: async () => true } as unknown as UserListsRepository;
	const userListMembershipsRepository = { find: async () => [{ userId: authorId, withReplies }] } as unknown as UserListMembershipsRepository;
	const channel = new UserListChannel(userListsRepository, userListMembershipsRepository, { id: 'channel', connection }, noteEntityService, noteStreamingHidingService);
	await channel.init({ listId: 'list000000' });
	await setImmediate();
	return opened(channel, subscriber, sent);
};

async function deliverTo(open: Opener, viewer: string, withReplies: boolean, note: Packed<'Note'>): Promise<boolean> {
	const { channel, deliver } = await open(viewer, withReplies);
	try {
		return await deliver(note);
	} finally {
		channel.dispose?.();
	}
}

const unknownParents: [string, Partial<Packed<'Note'>>][] = [
	['a parent that cannot be referenced', { replyId: UNREFERENCEABLE_NOTE_ID, reply: null }],
	['a deleted parent', { replyId: 'deleted000', reply: null }],
];

describe.each<[string, Opener]>([
	['homeTimeline', homeTimeline],
	['hybridTimeline', hybridTimeline],
	['localTimeline', localTimeline],
	['userList', userList],
])('the %s channel', (_, open) => {
	test('sends a note of the followed user that is not a reply', async () => {
		expect(await deliverTo(open, viewerId, false, packed('note000000'))).toBe(true);
	});

	describe.each(unknownParents)('a reply to %s', (__, parent) => {
		test('is not sent without withReplies', async () => {
			expect(await deliverTo(open, viewerId, false, packed('reply00000', parent))).toBe(false);
		});

		test('is sent with withReplies', async () => {
			expect(await deliverTo(open, viewerId, true, packed('reply00000', parent))).toBe(true);
		});

		test('is sent to its author without withReplies', async () => {
			expect(await deliverTo(open, authorId, false, packed('reply00000', parent))).toBe(true);
		});
	});
});

describe.each<[string, Opener]>([
	['homeTimeline', homeTimeline],
	['hybridTimeline', hybridTimeline],
])('the %s channel', (_, open) => {
	describe.each(unknownParents)('a renote of a reply to %s', (__, parent) => {
		const renote = () => packed('renote0000', { text: null, renoteId: 'reply00000', renote: packed('reply00000', parent, otherId) });

		test('is not sent without withReplies', async () => {
			expect(await deliverTo(open, viewerId, false, renote())).toBe(false);
		});

		test('is sent with withReplies', async () => {
			expect(await deliverTo(open, viewerId, true, renote())).toBe(true);
		});

		test('is sent to its author without withReplies', async () => {
			expect(await deliverTo(open, authorId, false, renote())).toBe(true);
		});
	});

	test('sends a renote of a note that is not a reply without withReplies', async () => {
		expect(await deliverTo(open, viewerId, false, packed('renote0000', { text: null, renoteId: 'note000000', renote: packed('note000000', {}, otherId) }))).toBe(true);
	});
});
