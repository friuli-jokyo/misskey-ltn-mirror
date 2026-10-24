/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource, IsNull, MoreThan, Not } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { DriveFilesRepository, FollowingsRepository, NotesRepository, PagesRepository, UserProfilesRepository, UsersRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { DriveService } from '@/core/DriveService.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import type { MiNote } from '@/models/Note.js';
import type { MiLocalUser, MiUser } from '@/models/User.js';
import { EmailService } from '@/core/EmailService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { bindThis } from '@/decorators.js';
import { SearchService } from '@/core/SearchService.js';
import { PageService } from '@/core/PageService.js';
import { QueryService } from '@/core/QueryService.js';
import { QueueService } from '@/core/QueueService.js';
import { ApRendererService } from '@/core/activitypub/ApRendererService.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { nextPrefix, ordinalToPrefix, prefixesAscending } from '@/misc/partition.js';
import { deleteNotesWithDependents } from '@/misc/note-dependents.js';
import { deleteAfterRekey } from '@/misc/join-pending-children.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { DbJobDataWithUser, DbUserDeleteJobData } from '../types.js';

@Injectable()
export class DeleteAccountProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.userProfilesRepository)
		private userProfilesRepository: UserProfilesRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		@Inject(DI.driveFilesRepository)
		private driveFilesRepository: DriveFilesRepository,

		@Inject(DI.pagesRepository)
		private pagesRepository: PagesRepository,

		@Inject(DI.followingsRepository)
		private followingsRepository: FollowingsRepository,

		private driveService: DriveService,
		private pageService: PageService,
		private emailService: EmailService,
		private globalEventService: GlobalEventService,
		private idService: IdService,
		private queueLoggerService: QueueLoggerService,
		private searchService: SearchService,
		private queryService: QueryService,
		private queueService: QueueService,
		private apRendererService: ApRendererService,
		private userEntityService: UserEntityService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('delete-account');
	}

	@bindThis
	private async deliverDeleteOf(user: MiLocalUser): Promise<void> {
		const content = this.apRendererService.addContext(this.apRendererService.renderDelete(this.userEntityService.genLocalUserUri(user.id), user));

		const queue: string[] = [];

		const followings = await this.followingsRepository.find({
			where: [
				{ followerSharedInbox: Not(IsNull()) },
				{ followeeSharedInbox: Not(IsNull()) },
			],
			select: {
				followerSharedInbox: true,
				followeeSharedInbox: true,
			},
		});

		const inboxes = followings.map(x => x.followerSharedInbox ?? x.followeeSharedInbox);

		for (const inbox of inboxes) {
			if (inbox != null && !queue.includes(inbox)) queue.push(inbox);
		}

		await Promise.all(queue.map(inbox => this.queueService.deliver(user, content, inbox, true, true, `deleteAccount-${user.id}-${createHash('sha256').update(inbox).digest('hex')}`)));
	}

	@bindThis
	private async deleteNotes(notes: MiNote[]): Promise<void> {
		await deleteAfterRekey(this.db, this.idService, notes.map(note => note.id), async transactionalEntityManager => {
			await deleteNotesWithDependents(transactionalEntityManager, notes.map(note => note.id), { record: true });
		});

		for (const note of notes) {
			await this.searchService.unindexNote(note);
		}
	}

	@bindThis
	private async deleteNotesOf(user: { id: MiUser['id'] }, floorKey: string | undefined): Promise<void> {
		let cursor: MiNote['id'] | null = null;

		while (true) {
			const query = this.notesRepository.createQueryBuilder('note')
				.where('note.userId = :userId', { userId: user.id })
				.orderBy('note.id', 'ASC');
			if (cursor) query.andWhere('note.id > :cursor', { cursor });

			const notes: MiNote[] = await this.queryService.fetchPaginationQueryAcrossPartitions(query, { sinceId: cursor ?? floorKey ?? ordinalToPrefix(0) }, 100, { floorKey });

			if (notes.length === 0) {
				break;
			}

			cursor = notes.at(-1)?.id ?? null;

			await this.deleteNotes(notes);

			if (notes.length < 100) {
				break;
			}
		}
	}

	@bindThis
	private async deleteNotesSentAnonymouslyTo(user: { id: MiUser['id'] }): Promise<void> {
		for (const prefix of prefixesAscending()) {
			const upper = nextPrefix(prefix);
			let cursor: MiNote['id'] | null = null;

			while (true) {
				const query = this.notesRepository.createQueryBuilder('note')
					.where('note.anonymouslySendToUserId = :userId', { userId: user.id })
					.andWhere(`note.id >= '${prefix}'`)
					.orderBy('note.id', 'ASC')
					.limit(100);
				if (upper != null) query.andWhere(`note.id < '${upper}'`);
				if (cursor) query.andWhere('note.id > :cursor', { cursor });

				const notes = await query.getMany();

				if (notes.length === 0) {
					break;
				}

				cursor = notes.at(-1)?.id ?? null;

				await this.deleteNotes(notes);

				if (notes.length < 100) {
					break;
				}
			}
		}
	}

	@bindThis
	private async deleteFilesOf(user: MiUser): Promise<void> {
		let cursor: MiDriveFile['id'] | null = null;

		while (true) {
			const files = await this.driveFilesRepository.find({
				where: {
					userId: user.id,
					...(cursor ? { id: MoreThan(cursor) } : {}),
				},
				take: 10,
				order: {
					id: 1,
				},
			}) as MiDriveFile[];

			if (files.length === 0) {
				break;
			}

			cursor = files.at(-1)?.id ?? null;

			for (const file of files) {
				await this.driveService.deleteFileSync(file);
			}
		}
	}

	@bindThis
	private async deletePagesOf(user: MiUser): Promise<void> {
		while (true) {
			const pages = await this.pagesRepository.find({
				where: {
					userId: user.id,
				},
				take: 100,
				order: {
					id: 1,
				},
			});

			if (pages.length === 0) {
				break;
			}
			for (const page of pages) {
				await this.pageService.delete(user, page.id);
			}
		}
	}

	@bindThis
	private async deleteReactionsOf(user: { id: MiUser['id'] }): Promise<void> {
		for (const prefix of prefixesAscending()) {
			const upper = nextPrefix(prefix);
			await this.db.query(
				`DELETE FROM "note_reaction" WHERE "userId" = $1 AND "noteId" >= '${prefix}'${upper != null ? ` AND "noteId" < '${upper}'` : ''}`,
				[user.id],
			);
		}
	}

	@bindThis
	private async deleteRemainsOf(user: { id: MiUser['id'] }, floorKey: string | undefined): Promise<void> {
		this.globalEventService.publishInternalEvent('userChangeDeletedState', { id: user.id, isDeleted: true });
		await this.deleteReactionsOf(user);
		await this.deleteNotesSentAnonymouslyTo(user);
		await this.deleteNotesOf(user, floorKey);
	}

	@bindThis
	public async process(job: Bull.Job<DbUserDeleteJobData>): Promise<string | void> {
		this.logger.info(`Deleting account of ${job.data.user.id} ...`);

		const user = await this.usersRepository.findOneBy({ id: job.data.user.id });
		if (user == null) {
			if (!job.data.soft) await this.deleteRemainsOf(job.data.user, ordinalToPrefix(0));
			return;
		}

		await this.usersRepository.update({ id: user.id, isDeleted: false }, { isDeleted: true });
		this.globalEventService.publishInternalEvent('userChangeDeletedState', { id: user.id, isDeleted: true });

		if (this.userEntityService.isLocalUser(user)) {
			await this.deliverDeleteOf(user);
		}

		{ // Delete notes
			await this.deleteNotesOf(user, await this.queryService.noteFloorOf(user));

			this.logger.succ('All of notes deleted');
		}

		{ // Delete files
			await this.deleteFilesOf(user);

			this.logger.succ('All of files deleted');
		}

		{
			// delete pages. Necessary for decrementing pageCount of notes.
			await this.deletePagesOf(user);
		}

		// soft指定されている場合は物理削除しない
		if (job.data.soft) {
		// nop
		} else {
			await this.deleteReactionsOf(user);
			await this.deleteNotesSentAnonymouslyTo(user);
			await this.deleteNotesOf(user, await this.queryService.noteFloorOf(user));
			if (user.host == null) {
				await this.queueService.createPurgeAccountJob(user);
			} else {
				await this.usersRepository.delete({ id: user.id, isDeleted: true });
				await this.deleteRemainsOf(user, ordinalToPrefix(0));
			}
		}

		{ // Send email notification
			const profile = await this.userProfilesRepository.findOneBy({ userId: user.id });
			if (profile?.email && profile.emailVerified) {
				this.emailService.sendEmail(profile.email, 'Account deleted',
					'Your account has been deleted.',
					'Your account has been deleted.');
			}
		}

		return 'Account deleted';
	}

	@bindThis
	public async processPurge(job: Bull.Job<DbJobDataWithUser>): Promise<string | void> {
		this.logger.info(`Purging account of ${job.data.user.id} ...`);

		const user = await this.usersRepository.findOneBy({ id: job.data.user.id });
		if (user != null && !user.isDeleted) {
			return;
		}

		if (user != null) {
			await this.deleteNotesOf(user, await this.queryService.noteFloorOf(user));
			await this.deleteFilesOf(user);
			await this.deletePagesOf(user);
			await this.deleteReactionsOf(user);
			await this.deleteNotesSentAnonymouslyTo(user);
			await this.deleteNotesOf(user, await this.queryService.noteFloorOf(user));

			await this.usersRepository.delete({ id: user.id, isDeleted: true });
		}

		await this.deleteRemainsOf(job.data.user, await this.queryService.noteFloorOf({ id: job.data.user.id, host: null }));

		return 'Account purged';
	}
}
