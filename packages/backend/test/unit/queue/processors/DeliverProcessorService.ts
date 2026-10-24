/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { createHash } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Test, TestingModule } from '@nestjs/testing';
import { CoreModule } from '@/core/CoreModule.js';
import { DeleteAccountService } from '@/core/DeleteAccountService.js';
import { GlobalEventService } from '@/core/GlobalEventService.js';
import { IdService } from '@/core/IdService.js';
import { QueueService } from '@/core/QueueService.js';
import { UserSuspendService } from '@/core/UserSuspendService.js';
import { ApRequestService } from '@/core/activitypub/ApRequestService.js';
import { GlobalModule } from '@/GlobalModule.js';
import { DI } from '@/di-symbols.js';
import { secureRndstr } from '@/misc/secure-rndstr.js';
import { DeleteAccountProcessorService } from '@/queue/processors/DeleteAccountProcessorService.js';
import { DeliverProcessorService } from '@/queue/processors/DeliverProcessorService.js';
import { QueueLoggerService } from '@/queue/QueueLoggerService.js';
import type { Config } from '@/config.js';
import type { DeliverJobData } from '@/queue/types.js';
import type { FollowingsRepository, MiMeta, MiUser, UserProfilesRepository, UsersRepository } from '@/models/_.js';

describe('DeliverProcessorService', () => {
	let app: TestingModule;
	let config: Config;
	let service: DeliverProcessorService;
	let deleteAccountProcessorService: DeleteAccountProcessorService;
	let apRequestService: ApRequestService;
	let deleteAccountService: DeleteAccountService;
	let userSuspendService: UserSuspendService;
	let globalEventService: GlobalEventService;
	let queueService: QueueService;
	let idService: IdService;
	let usersRepository: UsersRepository;
	let userProfilesRepository: UserProfilesRepository;
	let followingsRepository: FollowingsRepository;

	const meta = {
		federation: 'all',
		federationHosts: [],
		blockedHosts: [],
		deliverSuspendedSoftware: [],
		enableStatsForFederatedInstances: false,
		enableChartsForFederatedInstances: false,
	} as unknown as MiMeta;

	const remoteHost = `${secureRndstr(8).toLowerCase()}.example.com`;
	const inbox = `https://${remoteHost}/inbox`;

	async function createUser(data: Partial<MiUser> = {}): Promise<MiUser> {
		const id = idService.gen();
		const username = secureRndstr(16);
		await usersRepository.insert({ id, username, usernameLower: username.toLowerCase(), ...data });
		await userProfilesRepository.insert({ userId: id });
		return await usersRepository.findOneByOrFail({ id });
	}

	function jobOf(sender: { id: MiUser['id'] }, data: Partial<DeliverJobData> = {}) {
		return { data: { user: { id: sender.id }, content: '{}', digest: 'SHA-256=', to: inbox, isSharedInbox: true, ...data } } as never;
	}

	beforeAll(async () => {
		app = await Test.createTestingModule({
			imports: [GlobalModule, CoreModule],
			providers: [
				DeliverProcessorService,
				DeleteAccountProcessorService,
				{
					provide: QueueLoggerService,
					useFactory: () => ({
						logger: {
							createSubLogger: () => ({ info: vi.fn(), warn: vi.fn(), succ: vi.fn(), error: vi.fn() }),
						},
					}),
				},
			],
		})
			.overrideProvider(DI.meta).useFactory({ factory: () => meta })
			.compile();
		app.enableShutdownHooks();

		config = app.get(DI.config);
		service = app.get(DeliverProcessorService);
		deleteAccountProcessorService = app.get(DeleteAccountProcessorService);
		apRequestService = app.get(ApRequestService);
		deleteAccountService = app.get(DeleteAccountService);
		userSuspendService = app.get(UserSuspendService);
		globalEventService = app.get(GlobalEventService);
		queueService = app.get(QueueService);
		idService = app.get(IdService);
		usersRepository = app.get(DI.usersRepository);
		userProfilesRepository = app.get(DI.userProfilesRepository);
		followingsRepository = app.get(DI.followingsRepository);
	});

	afterAll(async () => {
		await app.close();
	});

	test('skips an ordinary delivery of a deleted sender', async () => {
		const sender = await createUser({ isDeleted: true });
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);

		expect(await service.process(jobOf(sender))).toBe('skip (sender deleted)');
		expect(signedPost).not.toHaveBeenCalled();
	});

	test('skips an ordinary delivery of a sender that no longer exists', async () => {
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);

		expect(await service.process(jobOf({ id: idService.gen() }))).toBe('skip (sender deleted)');
		expect(signedPost).not.toHaveBeenCalled();
	});

	test('fails an ordinary delivery whose sender could not be looked up, instead of skipping it', async () => {
		const sender = await createUser();
		vi.spyOn(usersRepository, 'findOneByOrFail').mockRejectedValueOnce(new Error('database is down'));
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);

		await expect(service.process(jobOf(sender))).rejects.toThrow('database is down');
		expect(signedPost).not.toHaveBeenCalled();
	});

	test('sends the Delete of a deleted account while its sender exists, marked deleted or not yet', async () => {
		const notYet = await createUser();
		const deleted = await createUser({ isDeleted: true });
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);

		for (const sender of [notYet, deleted]) {
			expect(await service.process(jobOf(sender, { isAccountDeletion: true }))).toBe('Success');
		}

		expect(signedPost.mock.calls).toEqual([notYet, deleted].map(sender => [{ id: sender.id }, inbox, '{}', 'SHA-256=']));
	});

	test('skips the Delete of a deleted account once its sender no longer exists', async () => {
		const purged = await createUser({ isDeleted: true });
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);
		await usersRepository.delete({ id: purged.id });

		expect(await service.process(jobOf(purged, { isAccountDeletion: true }))).toBe('skip (sender deleted)');
		expect(await service.process(jobOf({ id: idService.gen() }, { isAccountDeletion: true }))).toBe('skip (sender deleted)');
		expect(signedPost).not.toHaveBeenCalled();
	});

	test('skips the Delete of a deleted account of a cached sender once the purge deleted the sender', async () => {
		const sender = await createUser({ isDeleted: true });
		vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);
		expect(await service.process(jobOf(sender, { isAccountDeletion: true }))).toBe('Success');

		await deleteAccountProcessorService.processPurge({ data: { user: { id: sender.id } } } as never);
		expect(await usersRepository.existsBy({ id: sender.id })).toBe(false);

		await vi.waitFor(async () => {
			expect(await service.process(jobOf(sender, { isAccountDeletion: true }))).toBe('skip (sender deleted)');
		}, { timeout: 5000, interval: 50 });
	});

	test('sends the deliveries of a sender that is not deleted, suspended or not', async () => {
		const active = await createUser();
		const suspended = await createUser({ isSuspended: true });
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);

		expect(await service.process(jobOf(active))).toBe('Success');
		expect(await service.process(jobOf(suspended))).toBe('Success');

		expect(signedPost.mock.calls).toEqual([active, suspended].map(sender => [{ id: sender.id }, inbox, '{}', 'SHA-256=']));
	});

	test('marks only the Delete queued by the deletion job of a local account, which still passes after the deletion', async () => {
		const target = await createUser();
		const suspended = await createUser({ isSuspended: true });
		const follower = await createUser({ host: remoteHost, inbox: `https://${remoteHost}/users/${secureRndstr(8)}/inbox`, sharedInbox: inbox });
		await followingsRepository.insert({ id: idService.gen(), followerId: follower.id, followeeId: target.id, followerHost: follower.host, followerInbox: follower.inbox, followerSharedInbox: follower.sharedInbox, followeeHost: null });
		const add = vi.spyOn(queueService.deliverQueue, 'add').mockResolvedValue(undefined as never);
		vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
		const signedPost = vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);

		await deleteAccountService.deleteAccount(target);
		expect(add).not.toHaveBeenCalled();
		expect(await usersRepository.findOneByOrFail({ id: target.id })).toMatchObject({ isDeleted: true });

		await deleteAccountProcessorService.process({ data: { user: { id: target.id }, soft: false } } as never);
		await userSuspendService.doPostSuspend(suspended);

		const [deletion, suspension] = add.mock.calls.map(([, data]) => data as DeliverJobData);
		expect(add).toHaveBeenCalledTimes(2);
		expect(add.mock.calls[0][2]).toMatchObject({ jobId: `deleteAccount-${target.id}-${createHash('sha256').update(inbox).digest('hex')}` });
		expect(add.mock.calls[1][2]?.jobId).toBeUndefined();
		expect(deletion).toMatchObject({ user: { id: target.id }, to: inbox, isSharedInbox: true, isAccountDeletion: true });
		expect(suspension).toMatchObject({ user: { id: suspended.id }, to: inbox, isSharedInbox: true });
		expect(suspension.isAccountDeletion).toBeUndefined();

		expect(await service.process({ data: deletion } as never)).toBe('Success');
		expect(await service.process({ data: suspension } as never)).toBe('Success');
		expect(await service.process(jobOf(target))).toBe('skip (sender deleted)');
		expect(signedPost.mock.calls.map(([user]) => user.id)).toEqual([target.id, suspended.id]);
	});

	test('skips an ordinary delivery of a sender cached before its deletion was published', async () => {
		const sender = await createUser();
		vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);
		expect(await service.process(jobOf(sender))).toBe('Success');

		await usersRepository.update(sender.id, { isDeleted: true });
		globalEventService.publishInternalEvent('userChangeDeletedState', { id: sender.id, isDeleted: true });

		await vi.waitFor(async () => {
			expect(await service.process(jobOf(sender))).toBe('skip (sender deleted)');
		}, { timeout: 5000, interval: 50 });
	});

	test('skips an ordinary delivery of a sender whose deletion was not published, once the deletion job runs', async () => {
		const sender = await createUser();
		vi.spyOn(apRequestService, 'signedPost').mockResolvedValue(undefined);
		vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
		expect(await service.process(jobOf(sender))).toBe('Success');

		await usersRepository.update(sender.id, { isDeleted: true });
		expect(await service.process(jobOf(sender))).toBe('Success');
		vi.spyOn(queueService.deliverQueue, 'add').mockResolvedValue(undefined as never);

		await deleteAccountProcessorService.process({ data: { user: { id: sender.id }, soft: false } } as never);

		await vi.waitFor(async () => {
			expect(await service.process(jobOf(sender))).toBe('skip (sender deleted)');
		}, { timeout: 5000, interval: 50 });
	});

	test('the deletion job of a local account queues one marked Delete per distinct shared inbox, under ids that a retry does not duplicate', async () => {
		const target = await createUser();
		const hosts = [0, 1, 2].map(() => `${secureRndstr(8).toLowerCase()}.example.com`);
		const sharedInboxes = hosts.map(host => `https://${host}/inbox`);
		const remoteUserOf = async (host: string, sharedInbox: string | null) => await createUser({ host, inbox: `https://${host}/users/${secureRndstr(8)}/inbox`, sharedInbox });
		const followers = [await remoteUserOf(hosts[0], sharedInboxes[0]), await remoteUserOf(hosts[0], sharedInboxes[0]), await remoteUserOf(hosts[2], null)];
		const followee = await remoteUserOf(hosts[1], sharedInboxes[1]);
		for (const follower of followers) {
			await followingsRepository.insert({ id: idService.gen(), followerId: follower.id, followeeId: target.id, followerHost: follower.host, followerInbox: follower.inbox, followerSharedInbox: follower.sharedInbox, followeeHost: null });
		}
		await followingsRepository.insert({ id: idService.gen(), followerId: target.id, followeeId: followee.id, followerHost: null, followeeHost: followee.host, followeeInbox: followee.inbox, followeeSharedInbox: followee.sharedInbox });
		vi.spyOn(queueService.dbQueue, 'add').mockResolvedValue(undefined as never);
		const deletionJob = { data: { user: { id: target.id }, soft: false } } as never;

		const jobsOf = async () => (await queueService.deliverQueue.getJobs(['waiting', 'delayed', 'prioritized', 'active', 'completed', 'failed']))
			.filter(job => job.data.user.id === target.id)
			.sort((a, b) => a.data.to.localeCompare(b.data.to));

		try {
			await deleteAccountProcessorService.process(deletionJob);
			const first = await jobsOf();
			await deleteAccountProcessorService.process(deletionJob);
			const second = await jobsOf();

			const known = [...new Set((await followingsRepository.find()).map(x => x.followerSharedInbox ?? x.followeeSharedInbox).filter(x => x != null))].sort((a, b) => a.localeCompare(b));
			expect(known).toEqual(expect.arrayContaining([sharedInboxes[0], sharedInboxes[1]]));
			expect(known).not.toContain(sharedInboxes[2]);

			expect(first.map(job => ({ id: job.id, data: { user: job.data.user, to: job.data.to, isSharedInbox: job.data.isSharedInbox, isAccountDeletion: job.data.isAccountDeletion } }))).toEqual(known.map(to => ({
				id: `deleteAccount-${target.id}-${createHash('sha256').update(to).digest('hex')}`,
				data: { user: { id: target.id }, to, isSharedInbox: true, isAccountDeletion: true },
			})));
			for (const job of first) {
				expect(await job.isWaiting()).toBe(true);
				expect(JSON.parse(job.data.content)).toMatchObject({ type: 'Delete', actor: `${config.url}/users/${target.id}`, object: `${config.url}/users/${target.id}` });
			}
			expect(second.map(job => [job.id, job.timestamp, job.data.content])).toEqual(first.map(job => [job.id, job.timestamp, job.data.content]));
		} finally {
			for (const job of await jobsOf()) {
				await job.remove();
			}
		}
	});
});
