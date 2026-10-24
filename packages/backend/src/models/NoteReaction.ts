/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';
import { MiNote } from './Note.js';

@Entity('note_reaction')
@Index(['userId', 'noteId'], { unique: true })
@Index('IDX_NOTE_REACTION_NOTE_ID_ID', { synchronize: false })
@Index('IDX_NOTE_REACTION_ID', { synchronize: false })
@Index('IDX_NOTE_REACTION_USER_ID_ID', { synchronize: false })
export class MiNoteReaction {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column(id())
	public userId: MiUser['id'];

	@ManyToOne(() => MiUser, {
		createForeignKeyConstraints: false,
	})
	@JoinColumn()
	public user?: MiUser | null;

	@Index()
	@Column(id())
	public noteId: MiNote['id'];

	@ManyToOne(() => MiNote, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public note?: MiNote | null;

	// TODO: 対象noteのuserIdを非正規化したい(「受け取ったリアクション一覧」のようなものを(JOIN無しで)実装したいため)

	@Column('varchar', {
		length: 260,
	})
	public reaction: string;
}
