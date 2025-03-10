/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { RolesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { ApiError } from '@/server/api/error.js';
import { RoleEntityService } from '@/core/entities/RoleEntityService.js';
import { RoleService } from '@/core/RoleService.js';

export const meta = {
	tags: ['admin', 'role'],

	requireCredential: true,
	kind: 'read:admin:roles',

	errors: {
		noSuchRole: {
			message: 'No such role.',
			code: 'NO_SUCH_ROLE',
			id: '07dc7d34-c0d8-49b7-96c6-db3ce64ee0b3',
		},
	},

	res: {
		type: 'object',
		optional: false, nullable: false,
		ref: 'Role',
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
		roleId: { type: 'string', format: 'misskey:id' },
	},
	required: [
		'roleId',
	],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		@Inject(DI.rolesRepository)
		private rolesRepository: RolesRepository,

		private roleEntityService: RoleEntityService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			if (await this.roleService.isModerator(me)) {
				const role = await this.rolesRepository.findOneBy({ id: ps.roleId });
				if (role == null) {
					throw new ApiError(meta.errors.noSuchRole);
				}
				return await this.roleEntityService.pack(role, me);
			} else {
				const policies = await this.roleService.getUserPolicies(me.id);
				const role = await this.rolesRepository.createQueryBuilder('r')
					.where('r.id = :id')
					.andWhere('r.tags && :tags', { id: ps.roleId, tags: policies.selfAssignability.map(([roleTag]) => roleTag) })
					.getOne();
				if (role == null) {
					throw new ApiError(meta.errors.noSuchRole);
				}
				return await this.roleEntityService.pack(role, me);
			}
		});
	}
}
