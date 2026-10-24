/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Column } from 'typeorm';
import { id } from './util/id.js';
import { MiUser } from './User.js';

@Entity('user_drive_usage')
export class MiUserDriveUsage {
	@PrimaryColumn(id())
	public userId: MiUser['id'];

	@Column('bigint', {
		default: 0,
		transformer: {
			to: (value: number): number => value,
			from: (value: string): number => parseInt(value, 10),
		},
	})
	public usage: number;
}
