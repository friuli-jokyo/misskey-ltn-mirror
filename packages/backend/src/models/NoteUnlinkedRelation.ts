/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Column } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';

@Entity('note_unlinked_relation')
export class MiNoteUnlinkedRelation {
	@PrimaryColumn(id())
	public noteId: MiNote['id'];

	@Column({
		...id(),
		nullable: true,
	})
	public replyId: MiNote['id'] | null;

	@Column({
		...id(),
		nullable: true,
	})
	public renoteId: MiNote['id'] | null;

	@Column('varchar', {
		length: 512, nullable: true,
	})
	public replyUri: string | null;

	@Column('varchar', {
		length: 512, nullable: true,
	})
	public renoteUri: string | null;
}
