/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { forwardRef, Inject, Injectable } from '@nestjs/common';
import { In } from 'typeorm';
import * as Redis from 'ioredis';
import { DI } from '@/di-symbols.js';
import type { PollsRepository, EmojisRepository, MiMeta } from '@/models/_.js';
import type { Config } from '@/config.js';
import type { MiRemoteUser } from '@/models/User.js';
import type { MiNote } from '@/models/Note.js';
import { acquireApObjectLock } from '@/misc/distributed-lock.js';
import { toArray, toSingle, unique } from '@/misc/prelude/array.js';
import type { MiEmoji } from '@/models/Emoji.js';
import type { MiDriveFile } from '@/models/DriveFile.js';
import { NoteCreateService } from '@/core/NoteCreateService.js';
import type Logger from '@/logger.js';
import { IdService } from '@/core/IdService.js';
import { PollService } from '@/core/PollService.js';
import { StatusError } from '@/misc/status-error.js';
import { UtilityService } from '@/core/UtilityService.js';
import { bindThis } from '@/decorators.js';
import { checkHttps } from '@/misc/check-https.js';
import { IdentifiableError } from '@/misc/identifiable-error.js';
import { normalizeSynonymousUri, synonymousUris } from '../misc/check-against-url.js';
import { getOneApId, getApId, getOneApHrefNullable, validPost, isEmoji, getApType, isTombstone } from '../type.js';
import { ApLoggerService } from '../ApLoggerService.js';
import { ApMfmService } from '../ApMfmService.js';
import { ApDbResolverService } from '../ApDbResolverService.js';
import { ApResolverService } from '../ApResolverService.js';
import { ApAudienceService } from '../ApAudienceService.js';
import { ApPersonService } from './ApPersonService.js';
import { extractApHashtags } from './tag.js';
import { ApMentionService } from './ApMentionService.js';
import { ApQuestionService } from './ApQuestionService.js';
import { ApImageService } from './ApImageService.js';
import type { Resolver } from '../ApResolverService.js';
import type { IObject, IPost } from '../type.js';

const rejectedNoteErrorIds = [
	'd450b8a9-48e4-4dab-ae36-f4db763fda7c',
	'85ab9bd7-3a41-4530-959d-f07073900109',
	'689ee33f-f97c-479a-ac49-1b9f8140af99',
	'9f466dab-c856-48cd-9e65-ff90ff750580',
	'90b9d6f0-893a-4fef-b0f1-e9a33989f71a',
	'48d7a997-da5c-4716-b3c3-92db3f37bf7d',
];

const blockedInstanceErrorId = '09d79f9e-64f1-4316-9cfa-e75c4d091574';

export const unfetchableObjectErrorIds = [
	'b94fd5b1-0e3b-4678-9df2-dad4cd515ab2',
	'72180409-793c-4973-868e-5a118eb5519b',
];

const invalidActorErrorId = '97acabe7-7638-4f83-ab14-ffefa0ad793a';

const deletedAuthorErrorId = 'e3e4eb00-3a45-49d7-bf8d-959a02f5d2eb';

export type NoteParentReference =
	| { type: 'note'; note: MiNote }
	| { type: 'former'; formerId: MiNote['id'] }
	| { type: 'waiting'; uri: string }
	| { type: 'gone' | 'rejected'; reason: string };

