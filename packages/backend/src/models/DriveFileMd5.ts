/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from './util/id.js';
import { MiDriveFile } from './DriveFile.js';
import { MiUser } from './User.js';

@Entity('drive_file_md5')
@Index(['userId', 'md5'])
export class MiDriveFileMd5 {
	@PrimaryColumn(id())
	public fileId: MiDriveFile['id'];

	@Column({
		...id(),
		nullable: true,
	})
	public userId: MiUser['id'] | null;

	@Column('varchar', {
		length: 32,
	})
	public md5: string;
}
