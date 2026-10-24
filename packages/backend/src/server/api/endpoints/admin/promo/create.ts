/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { PromoNotesRepository, MiPromoNote } from '@/models/_.js';
import { GetterService } from '@/server/api/GetterService.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['admin'],

	requireCredential: true,
	requireModerator: true,
	kind: 'write:admin:promo',

	errors: {
		noSuchNote: {
			message: 'No such note.',
			code: 'NO_SUCH_NOTE',
			id: 'ee449fbe-af2a-453b-9cae-cf2fe7c895fc',
		},

		alreadyPromoted: {
			message: 'The note has already promoted.',
			code: 'ALREADY_PROMOTED',
			id: 'ae427aa2-7a41-484f-a18c-2c1104051604',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		noteId: { type: 'string', format: 'misskey:id' },
		expiresAt: { type: 'integer' },
	},
	required: ['noteId', 'expiresAt'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.promoNotesRepository)
		private promoNotesRepository: PromoNotesRepository,

		private getterService: GetterService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const note = await this.getterService.getNote(ps.noteId).catch(e => {
				if (e.id === '9725d0ce-ba28-4dde-95a7-2cbb2c15de24') throw new ApiError(meta.errors.noSuchNote);
				throw e;
			});

			const exist = await this.promoNotesRepository.exists({ where: { noteId: note.id } });

			if (exist) {
				throw new ApiError(meta.errors.alreadyPromoted);
			}

			const inserted: { noteId: MiPromoNote['noteId'] }[] = await this.promoNotesRepository.query(
				'WITH "target" AS (SELECT "id" FROM "note" WHERE "id" = $3 FOR KEY SHARE) INSERT INTO "promo_note" ("noteId", "expiresAt", "userId") SELECT "id", $1, $2 FROM "target" RETURNING "noteId"',
				[new Date(ps.expiresAt), note.userId, note.id],
			);

			if (inserted.length === 0) {
				throw new ApiError(meta.errors.noSuchNote);
			}
		});
	}
}
