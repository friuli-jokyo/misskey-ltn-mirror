/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { TextEncoderStream, TransformStream } from 'node:stream/web';
import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { format as dateFormat } from 'date-fns';
import { DI } from '@/di-symbols.js';
import type { MiUser, NotesRepository, PollsRepository, UsersRepository } from '@/models/_.js';
import type Logger from '@/logger.js';
import { DriveService } from '@/core/DriveService.js';
import { createTemp } from '@/misc/create-temp.js';
import type { MiPoll } from '@/models/Poll.js';
import type { MiNote } from '@/models/Note.js';
import { bindThis } from '@/decorators.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { Packed } from '@/misc/json-schema.js';
import { IdService } from '@/core/IdService.js';
import { NotificationService } from '@/core/NotificationService.js';
import { JsonArrayStream } from '@/misc/JsonArrayStream.js';
import { FileWriterStream } from '@/misc/FileWriterStream.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';
import type { DbJobDataWithUser } from '../types.js';
import { Readable } from 'node:stream';

type MiNoteRaw = {
	[T in keyof MiNote as `note_${T}`]: MiNote[T];
};

class NoteStream extends TransformStream<MiNoteRaw, Record<string, unknown>> {
	constructor(
		job: Bull.Job,
		pollsRepository: PollsRepository,
		driveFileEntityService: DriveFileEntityService,
		idService: IdService,
		user: MiUser,
	) {
		let exportedNotesCount = 0;

		const serialize = (
			note: MiNoteRaw,
			poll: MiPoll | null,
			files: Packed<'DriveFile'>[],
		): Record<string, unknown> => {
			return {
				id: note.note_id,
				text: note.note_text,
				createdAt: idService.parse(note.note_id).date.toISOString(),
				fileIds: note.note_fileIds,
				files: files,
				replyId: note.note_replyId,
				renoteId: note.note_renoteId,
				poll: poll,
				cw: note.note_cw,
				visibility: note.note_visibility,
				visibleUserIds: note.note_visibleUserIds,
				localOnly: note.note_localOnly,
				reactionAcceptance: note.note_reactionAcceptance,
			};
		};

		super({
			async transform(chunk, controller) {
				const poll = chunk.note_hasPoll
					? await pollsRepository.findOneByOrFail({ noteId: chunk.note_id }) // N+1
					: null;
				const files = await driveFileEntityService.packManyByIds(chunk.note_fileIds); // N+1
				const content = serialize(chunk, poll, files);
				controller.enqueue(content);
				job.updateProgress(100 * ++exportedNotesCount / user.notesCount);
			},
		});
	}
}

@Injectable()
export class ExportNotesProcessorService {
	private logger: Logger;

	constructor(
		@Inject(DI.dbLong)
		private dbLong: DataSource,

		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.notesRepository)
		private notesRepository: NotesRepository,

		private driveService: DriveService,
		private queueLoggerService: QueueLoggerService,
		private driveFileEntityService: DriveFileEntityService,
		private idService: IdService,
		private notificationService: NotificationService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('export-notes');
	}

	@bindThis
	public async process(job: Bull.Job<DbJobDataWithUser>): Promise<void> {
		this.logger.info(`Exporting notes of ${job.data.user.id} ...`);

		const user = await this.usersRepository.findOneBy({ id: job.data.user.id });
		if (user == null) {
			return;
		}

		// Create temp file
		const [path, cleanup] = await createTemp();

		this.logger.info(`Temp file is ${path}`);

		const queryRunner = this.dbLong.createQueryRunner();
		try {
			// メモリが足りなくならないようにストリームで処理する
			await Readable.toWeb(
				await this.notesRepository.createQueryBuilder('note', queryRunner)
					.where('note.userId = :userId', { userId: user.id })
					.orderBy('note.id')
					.stream(),
			)
				.pipeThrough(new NoteStream(job, this.pollsRepository, this.driveFileEntityService, this.idService, user))
				.pipeThrough(new JsonArrayStream())
				.pipeThrough(new TextEncoderStream())
				.pipeTo(new FileWriterStream(path));

			this.logger.succ(`Exported to: ${path}`);

			const fileName = 'notes-' + dateFormat(new Date(), 'yyyy-MM-dd-HH-mm-ss') + '.json';
			const driveFile = await this.driveService.addFile({ user, path, name: fileName, force: true, ext: 'json' });

			this.logger.succ(`Exported to: ${driveFile.id}`);

			this.notificationService.createNotification(user.id, 'exportCompleted', {
				exportedEntity: 'note',
				fileId: driveFile.id,
			});
		} finally {
			await queryRunner.release();
			cleanup();
		}
	}
}
