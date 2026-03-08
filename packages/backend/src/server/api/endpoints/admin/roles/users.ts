/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import type { RolesRepository } from '@/models/_.js';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DI } from '@/di-symbols.js';
import { UserEntityService } from '@/core/entities/UserEntityService.js';
import { IdService } from '@/core/IdService.js';
import { RoleService } from '@/core/RoleService.js';
import { ApiError } from '../../../error.js';

export const meta = {
	tags: ['admin', 'role', 'users'],

	requireCredential: false,
	requireModerator: true,
	kind: 'read:admin:roles',

	errors: {
		noSuchRole: {
			message: 'No such role.',
			code: 'NO_SUCH_ROLE',
			id: '224eff5e-2488-4b18-b3e7-f50d94421648',
		},
	},

	res: {
		type: 'array',
		items: {
			type: 'object',
			properties: {
				id: { type: 'string', format: 'misskey:id' },
				createdAt: { type: 'string', format: 'date-time' },
				user: { ref: 'UserDetailed' },
				expiresAt: { type: 'string', format: 'date-time', nullable: true },
			},
			required: ['id', 'createdAt', 'user'],
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roleId: { type: 'string', format: 'misskey:id' },
		sinceId: { type: 'string', format: 'misskey:id' },
		untilId: { type: 'string', format: 'misskey:id' },
		sinceDate: { type: 'integer' },
		untilDate: { type: 'integer' },
		limit: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
	},
	required: ['roleId'],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.rolesRepository)
		private rolesRepository: RolesRepository,

		private roleService: RoleService,
		private userEntityService: UserEntityService,
		private idService: IdService,
	) {
		super(meta, paramDef, async (ps, me) => {
			const assigns = await this.roleService.getRoleAssigns(ps.roleId, ps.sinceId, ps.untilId, ps.limit);

			if (assigns == null) {
				throw new ApiError(meta.errors.noSuchRole);
			}

			const _users = assigns.map(({ user, userId }) => user ?? userId);
			const _userMap = await this.userEntityService.packMany(_users, me, { schema: 'UserDetailed' })
				.then(users => new Map(users.map(u => [u.id, u])));
			return await Promise.all(assigns.map(async assign => ({
				id: assign.id,
				createdAt: this.idService.parse(assign.id).date.toISOString(),
				user: _userMap.get(assign.userId) ?? await this.userEntityService.pack(assign.user!, me, { schema: 'UserDetailed' }),
				expiresAt: assign.expiresAt?.toISOString() ?? null,
			})));
		});
	}
}
