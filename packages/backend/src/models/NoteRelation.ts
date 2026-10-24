/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column, Check } from 'typeorm';
import { id } from './util/id.js';
import { MiNote } from './Note.js';
import { MiUser } from './User.js';

@Entity('note_relation')
@Index(['parentId', 'childId'])
@Check('"childId" > "parentId"')
export class MiNoteRelation {
	@PrimaryColumn(id())
	public childId: MiNote['id'];

	@PrimaryColumn('smallint')
	public kind: number;

	@Column(id())
	public parentId: MiNote['id'];

	@Column({
		...id(),
		nullable: true,
	})
	public parentReplyUserId: MiUser['id'] | null;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public parentReplyUserHost: string | null;

	@Column({
		...id(),
		nullable: true,
	})
	public parentRenoteUserId: MiUser['id'] | null;

	@Column('varchar', {
		length: 128, nullable: true,
	})
	public parentRenoteUserHost: string | null;
}
