/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, Column } from 'typeorm';
import { id } from './util/id.js';
import { MiDriveFile } from './DriveFile.js';

@Entity('drive_file_access_key')
@Index(['fileId'])
export class MiDriveFileAccessKey {
	@PrimaryColumn('varchar', {
		length: 256,
	})
	public accessKey: string;

	@Column(id())
	public fileId: MiDriveFile['id'];

	@Column('smallint')
	public kind: number;
}
