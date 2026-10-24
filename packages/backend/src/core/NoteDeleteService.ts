/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { DataSource, In, IsNull, Not } from 'typeorm';
import { Injectable, Inject } from '@nestjs/common';
import type { MiUser, MiLocalUser, MiRemoteUser } from '@/models/User.js';
import type { MiNote, IMentionedRemoteUsers } from '@/models/Note.js';
import type { InstancesRepository, MiMeta, NotesRepository, NoteRelationsRepository, UsersRepository } from '@/models/_.js';
import { RelayService } from '@/core/RelayService.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { IdService } from '@/core/IdService.js';
import NotesChart from '@/core/chart/charts/notes.js';
import PerUserNotesChart from '@/core/chart/charts/per-user-notes.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { ApDeliverManagerService } from '@/core/activitypub/ApDeliverManagerService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { bindThis } from '@/decorators.js';
import { SearchService } from '@/core/SearchService.js';
import { ModerationLogService } from '@/core/ModerationLogService.js';
import { isQuote, isRenote } from '@/misc/is-renote.js';
import { chunk, unique } from '@/misc/prelude/array.js';
import { deleteNoteDependents, recordDeletedNotes } from '@/misc/note-dependents.js';
import { deleteAfterRekey } from '@/misc/join-pending-children.js';

@Injectable()
export class NoteDeleteService {
	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.noteRelationsRepository)
		private noteRelationsRepository: NoteRelationsRepository,

		@Inject(DI.instancesRepository)
		private instancesRepository: InstancesRepository,

		private idService: IdService,
		private userEntityService: UserEntityService,
		private globalEventService: GlobalEventService,
		private relayService: RelayService,
		private federatedInstanceService: FederatedInstanceService,
		private apRendererService: ApRendererService,
		private apDeliverManagerService: ApDeliverManagerService,
		private searchService: SearchService,
		private moderationLogService: ModerationLogService,
		private notesChart: NotesChart,
		private perUserNotesChart: PerUserNotesChart,
		private instanceChart: InstanceChart,
	) {}

	/**
	 * 投稿を削除します。
	 * @param user 投稿者
	 * @param note 投稿
	 */
	async delete(user: { id: MiUser['id']; uri: MiUser['uri']; host: MiUser['host']; isBot: MiUser['isBot']; }, note: MiNote, quiet = false, deleter?: MiUser) {
		const deletedAt = new Date();

		if (!quiet) {
			this.globalEventService.publishNoteStream(note, 'deleted', {
				deletedAt: deletedAt,
			});

			//#region ローカルの投稿なら削除アクティビティを配送
			if (this.userEntityService.isLocalUser(user) && !note.localOnly) {
				let announced: string | undefined;

				// if deleted note is renote
				if (isRenote(note) && !isQuote(note)) {
					const { renoteId, renoteUri } = await this.apRendererService.getOriginalParentIds(note);
					announced = renoteId != null ? await this.apRendererService.renderNoteUri(renoteId, renoteUri) : undefined;
				}

				const content = this.apRendererService.addContext(announced != null
					? this.apRendererService.renderUndo(this.apRendererService.renderAnnounce(announced, note), user)
					: this.apRendererService.renderDelete(this.apRendererService.renderTombstone(`${this.config.url}/notes/${note.id}`), user));

				this.deliverToConcerned(user, note, content);
			}
			//#endregion

			this.notesChart.update(note, false);
			if (this.meta.enableChartsForRemoteUser || (user.host == null) && !note.anonymouslySendToUserId && !note.anonymousChannelUsername) {
				this.perUserNotesChart.update(user, note, false);
			}

			if (this.meta.enableStatsForFederatedInstances) {
				if (this.userEntityService.isRemoteUser(user)) {
					this.federatedInstanceService.fetchOrRegister(user.host).then(async i => {
						this.instancesRepository.decrement({ id: i.id }, 'notesCount', 1);
						if (this.meta.enableChartsForFederatedInstances) {
							this.instanceChart.updateNote(i.host, note, false);
						}
					});
				}
			}
		}

		this.searchService.unindexNote(note);

		const deleted = await deleteAfterRekey(this.db, this.idService, [note.id], async transactionalEntityManager => {
			const [rows]: [Pick<MiNote, 'id' | 'uri' | 'replyId'>[], number] = await transactionalEntityManager.query(
				'DELETE FROM "note" WHERE "id" = $1 AND "userId" = $2 RETURNING "id", "uri", "replyId"',
				[note.id, user.id],
			);
			await recordDeletedNotes(transactionalEntityManager, rows);
			await deleteNoteDependents(transactionalEntityManager, rows.map(row => row.id));
			return rows.at(0);
		});

		if (deleted?.replyId != null && deleted.replyId !== UNREFERENCEABLE_NOTE_ID) {
			await this.notesRepository.decrement({ id: deleted.replyId }, 'repliesCount', 1);
		}

		if (deleter && ((note.userId !== deleter.id) || note.anonymouslySendToUserId || note.anonymousChannelUsername)) {
			const user = await this.usersRepository.findOneByOrFail({ id: note.userId });
			this.moderationLogService.log(deleter, 'deleteNote', {
				noteId: note.id,
				noteUserId: note.userId,
				noteUserUsername: user.username,
				noteUserHost: user.host,
				note: note,
			});
		}
	}

	@bindThis
	private async getMentionedRemoteUsers(note: MiNote) {
		const where = [] as any[];

		// mention / reply / dm
		const uris = (JSON.parse(note.mentionedRemoteUsers) as IMentionedRemoteUsers).map(x => x.uri);
		if (uris.length > 0) {
			where.push(
				{ uri: In(uris) },
			);
		}

		// renote / quote
		if (note.renoteUserId) {
			where.push({
				id: note.renoteUserId,
			});
		}

		if (where.length === 0) return [];

		return await this.usersRepository.find({
			where,
		}) as MiRemoteUser[];
	}

	@bindThis
	private async getRenotedOrRepliedRemoteUsers(note: MiNote) {
		const relations = await this.noteRelationsRepository.findBy({
			parentId: note.id,
		});

		const remoteUsers: MiRemoteUser[] = [];

		for (const childIds of chunk(unique(relations.map(relation => relation.childId)), 100)) {
			const notes = await this.notesRepository.find({
				where: {
					id: In(childIds),
					userHost: Not(IsNull()),
				},
				relations: {
					user: true,
				},
			}) as (MiNote & { user: MiRemoteUser })[];

			remoteUsers.push(...notes.map(({ user }) => user));
		}

		return remoteUsers;
	}

	@bindThis
	private async deliverToConcerned(user: { id: MiLocalUser['id']; host: null; }, note: MiNote, content: any) {
		this.apDeliverManagerService.deliverToFollowers(user, content);
		this.relayService.deliverToRelays(user, content);
		this.apDeliverManagerService.deliverToUsers(user, content, [
			...await this.getMentionedRemoteUsers(note),
			...await this.getRenotedOrRepliedRemoteUsers(note),
		]);
	}
}
