/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, In } from 'typeorm';
import type { UserProfilesRepository, NotesRepository, UsersRepository } from '@/models/_.js';
import type { MiNoteReaction } from '@/models/NoteReaction.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { QueryService } from '@/core/QueryService.js';
import { NoteReactionEntityService } from '@/core/entities/NoteReactionEntityService.js';
import { DI } from '@/di-symbols.js';
import { CacheService } from '@/core/CacheService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { isUserRelated } from '@/misc/is-user-related.js';
import { findUserNoteReactions } from '@/misc/note-reaction-lookup.js';
import { ApiError } from '../../error.js';

export const meta = {
	tags: ['users', 'reactions'],

	requireCredential: false,

	description: 'Show all reactions this user made.',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'NoteReactionWithNote',
		},
	},

	errors: {
		reactionsNotPublic: {
			message: 'Reactions of the user is not public.',
			code: 'REACTIONS_NOT_PUBLIC',
			id: '673a7dd2-6924-1093-e0c0-e68456ceae5c',
		},
		isRemoteUser: {
			message: 'Currently unavailable to display reactions of remote users. See https://github.com/misskey-dev/misskey/issues/12964',
			code: 'IS_REMOTE_USER',
			id: '6b95fa98-8cf9-2350-e284-f0ffdb54a805',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		userId: { type: 'string', format: 'misskey:id' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
	},
	required: ['userId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private cacheService: CacheService,
		private userEntityService: UserEntityService,
		private noteReactionEntityService: NoteReactionEntityService,
		private queryService: QueryService,
		private idService: IdService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const userIdsWhoBlockingMe = me ? await this.cacheService.userBlockedCache.fetch(me.id) : new Set<string>();
			const iAmModerator = me ? await this.roleService.isModerator(me) : false; // Moderators can see reactions of all users
			if (!iAmModerator) {
				const user = await this.cacheService.findUserById(ps.userId);
				if (this.userEntityService.isRemoteUser(user)) {
					throw new ApiError(meta.errors.isRemoteUser);
				}

				const profile = await this.userProfilesRepository.findOneByOrFail({ userId: ps.userId });
				if ((me == null || me.id !== ps.userId) && !profile.publicReactions) {
					throw new ApiError(meta.errors.reactionsNotPublic);
				}

				// early return if me is blocked by requesting user
				if (userIdsWhoBlockingMe.has(ps.userId)) {
					return [];
				}
			} else if (!await this.usersRepository.existsBy({ id: ps.userId })) {
				return [];
			}

			const visible = this.notesRepository.createQueryBuilder('note');
			this.queryService.generateVisibilityQuery(visible, me);
			if (this.queryService.isAlwaysEmpty(visible)) return [];

			const userIdsWhoMeMuting = me ? await this.cacheService.userMutingsCache.fetch(me.id) : new Set<string>();

			const byId = ps.sinceId != null || ps.untilId != null;
			let sinceId = byId ? ps.sinceId : ps.sinceDate ? this.idService.gen(ps.sinceDate, true) : undefined;
			let untilId = byId ? ps.untilId : ps.untilDate ? this.idService.gen(ps.untilDate, true) : undefined;
			const ascending = sinceId != null && untilId == null;

			const hydratedReactions: MiNoteReaction[] = [];

			for (;;) {
				const page = await findUserNoteReactions(this.db, ps.userId, { sinceId, untilId, ascending, limit: ps.limit }, this.idService.gen(Date.now(), true));
				if (page.length === 0) break;

				const cursor = page[page.length - 1].id;
				if (ascending) {
					sinceId = cursor;
				} else {
					untilId = cursor;
				}

				const notesQuery = this.notesRepository.createQueryBuilder('note')
					.where({ id: In(page.map(reaction => reaction.noteId)) })
					.innerJoinAndSelect('note.user', 'user');

				this.queryService.generateVisibilityQuery(notesQuery, me);
				this.queryService.generateBlockedHostQueryForNote(notesQuery);
				this.queryService.generateSuspendedUserQueryForNote(notesQuery);

				const fetchedNotes = await notesQuery.getMany();
				await this.queryService.attachReplyAndRenote(fetchedNotes);
				const notes = new Map(fetchedNotes.map(note => [note.id, note]));

				for (const reaction of page) {
					reaction.note = notes.get(reaction.noteId) ?? null;
				}

				hydratedReactions.push(...page.filter(reaction => reaction.note != null));

				if (hydratedReactions.length >= ps.limit || page.length < ps.limit) break;
			}

			const reactions = hydratedReactions.slice(0, ps.limit).filter(reaction => {
				if (reaction.note?.userId === ps.userId) return true; // we can see reactions to note of requesting user
				if (me && isUserRelated(reaction.note, userIdsWhoBlockingMe)) return false;
				if (me && isUserRelated(reaction.note, userIdsWhoMeMuting)) return false;

				return true;
			});

			return await this.noteReactionEntityService.packManyWithNote(reactions, me);
		});
	}
}
