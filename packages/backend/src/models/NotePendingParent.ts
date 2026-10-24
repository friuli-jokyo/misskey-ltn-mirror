/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiNote } from './Note.js';

@Entity('note_pending_parent')
export class MiNotePendingParent {
	@PrimaryColumn('varchar', {
		length: 512,
	})
	public parentUri: string;

	@Index()
	@PrimaryColumn(id())
	public childId: MiNote['id'];

	@ManyToOne(() => MiNote, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public child?: MiNote | null;

	@PrimaryColumn('smallint')
	public kind: number;
}
