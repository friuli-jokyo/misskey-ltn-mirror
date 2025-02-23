/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import type { RolesRepository } from '@/models/_.js';
import { DI } from '@/di-symbols.js';
import { RoleEntityService } from '@/core/entities/RoleEntityService.js';
import { RoleService } from '@/core/RoleService.js';

export const meta = {
	tags: ['admin', 'role'],

	requireCredential: true,
	kind: 'read:admin:roles',

	res: {
		type: 'array',
		optional: false, nullable: false,
		items: {
			type: 'object',
			optional: false, nullable: false,
			ref: 'Role',
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {
	},
	required: [
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
				const roles = await this.rolesRepository.find({
					order: { lastUsedAt: 'DESC' },
				});
				return await this.roleEntityService.packMany(roles, me);
			} else {
				const policies = await this.roleService.getUserPolicies(me.id);
				const roles = await this.rolesRepository.createQueryBuilder('r')
					.where('r.tags && :tags', { tags: policies.selfAssignability.map(([roleTag]) => roleTag) })
					.orderBy('r.lastUsedAt', 'DESC')
					.getMany();
				return await this.roleEntityService.packMany(roles, me);
			}
		});
	}
}
