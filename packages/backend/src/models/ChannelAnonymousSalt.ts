/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { PrimaryColumn, Entity, Index, JoinColumn, Column, ManyToOne } from 'typeorm';
import { id } from './util/id.js';
import { MiChannel } from './Channel.js';

@Entity('channel_anonymous_salt')
@Index(['channelId', 'since', 'until'], { unique: true })
export class MiChannelAnonymousSalt {
	@PrimaryColumn(id())
	public id: string;

	@Index()
	@Column({
		...id(),
	})
	public channelId: MiChannel['id'];

	@ManyToOne(type => MiChannel, {
		onDelete: 'CASCADE',
	})
	@JoinColumn()
	public channel: MiChannel | null;

	@Index()
	@Column('varchar', {
		...id(),
	})
	public since: string;

	@Index()
	@Column('varchar', {
		...id(),
		nullable: true,
	})
	public until: string | null;

	@Column('bigint')
	public salt: string;
}
