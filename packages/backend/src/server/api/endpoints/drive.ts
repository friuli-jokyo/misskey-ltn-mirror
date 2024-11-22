/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Injectable } from '@nestjs/common';
import { Endpoint } from '@/server/api/endpoint-base.js';
import { DriveFileEntityService } from '@/core/entities/DriveFileEntityService.js';
import { RoleService } from '@/core/RoleService.js';

export const meta = {
	tags: ['drive', 'account'],

	requireCredential: true,

	kind: 'read:drive',

	res: {
		type: 'object',
		optional: false, nullable: false,
		properties: {
			capacity: {
				type: 'number',
				optional: false, nullable: false,
			},
			usage: {
				type: 'number',
				optional: false, nullable: false,
			},
			uploadBandwidths: {
				type: 'array',
				optional: false, nullable: false,
				items: {
					type: 'object',
					optional: false, nullable: false,
					properties: {
						duration: {
							type: 'number',
							optional: false, nullable: false,
						},
						capacity: {
							type: 'number',
							optional: false, nullable: false,
						},
						usage: {
							type: 'number',
							optional: false, nullable: false,
						},
					},
				},
			},
		},
	},
} as const;

export const paramDef = {
	type: 'object',
	properties: {},
	required: [],
} as const;

@Injectable()
export default class extends Endpoint<typeof meta, typeof paramDef> { // eslint-disable-line import/no-default-export
	constructor(
		private driveFileEntityService: DriveFileEntityService,
		private roleService: RoleService,
	) {
		super(meta, paramDef, async (ps, me) => {
			// Calculate drive usage
			const [usage, policies] = await Promise.all([
				this.driveFileEntityService.calcDriveUsageOf(me.id),
				this.roleService.getUserPolicies(me.id),
			]);

			return {
				capacity: 1024 * 1024 * policies.driveCapacityMb,
				uploadBandwidths: await Promise.all(policies.driveUploadBandwidthDurationHrCapacityMbPairs.map(async ([duration, capacity]) => ({
					duration: duration * 36e5,
					capacity: capacity * 1024 * 1024,
					usage: await this.driveFileEntityService.calcDriveBandwidthOf(me.id, duration),
				}))),
				usage,
			};
		});
	}
}
