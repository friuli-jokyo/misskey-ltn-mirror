/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { MiNoteThreadMuting } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { GetterService } from '@/server/api/GetterService.js';
import { IdService } from '@/core/IdService.js';
import { DI } from '@/di-symbols.js';
import { findRekeyRootsForUnmuting, hasReplyEdge, rekeyJoinedChildren } from '@/misc/join-pending-children.js';
import { lockNoteRowsInIdOrder } from '@/misc/note-dependents.js';
import { unique } from '@/misc/prelude/array.js';
import type { MiNote } from '@/models/_.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['notes'],

	requireCredential: true,

	kind: 'write:account',

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'bddd57ac-ceb3-b29d-4334-86ea5fae481a',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
	},
	required: ['noteId'],
} as const;

class RekeyPendingError extends Error {}

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.db)
		private db: DataSource,

		private getterService: GetterService,
		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(err => {
				if (err.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw err;
			});

			const capped = new Set<MiNote['id']>();
			let threadId = note.threadId ?? note.id;
			for (;;) {
				const lookup = await findRekeyRootsForUnmuting(this.db, me.id, note.id, threadId);
				const roots = lookup.roots.filter(root => !capped.has(root.id));
				if (roots.length > 0) {
					if (!await rekeyJoinedChildren(this.db, this.idService, roots)) {
						for (const root of roots) capped.add(root.id);
					}
				} else {
					const unmuted = await this.db.transaction('READ COMMITTED', async transactionalEntityManager => {
						const locked = (await lockNoteRowsInIdOrder(transactionalEntityManager, unique([note.id, threadId]), 'KEY SHARE')).find(row => row.id === note.id);
						if (locked == null) return false;
						if ((locked.threadId ?? locked.id) !== threadId) return null;
						await transactionalEntityManager.delete(MiNoteThreadMuting, {
							threadId,
							userId: me.id,
						});
						if (await hasReplyEdge(transactionalEntityManager, lookup.unlinkedIds)) throw new RekeyPendingError();
						return true;
					}).catch((e: unknown) => {
						if (e instanceof RekeyPendingError) return null;
						throw e;
					});

					if (unmuted === false) {
						throw new ApiError(meta.errors.noSuchNote);
					}
					if (unmuted) return;
				}
				const rows: Pick<MiNote, 'threadId'>[] = await this.db.query('SELECT "threadId" FROM "note" WHERE "id" = $1', [note.id]);
				if (rows.length === 0) {
					throw new ApiError(meta.errors.noSuchNote);
				}
				threadId = rows[0].threadId ?? note.id;
			}
		});
	}
}
