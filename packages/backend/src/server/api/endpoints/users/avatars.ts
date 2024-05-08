/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { MiUser, type UsersRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';

export const meta = {
	tags: ['users'],

	requireCredential: false,

	description: 'List avatars of users.',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			properties: {
				id: {
					type: 'string',
					nullable: false, optional: false,
					format: 'id',
				},
				name: {
					type: 'string',
					nullable: true, optional: false,
					example: '藍',
				},
				username: {
					type: 'string',
					nullable: false, optional: false,
					example: 'ai',
				},
				host: {
					type: 'string',
					nullable: true, optional: false,
					example: 'misskey.example.com',
					description: 'The local host is represented with `null`.',
				},
				avatarUrl: {
					type: 'string',
					format: 'url',
					nullable: false, optional: false,
				},
				avatarBlurhash: {
					type: 'string',
					nullable: true, optional: false,
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		users: {
			type: 'array',
			uniqueItems: true,
			items: {
				type: 'object',
				properties: {
					id: { type: 'string', format: 'misskey:id' },
					username: { type: 'string' },
					host: {
						type: 'string',
						nullable: true,
						description: 'The local host is represented with `null`.',
					},
				},
				anyOf: [
					{ required: ['id'] },
					{ required: ['username', 'host'] },
				],
			},
		},
	},
	required: ['users'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.usersRepository)
		private usersRepository: UsersRepository,

		private userEntityService: UserEntityService,
	) {
		super(meta, paramDef, async (ps) => {
			const query = this.usersRepository.createQueryBuilder('user');
			const selection = [
				'user.id' as const,
				'user.name' as const,
				'user.username' as const,
				'user.host' as const,
				'user.avatarUrl' as const,
				'user.avatarBlurhash' as const,
			];
			query.select(selection);
			const byId = [];
			const byUsernameLocal = [];
			const byUsernameRemote = new Map<string, string[]>();
			for (const user of ps.users) {
				if (user.id) {
					byId.push(user.id);
				} else if (user.host === null) {
					byUsernameLocal.push(user.username);
				} else {
					const users = byUsernameRemote.get(user.host) ?? [];
					users.push(user.username);
					byUsernameRemote.set(user.host, users);
				}
			}
			const byUsernameRemoteEntities = Array.from(byUsernameRemote);
			let orWhereOrWhere = (): 'orWhere' | 'where' => {
				orWhereOrWhere = () => 'orWhere';
				return 'where';
			};
			if (byId.length) {
				query[orWhereOrWhere()]('user.id IN (:...byId)', { byId });
			}
			if (byUsernameLocal.length) {
				query[orWhereOrWhere()]('user.username IN (:...byUsernameLocal)', { byUsernameLocal });
				query.andWhere('user.host IS NULL');
			}
			for (let i = 0; i < byUsernameRemoteEntities.length; i++) {
				const [host, usernames] = byUsernameRemoteEntities[i];
				query[orWhereOrWhere()](`user.username IN (:...byUsernameRemote${i}Username)`, { [`byUsernameRemote${i}Username`]: usernames });
				query.andWhere(`user.host = :byUsernameRemote${i}Host`, { [`byUsernameRemote${i}Host`]: host });
			}
			const users = await query.getRawMany<{
				[K in typeof selection[number] extends `user.${infer P}` ? P : never as `user_${K}`]: MiUser[K];
			}>();
			return ps.users.flatMap((user) => {
				const entity = users.find(user.id ? (u) => u.user_id === user.id : (u) => u.user_username === user.username && u.user_host === user.host);
				if (!entity) return [];
				const model = {
					id: entity.user_id,
					name: entity.user_name,
					username: entity.user_username,
					host: entity.user_host,
					avatarUrl: entity.user_avatarUrl,
					avatarBlurhash: entity.user_avatarBlurhash,
				};
				model.avatarUrl ??= this.userEntityService.getIdenticonUrl(model as MiUser);
				return [model as {
					[K in keyof typeof model]: K extends 'avatarUrl' ? NonNullable<typeof model[K]> : typeof model[K];
				}];
			});
		});
	}
}
