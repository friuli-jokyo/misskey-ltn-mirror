/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity } from 'typeorm';
import { id } from './util/id.js';
import type { MiNote } from './Note.js';

@Entity('deleted_note')
export class MiDeletedNote {
	@PrimaryColumn(id())
	public id: MiNote['id'];
}
