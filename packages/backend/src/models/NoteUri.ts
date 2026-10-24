/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';

@Entity('note_uri')
export class MiNoteUri {
	@PrimaryColumn('varchar', {
		length: 512,
	})
	public uri: string;

	@Index({ unique: true })
	@Column(id())
	public noteId: MiNote['id'];
}
