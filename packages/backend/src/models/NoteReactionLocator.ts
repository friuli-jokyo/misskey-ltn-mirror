/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from './util/id.js';
import type { MiUser } from './User.js';
import type { MiNote } from './Note.js';
import type { MiNoteReaction } from './NoteReaction.js';

@Entity('note_reaction_locator')
@Index(['userId', 'id'])
export class MiNoteReactionLocator {
	@PrimaryColumn(id())
	public id: MiNoteReaction['id'];

	@Column(id())
	public noteId: MiNote['id'];

	@Column(id())
	public userId: MiUser['id'];
}