@Injectable()
export class ApNoteService {
	private logger: Logger;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.meta)
		private meta: MiMeta,

		@Inject(DI.redis)
		private redisClient: Redis.Redis,

		@Inject(DI.pollsRepository)
		private pollsRepository: PollsRepository,

		@Inject(DI.emojisRepository)
		private emojisRepository: EmojisRepository,

		private idService: IdService,
		private apMfmService: ApMfmService,
		private apResolverService: ApResolverService,

		// 循環参照のため / for circular dependency
		@Inject(forwardRef(() => ApPersonService))
		private apPersonService: ApPersonService,

		private utilityService: UtilityService,
		private apAudienceService: ApAudienceService,
		private apMentionService: ApMentionService,
		private apImageService: ApImageService,
		private apQuestionService: ApQuestionService,
		private pollService: PollService,
		private noteCreateService: NoteCreateService,
		private apDbResolverService: ApDbResolverService,
		private apLoggerService: ApLoggerService,
	) {
		this.logger = this.apLoggerService.logger;
	}

	@bindThis
	public validateNote(object: IObject, uri: string, actor?: MiRemoteUser): Error | null {
		const expectHost = this.utilityService.extractDbHost(uri);
		const apType = getApType(object);

		if (apType == null || !validPost.includes(apType)) {
			return new IdentifiableError('d450b8a9-48e4-4dab-ae36-f4db763fda7c', `invalid Note: invalid object type ${apType ?? 'undefined'}`);
		}

		if (object.id && this.utilityService.extractDbHost(object.id) !== expectHost) {
			return new IdentifiableError('d450b8a9-48e4-4dab-ae36-f4db763fda7c', `invalid Note: id has different host. expected: ${expectHost}, actual: ${this.utilityService.extractDbHost(object.id)}`);
		}

		const actualHost = object.attributedTo && this.utilityService.extractDbHost(getOneApId(object.attributedTo));
		if (object.attributedTo && actualHost !== expectHost) {
			return new IdentifiableError('d450b8a9-48e4-4dab-ae36-f4db763fda7c', `invalid Note: attributedTo has different host. expected: ${expectHost}, actual: ${actualHost}`);
		}

		if (object.published && !this.idService.isSafeT(new Date(object.published).valueOf())) {
			return new IdentifiableError('d450b8a9-48e4-4dab-ae36-f4db763fda7c', 'invalid Note: published timestamp is malformed');
		}

		if (actor) {
			const attribution = (object.attributedTo) ? getOneApId(object.attributedTo) : actor.uri;

			if (attribution !== actor.uri) {
				return new IdentifiableError('d450b8a9-48e4-4dab-ae36-f4db763fda7c', `invalid Note: attribution does not match the actor that send it. attribution: ${attribution}, actor: ${actor.uri}`);
			}
		}

		return null;
	}

	/**
	 * Noteをフェッチします。
	 *
	 * Misskeyに対象のNoteが登録されていればそれを返します。
	 */
	@bindThis
	public async fetchNote(object: string | IObject): Promise<MiNote | null> {
		return await this.apDbResolverService.getNoteFromApId(object);
	}

	/**
	 * Noteを作成します。
	 */
	@bindThis
	public async createNote(value: string | IObject, actor?: MiRemoteUser, resolver?: Resolver, silent = false, fetched = false): Promise<MiNote | null> {
		// eslint-disable-next-line no-param-reassign
		if (resolver == null) resolver = await this.apResolverService.createResolver();

		const object = await resolver.resolve(value);

		const entryUri = getApId(value);
		const err = this.validateNote(object, entryUri, actor);
		if (err) {
			this.logger.error(err.message, {
				resolver: { history: resolver.getHistory() },
				value,
				object,
			});
			throw err;
		}

		const note = object as IPost;

		this.logger.debug(`Note fetched: ${JSON.stringify(note, null, 2)}`);

		if (note.id == null) {
			throw new Error('Refusing to create note without id');
		}

		if (!checkHttps(note.id)) {
			throw new Error('unexpected schema of note.id: ' + note.id);
		}

		const url = getOneApHrefNullable(note.url);

		if (url && !checkHttps(url)) {
			throw new Error('unexpected schema of note url: ' + url);
		}

		this.logger.info(`Creating the Note: ${note.id}`);

		// 投稿者をフェッチ
		if (note.attributedTo == null) {
			throw new Error('invalid note.attributedTo: ' + note.attributedTo);
		}

		const uri = getOneApId(note.attributedTo);

		// ローカルで投稿者を検索し、もし凍結されていたらスキップ
		// eslint-disable-next-line no-param-reassign
		actor ??= await this.apPersonService.fetchPerson(uri) as MiRemoteUser | undefined;
		if (actor && actor.isSuspended) {
			throw new IdentifiableError('85ab9bd7-3a41-4530-959d-f07073900109', 'actor has been suspended');
		}

		const apMentionRawCount = new Set(this.apMentionService.extractApMentionObjects(note.tag).map(x => x.href)).size;
		const apMentions = await this.apMentionService.extractApMentions(note.tag, resolver);
		const apHashtags = extractApHashtags(note.tag);

		const cw = note.summary === '' ? null : note.summary;

		// テキストのパース
		let text: string | null = null;
		if (note.source?.mediaType === 'text/x.misskeymarkdown' && typeof note.source.content === 'string') {
			text = note.source.content;
		} else if (typeof note._misskey_content !== 'undefined') {
			text = note._misskey_content;
		} else if (typeof note.content === 'string') {
			text = this.apMfmService.htmlToMfm(note.content, note.tag);
		}

		const poll = await this.apQuestionService.extractPollFromQuestion(note, resolver).catch(() => undefined);

		//#region Contents Check
		// 添付ファイルとユーザーをこのサーバーで登録する前に内容をチェックする
		/**
		 * 禁止ワードチェック
		 */
		const hasProhibitedWords = this.noteCreateService.checkProhibitedWordsContain({ cw, text, pollChoices: poll?.choices });
		if (hasProhibitedWords) {
			throw new IdentifiableError('689ee33f-f97c-479a-ac49-1b9f8140af99', 'Note contains prohibited words');
		}
		//#endregion

		// eslint-disable-next-line no-param-reassign
		actor ??= await this.apPersonService.resolvePerson(uri, resolver) as MiRemoteUser;

		// 解決した投稿者が凍結されていたらスキップ
		if (actor.isSuspended) {
			throw new IdentifiableError('85ab9bd7-3a41-4530-959d-f07073900109', 'actor has been suspended');
		}

		const noteAudience = await this.apAudienceService.parseAudience(actor, note.to, note.cc, resolver);
		let visibility = noteAudience.visibility;
		const visibleUsers = noteAudience.visibleUsers;

		// Audience (to, cc) が指定されてなかった場合
		if (visibility === 'specified' && visibleUsers.length === 0) {
			if (typeof value === 'string' || fetched) {	// 入力がstringならばresolverでGETが発生している
				// こちらから匿名GET出来たものならばpublic
				visibility = 'public';
			}
		}

		// 添付ファイル
		const files: MiDriveFile[] = [];

		for (const attach of toArray(note.attachment)) {
			attach.sensitive ??= note.sensitive;
			const file = await this.apImageService.resolveImage(actor, attach);
			if (file) files.push(file);
		}

		// リプライ
		const replyReference = note.inReplyTo ? await this.resolveParent(note.inReplyTo, resolver, note.id) : null;
		const reply = replyReference?.type === 'note' ? replyReference.note : null;

		// 引用
		const quoteReference = (note._misskey_quote ?? note.quoteUrl)
			? await this.resolveQuote(unique([note._misskey_quote, note.quoteUrl].filter(x => x != null)), note.inReplyTo, replyReference, resolver, note.id)
			: null;

		// vote
		if (reply && reply.hasPoll) {
			const poll = await this.pollsRepository.findOneByOrFail({ noteId: reply.id });

			const tryCreateVote = async (name: string, index: number): Promise<null> => {
				if (poll.expiresAt && Date.now() > new Date(poll.expiresAt).getTime()) {
					this.logger.warn(`vote to expired poll from AP: actor=${actor.username}@${actor.host}, note=${note.id}, choice=${name}`);
				} else if (index >= 0) {
					this.logger.info(`vote from AP: actor=${actor.username}@${actor.host}, note=${note.id}, choice=${name}`);
					await this.pollService.vote(actor, reply, index);

					// リモートフォロワーにUpdate配信
					this.pollService.deliverQuestionUpdate(reply.id);
				}
				return null;
			};

			if (note.name) {
				return await tryCreateVote(note.name, poll.choices.findIndex(x => x === note.name));
			}
		}

		const emojis = await this.extractEmojis(note.tag ?? [], actor.host).catch(e => {
			this.logger.info(`extractEmojis: ${e}`);
			return [];
		});

		const apEmojis = emojis.map(emoji => emoji.name);

		const createdAt = note.published ? new Date(note.published) : null;

		try {
			return await this.noteCreateService.create(actor, {
				createdAt,
				files,
				reply,
				renote: quoteReference?.type === 'note' ? quoteReference.note : null,
				name: note.name,
				cw,
				text,
				localOnly: false,
				visibility,
				visibleUsers,
				apMentions,
				apMentionRawCount,
				apHashtags,
				apEmojis,
				poll,
				uri: note.id,
				url: url,
				replyFormerId: replyReference?.type === 'former' ? replyReference.formerId : null,
				renoteFormerId: quoteReference?.type === 'former' ? quoteReference.formerId : null,
				unresolvedReplyUri: replyReference?.type === 'waiting' ? replyReference.uri : null,
				unresolvedRenoteUri: quoteReference?.type === 'waiting' ? quoteReference.uri : null,
				unlinkableReply: replyReference?.type === 'gone' || replyReference?.type === 'rejected',
				unlinkableRenote: quoteReference?.type === 'gone' || quoteReference?.type === 'rejected',
			}, silent);
		} catch (err: any) {
			if (err.name !== 'duplicated') {
				throw err;
			}
			this.logger.info('The note is already inserted while creating itself, reading again');
			const duplicate = await this.fetchNote(value);
			if (!duplicate) {
				throw new Error('The note creation failed with duplication error even when there is no duplication');
			}
			return duplicate;
		}
	}

	@bindThis
	public async resolveParent(value: string | IObject, resolver: Resolver, childUri: string, sentFrom?: URL): Promise<NoteParentReference> {
		const uri = typeof value === 'string' ? value : value.id;
		const normalizedUri = typeof uri === 'string' ? normalizeSynonymousUri(uri) : null;
		if (typeof uri !== 'string' || normalizedUri == null) return this.unlinkedParent(String(uri), { type: 'rejected', reason: 'invalid uri' });
		if (normalizedUri === normalizeSynonymousUri(childUri)) return this.unlinkedParent(uri, { type: 'rejected', reason: 'self reference' });
		if (!this.isFederationAllowedParentUri(uri)) return this.unlinkedParent(uri, { type: 'rejected', reason: 'blocked instance' });
		if (this.noteCreateService.pendingUriOf(uri) == null) return await this.findParent(uri) ?? this.unlinkedParent(uri, { type: 'rejected', reason: 'unfetchable uri' });

		let unlock: () => Promise<void>;
		try {
			unlock = await acquireApObjectLock(this.redisClient, uri);
		} catch (err) {
			return this.unlinkedParent(uri, this.decideParentFailure(err, uri, resolver));
		}

		try {
			const known = await this.findParent(uri);
			if (known != null) return known;

			const embedded = typeof value !== 'string' && sentFrom?.origin === new URL(uri).origin && (toArray(value.to).length > 0 || toArray(value.cc).length > 0);
			let object: IObject;
			if (embedded) {
				object = value;
			} else {
				try {
					object = await resolver.resolve(uri);
				} catch (err) {
					if (err instanceof IdentifiableError && unfetchableObjectErrorIds.includes(err.id)) return this.unlinkedParent(uri, { type: 'rejected', reason: err.message });
					return this.unlinkedParent(uri, this.decideParentFailure(err, uri, resolver));
				}
			}

			if (isTombstone(object)) return this.unlinkedParent(uri, { type: 'gone', reason: 'Tombstone' });

			const objectUri = object.id != null && object.id !== uri && normalizeSynonymousUri(object.id) === normalizedUri ? object.id : uri;
			if (objectUri !== uri) {
				if (!this.isFederationAllowedParentUri(objectUri)) return this.unlinkedParent(uri, { type: 'rejected', reason: 'blocked instance' });
				const canonical = await this.findParent(objectUri);
				if (canonical != null) return canonical;
			}

			try {
				const invalid = this.validateNote(object, objectUri);
				if (invalid != null) return this.unlinkedParent(uri, { type: 'rejected', reason: invalid.message });

				const note = await this.createNote(object, undefined, resolver, true, !embedded);
				if (note == null) return this.unlinkedParent(uri, { type: 'rejected', reason: 'not a note' });
				return { type: 'note', note };
			} catch (err) {
				if (err instanceof IdentifiableError && [...unfetchableObjectErrorIds, invalidActorErrorId].includes(err.id)) return this.unlinkedParent(uri, { type: 'waiting', uri });
				return this.unlinkedParent(uri, this.decideParentFailure(err, uri, resolver));
			}
		} finally {
			unlock();
		}
	}

	@bindThis
	private isFederationAllowedParentUri(uri: string): boolean {
		return this.utilityService.isSynonymousUriLocal(uri) || this.utilityService.isFederationAllowedUri(uri);
	}

	@bindThis
	private async findParent(uri: string): Promise<NoteParentReference | null> {
		let formerId: MiNote['id'] | null = null;
		for (const candidate of unique([uri, ...synonymousUris(uri)])) {
			const reference = await this.apDbResolverService.getNoteReferenceFromApId(candidate);
			if (reference.note == null && reference.formerId == null) continue;
			if (!this.isFederationAllowedParentUri(candidate)) return this.unlinkedParent(uri, { type: 'rejected', reason: 'blocked instance' });
			if (reference.note != null) return { type: 'note', note: reference.note };
			formerId ??= reference.formerId;
		}
		if (formerId != null) return { type: 'former', formerId };
		if (this.noteCreateService.pendingUriOf(uri) == null) return this.unlinkedParent(uri, { type: 'rejected', reason: 'unfetchable uri' });
		return null;
	}

	@bindThis
	private decideParentFailure(err: unknown, uri: string, resolver: Resolver): NoteParentReference {
		if (err instanceof StatusError && !err.isRetryable) {
			return err.statusCode === 410 ? { type: 'gone', reason: err.message } : { type: 'waiting', uri };
		}
		if (err instanceof IdentifiableError) {
			if (rejectedNoteErrorIds.includes(err.id)) return { type: 'rejected', reason: err.message };
			if (err.id === blockedInstanceErrorId) return { type: 'rejected', reason: 'blocked instance' };
			if (err.id === deletedAuthorErrorId) return { type: 'gone', reason: err.message };
		}
		if (resolver.isLastAttempt()) return { type: 'waiting', uri };
		this.logger.warn(`Error in parent ${uri} - ${err instanceof StatusError ? err.statusCode : err}`);
		throw err;
	}

	@bindThis
	private unlinkedParent(uri: string, reference: NoteParentReference): NoteParentReference {
		this.logger.warn(`parent ${uri} cannot be linked: ${'reason' in reference ? `${reference.type} - ${reference.reason}` : reference.type}`);
		return reference;
	}

	@bindThis
	private async resolveQuote(values: (string | IObject)[], replyValue: unknown, replyReference: NoteParentReference | null, resolver: Resolver, childUri: string): Promise<NoteParentReference> {
		const replyUri = typeof replyValue === 'string' ? replyValue : (replyValue as IObject | null | undefined)?.id;
		const results = await Promise.allSettled(values.map(value => {
			const uri = typeof value === 'string' ? value : value.id;
			return replyReference != null && uri != null && uri === replyUri ? replyReference : this.resolveParent(value, resolver, childUri);
		}));
		const references = results.filter(result => result.status === 'fulfilled').map(result => result.value);
		for (const types of [['note'], ['former'], ['gone', 'rejected']]) {
			const reference = references.find(x => types.includes(x.type));
			if (reference != null) return reference;
		}
		const failure = results.find(result => result.status === 'rejected');
		if (failure != null) throw failure.reason;
		return references[0];
	}

	/**
	 * Noteを解決します。
	 *
	 * Misskeyに対象のNoteが登録されていればそれを返し、そうでなければ
	 * リモートサーバーからフェッチしてMisskeyに登録しそれを返します。
	 */
	@bindThis
	public async resolveNote(value: string | IObject, options: { sentFrom?: URL, resolver?: Resolver } = {}): Promise<MiNote | null> {
		const uri = getApId(value);

		if (!this.utilityService.isFederationAllowedUri(uri)) {
			throw new StatusError('blocked host', 451);
		}

		const unlock = await acquireApObjectLock(this.redisClient, uri);

		try {
			//#region このサーバーに既に登録されていたらそれを返す
			const reference = await this.apDbResolverService.getNoteReferenceFromApId(uri);
			if (reference.note != null || reference.formerId != null) return reference.note;
			//#endregion

			if (this.utilityService.isUriLocal(uri)) {
				throw new StatusError('cannot resolve local note', 400, 'cannot resolve local note');
			}

			// リモートサーバーからフェッチしてきて登録
			// ここでuriの代わりに添付されてきたNote Objectが指定されていると、サーバーフェッチを経ずにノートが生成されるが
			// 添付されてきたNote Objectは偽装されている可能性があるため、常にuriを指定してサーバーフェッチを行う。
			const createFrom = options.sentFrom?.origin === new URL(uri).origin ? value : uri;
			return await this.createNote(createFrom, undefined, options.resolver, true);
		} finally {
			unlock();
		}
	}

	@bindThis
	public async extractEmojis(tags: IObject | IObject[], host: string): Promise<MiEmoji[]> {
		// eslint-disable-next-line no-param-reassign
		host = this.utilityService.toPuny(host);

		const eomjiTags = toArray(tags).filter(isEmoji);

		const existingEmojis = await this.emojisRepository.findBy({
			host,
			name: In(eomjiTags.map(tag => tag.name.replaceAll(':', ''))),
		});

		return await Promise.all(eomjiTags.map(async tag => {
			const name = tag.name.replaceAll(':', '');
			tag.icon = toSingle(tag.icon);

			const exists = existingEmojis.find(x => x.name === name);

			if (exists) {
				if ((exists.updatedAt == null)
					|| (tag.id != null && exists.uri == null)
					|| (new Date(tag.updated) > exists.updatedAt)
					|| (tag.icon.url !== exists.originalUrl)
				) {
					await this.emojisRepository.update({
						host,
						name,
					}, {
						uri: tag.id,
						originalUrl: tag.icon.url,
						publicUrl: tag.icon.url,
						updatedAt: new Date(),
						// _misskey_license が存在しなければ `null`
						license: (tag._misskey_license?.freeText ?? null)
					});

					const emoji = await this.emojisRepository.findOneBy({ host, name });
					if (emoji == null) throw new Error('emoji update failed');
					return emoji;
				}

				return exists;
			}

			this.logger.info(`register emoji host=${host}, name=${name}`);

			return await this.emojisRepository.insertOne({
				id: this.idService.gen(),
				host,
				name,
				uri: tag.id,
				originalUrl: tag.icon.url,
				publicUrl: tag.icon.url,
				updatedAt: new Date(),
				aliases: [],
				// _misskey_license が存在しなければ `null`
				license: (tag._misskey_license?.freeText ?? null)
			});
		}));
	}
}
