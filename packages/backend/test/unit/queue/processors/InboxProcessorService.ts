/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { ApDbResolverService } from '@/core/activitypub/ApDbResolverService.js';
import { ApInboxService } from '@/core/activitypub/ApInboxService.js';
import { ApRequestCreator } from '@/core/activitypub/ApRequestService.js';
import { ApResolverService } from '@/core/activitypub/ApResolverService.js';
import { JsonLdService } from '@/core/activitypub/JsonLdService.js';
import { ApPersonService } from '@/core/activitypub/models/ApPersonService.js';
import ApRequestChart from '@/core/chart/charts/ap-request.js';
import FederationChart from '@/core/chart/charts/federation.js';
import InstanceChart from '@/core/chart/charts/instance.js';
import { FederatedInstanceService } from '@/core/FederatedInstanceService.js';
import { FetchInstanceMetadataService } from '@/core/FetchInstanceMetadataService.js';
import { UtilityService } from '@/core/UtilityService.js';
import { DI } from '@/di-symbols.js';
import { genRsaKeyPair } from '@/misc/gen-key-pair.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { InboxProcessorService } from '@/queue/processors/InboxProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import type { InboxJobData } from '@/queue/types.js';
import type * as Bull from 'bullmq';

describe('InboxProcessorService', () => {
	let app: TestingModule;
	let service: InboxProcessorService;
	let job: Bull.Job<InboxJobData>;
	const performActivity = vi.fn();
	const actorUri = 'https://remote.example.com/users/alice';

	beforeAll(async () => {
		const keypair = await genRsaKeyPair();
		const keyId = `${actorUri}#main-key`;
		const signed = await ApRequestCreator.createSignedPost({
			key: { keyId, privateKeyPem: keypair.privateKey },
			url: 'https://local.example.com/inbox',
			body: '{}',
			additionalHeaders: {},
		});

		job = {
			data: {
				activity: {
					'@context': 'https://www.w3.org/ns/activitystreams',
					id: `${actorUri}/statuses/1/activity`,
					type: 'Create',
					actor: actorUri,
					object: `${actorUri}/statuses/1`,
				},
				signature: {
					scheme: 'Signature',
					params: { keyId, algorithm: 'rsa-sha256', headers: ['(request-target)', 'date', 'host', 'digest'], signature: signed.signature },
					signingString: signed.signingString,
					algorithm: 'RSA-SHA256',
					keyId,
				},
			},
			attemptsMade: 0,
			opts: { attempts: 8 },
		} as unknown as Bull.Job<InboxJobData>;

		app = await Test.createTestingModule({
			providers: [
				InboxProcessorService,
				{ provide: DI.meta, useValue: { enableStatsForFederatedInstances: false, enableChartsForFederatedInstances: false } },
				{
					provide: UtilityService,
					useValue: {
						toPuny: (host: string) => host,
						isFederationAllowedHost: () => true,
						extractDbHost: (uri: string) => new URL(uri).host,
					},
				},
				{ provide: ApInboxService, useValue: { performActivity } },
				{ provide: FederatedInstanceService, useValue: { fetch: async () => null } },
				{ provide: FetchInstanceMetadataService, useValue: {} },
				{ provide: JsonLdService, useValue: {} },
				{ provide: ApPersonService, useValue: {} },
				{
					provide: ApDbResolverService,
					useValue: {
						getAuthUserFromKeyId: async () => ({
							user: { id: 'alice', uri: actorUri, host: 'remote.example.com' },
							key: { keyPem: keypair.publicKey },
						}),
					},
				},
				{ provide: ApResolverService, useValue: { createResolver: async () => ({ markLastAttempt: () => {} }) } },
				{ provide: InstanceChart, useValue: {} },
				{ provide: ApRequestChart, useValue: { inbox: () => {} } },
				{ provide: FederationChart, useValue: { inbox: () => {} } },
				{
					provide: QueueLoggerService,
					useValue: { logger: { createSubLogger: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) } },
				},
			],
		}).compile();

		service = app.get(InboxProcessorService);
	});

	afterAll(async () => {
		await app.close();
	});

	test.each([
		{ error: new IdentifiableError('e3e4eb00-3a45-49d7-bf8d-959a02f5d2eb', 'No such user'), result: 'skip: actor deleted' },
		{ error: new IdentifiableError('cc7e1130-6bf7-4105-adeb-25f799da854f', 'No such user.'), result: 'skip: actor deleted' },
		{ error: new IdentifiableError('90b9d6f0-893a-4fef-b0f1-e9a33989f71a', 'Renote target is not public or home'), result: 'skip: renote target is not public or home' },
		{ error: new IdentifiableError('48d7a997-da5c-4716-b3c3-92db3f37bf7d', 'Renote target is not public or home'), result: 'skip: renote target is not public or home' },
	])('completes the job as a skip when the activity fails with $error.id', async ({ error, result }) => {
		performActivity.mockRejectedValueOnce(error);

		await expect(service.process(job)).resolves.toBe(result);
	});

	test('fails the job so that it is retried when the activity fails with another error', async () => {
		performActivity.mockRejectedValueOnce(new Error('connection reset'));

		await expect(service.process(job)).rejects.toThrow('connection reset');
	});
});
