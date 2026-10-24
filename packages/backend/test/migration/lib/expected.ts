/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import type { CatalogObjects } from './catalog.js';

export const oursFrom = 1792429514508;

export const migrationClass = /^export class (\w+)/m;

export const ours = [
	'NotePartitioningShadow1792429514508',
	'NoteReactionPartitioningShadow1792429514509',
	'DriveFileAccessKeyLookup1792429514510',
	'UserDriveUsageCounter1792429514511',
	'DriveFileSortIndexes1792429514512',
	'DriveFileDropUnusedIndexes1792429514513',
	'DriveFolderFilesCountCounter1792429514514',
	'DriveFileMd5Lookup1792429514515',
	'NoteRelation1792429514516',
	'NoteDropSelfReferencingForeignKeys1792429514517',
	'NoteUriLookup1792429514518',
	'PartitionMigrationState1792429514519',
	'DropUserFederationPolicy1792429514520',
	'NotePendingParent1792429514521',
	'UserNoteIdFloor1792429514522',
	'NoteUnlinkedRelation1792429514523',
	'NoteReactionLocator1792429514524',
	'DeletedNote1792429514525',
];

export const upstreamSelfForeignKeyRemoval = 'RemoveNoteConstraints1753868431598';

export const selfForeignKeys = ['note.FK_17cb3553c700a4985dff5a30ff5', 'note.FK_52ccc804d7c69037d558bac4c96'];

export const createdByOurs: CatalogObjects = {
	tables: ['note_p', 'note_reaction_p', 'drive_file_access_key', 'user_drive_usage', 'drive_file_md5', 'note_relation', 'note_uri', 'partition_migration_state', 'note_pending_parent', 'note_unlinked_relation', 'note_reaction_locator', 'deleted_note'],
	columns: ['drive_folder.filesCount', 'user.noteIdFloor'],
	indexes: ['IDX_78a7dc77823e2476886c96be05', 'IDX_6c943175a8ebbe892f6992408b', 'IDX_10de3938f7c1bb443f6d51b003', 'IDX_b6d0e3bf977997a9911b0a5311', 'IDX_8fa3991d01ef7478fe89ed629f', 'IDX_eb025e7ab43c991b506fd7d856', 'IDX_928ced07f37014b01ef1267c30', 'IDX_bef634b9dbc2a6a86fc91e7731'],
	functions: ['drive_file_sync_access_keys', 'drive_file_sync_usage', 'drive_file_sync_folder_files_count', 'drive_file_sync_md5', 'note_reaction_locator_insert', 'note_reaction_locator_delete', 'note_reaction_locator_update'],
	triggers: ['drive_file.drive_file_access_key_sync', 'drive_file.drive_file_usage_sync', 'drive_file.drive_file_folder_files_count_sync', 'drive_file.drive_file_md5_sync', 'note_reaction_p.note_reaction_locator_insert', 'note_reaction_p.note_reaction_locator_delete', 'note_reaction_p.note_reaction_locator_update'],
	constraints: ['note_relation.CHK_547cc29e50f07df9fc86a116fb', 'note_pending_parent.FK_928ced07f37014b01ef1267c305'],
};

export const droppedByOurs: CatalogObjects = {
	columns: ['user.federationPolicy'],
	indexes: ['IDX_e5848eac4940934e23dbc17581', 'IDX_a7eba67f8b3fa27271e85d2e26', 'IDX_3b33dff77bb64b23c88151d23e', 'IDX_8bdcd3dd2bddb78014999a16ce'],
	constraints: selfForeignKeys,
};

export const foreignKeysAddedByDeploy = ['note_pending_parent.FK_928ced07f37014b01ef1267c305 FOREIGN KEY ("childId") REFERENCES note(id) ON DELETE CASCADE'];

export const deployedCopies = {
	relkinds: { note: 'r', note_old: null, note_p: 'p', note_reaction: 'r', note_reaction_old: null, note_reaction_p: 'p' },
	triggers: ['note_reaction_p.note_reaction_locator_delete', 'note_reaction_p.note_reaction_locator_insert', 'note_reaction_p.note_reaction_locator_update'],
	functions: [],
	children: { note_p: 0, note_reaction_p: 0 },
};

const headDrift = {
	up: [
		'ALTER TABLE "user_profile" DROP CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9"',
		'ALTER TABLE "channel_anonymous_salt" DROP CONSTRAINT "FK_52001e5bea6d49bd8a19243d3b"',
		'DROP INDEX "public"."IDX_1e9b0b6b3b5f5e2b2f7d7c6f0e"',
		'DROP INDEX "public"."IDX_37988dcb4783a496681dcd4b4a"',
		'DROP INDEX "public"."IDX_b86b095617434a08bd1826489"',
		'DROP INDEX "public"."IDX_9b6d30f18ed64a82ac5aa5fc0"',
		'DROP INDEX "public"."IDX_f7be165bf5ef42328a171a8a1"',
		'ALTER TABLE "user_profile" ADD CONSTRAINT "UQ_46b370c9512cbc7a09625f3efd5" UNIQUE ("pinnedGalleryPostId")',
		'CREATE INDEX "IDX_b1ce5693f9dbf090360f27c475" ON "note"  ("anonymouslySendToUserId") ',
		'CREATE INDEX "IDX_0bb96ce265b185e60d4c9c36bd" ON "channel_anonymous_salt"  ("channelId") ',
		'CREATE INDEX "IDX_6272a7df70b138d31a0fd884c9" ON "channel_anonymous_salt"  ("since") ',
		'CREATE INDEX "IDX_7d9f2a61601f17ef1286541d9d" ON "channel_anonymous_salt"  ("until") ',
		'CREATE UNIQUE INDEX "IDX_b4e52d0bf15b1413914b294892" ON "channel_anonymous_salt"  ("channelId", "since", "until") ',
		'CREATE INDEX "IDX_74c8b7567debda8a7167acc1d9" ON "emoji"  ("hidden") ',
		'ALTER TABLE "user_profile" ADD CONSTRAINT "FK_46b370c9512cbc7a09625f3efd5" FOREIGN KEY ("pinnedGalleryPostId") REFERENCES "gallery_post"("id") ON DELETE SET NULL ON UPDATE NO ACTION',
		'ALTER TABLE "channel_anonymous_salt" ADD CONSTRAINT "FK_0bb96ce265b185e60d4c9c36bd6" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
	],
	down: [
		'ALTER TABLE "user_profile" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9" FOREIGN KEY ("anonymouslySendToUserId", "pinnedGalleryPostId") REFERENCES "gallery_post"("id","id") ON DELETE SET NULL ON UPDATE NO ACTION',
		'ALTER TABLE "channel_anonymous_salt" ADD CONSTRAINT "FK_52001e5bea6d49bd8a19243d3b" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'CREATE INDEX "IDX_1e9b0b6b3b5f5e2b2f7d7c6f0e" ON "note" USING btree ("anonymouslySendToUserId") ',
		'CREATE INDEX "IDX_37988dcb4783a496681dcd4b4a" ON "channel_anonymous_salt" USING btree ("channelId") ',
		'CREATE INDEX "IDX_b86b095617434a08bd1826489" ON "channel_anonymous_salt" USING btree ("since") ',
		'CREATE INDEX "IDX_9b6d30f18ed64a82ac5aa5fc0" ON "channel_anonymous_salt" USING btree ("until") ',
		'CREATE UNIQUE INDEX "IDX_f7be165bf5ef42328a171a8a1" ON "channel_anonymous_salt" USING btree ("channelId", "since", "until") ',
		'ALTER TABLE "user_profile" DROP CONSTRAINT "UQ_46b370c9512cbc7a09625f3efd5"',
		'DROP INDEX "public"."IDX_b1ce5693f9dbf090360f27c475"',
		'DROP INDEX "public"."IDX_0bb96ce265b185e60d4c9c36bd"',
		'DROP INDEX "public"."IDX_6272a7df70b138d31a0fd884c9"',
		'DROP INDEX "public"."IDX_7d9f2a61601f17ef1286541d9d"',
		'DROP INDEX "public"."IDX_b4e52d0bf15b1413914b294892"',
		'DROP INDEX "public"."IDX_74c8b7567debda8a7167acc1d9"',
		'ALTER TABLE "user_profile" DROP CONSTRAINT "FK_46b370c9512cbc7a09625f3efd5"',
		'ALTER TABLE "channel_anonymous_salt" DROP CONSTRAINT "FK_0bb96ce265b185e60d4c9c36bd6"',
	],
};

const outwardForeignKeyDrops = {
	up: [
		'ALTER TABLE "note" DROP CONSTRAINT "FK_5b87d9d19127bd5d92026017a7b"',
		'ALTER TABLE "note" DROP CONSTRAINT "FK_f22169eb10657bded6d875ac8f9"',
		'ALTER TABLE "note" DROP CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9"',
		'ALTER TABLE "note_reaction" DROP CONSTRAINT "FK_13761f64257f40c5636d0ff95ee"',
	],
	down: [
		'ALTER TABLE "note" ADD CONSTRAINT "FK_5b87d9d19127bd5d92026017a7b" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "note" ADD CONSTRAINT "FK_f22169eb10657bded6d875ac8f9" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "note" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9" FOREIGN KEY ("anonymouslySendToUserId", "pinnedGalleryPostId") REFERENCES "user"("id","id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "note_reaction" ADD CONSTRAINT "FK_13761f64257f40c5636d0ff95ee" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
	],
};

export const checkMigrationsAfterDeploy = {
	up: [...outwardForeignKeyDrops.up, ...headDrift.up],
	down: [...outwardForeignKeyDrops.down, ...headDrift.down],
};

export const phases = [
	'reactionNoteIdIdIndex',
	'noteUriBackfill',
	'noteInvertedRelationUnlink',
	'noteParentOrderPlain',
	'noteRelationBackfill',
	'notePendingParentBackfill',
	'userNoteIdFloorIndex',
	'userNoteIdFloorBackfill',
	'notePrepare',
	'noteBackfill',
	'noteParentOrderPartitioned',
	'outwardForeignKeysDrop',
	'noteIndexes',
	'noteCutover',
	'noteAnalyze',
	'reactionPrepare',
	'reactionBackfill',
	'reactionIndexes',
	'reactionLocatorFill',
	'reactionLookupIndexes',
	'noteReactionCutover',
	'reactionForeignKeys',
	'reactionAnalyze',
];

export const transientStates = ['noteParity', 'noteSwitch', 'reactionParity', 'reactionSwitch', 'noteDrop', 'reactionDrop'];

export const backfillPhases: Record<string, string> = { note: 'noteBackfill', note_reaction: 'reactionBackfill' };

export const partitionKeys: Record<string, string> = { note: 'id', note_reaction: 'noteId' };

type ExpectedIndex = { name: string; body: string; unique: boolean; primary: boolean };

const index = (name: string, body: string, unique = false, primary = false): ExpectedIndex => ({ name, body, unique, primary });

export const copyIndexes: Record<string, Record<'plain' | 'partitioned', ExpectedIndex[]>> = {
	note: {
		plain: [
			index('PK_96d0c172a4fba276b1bbed43058', 'USING btree (id)', true, true),
			index('IDX_153536c67d05e9adb24e99fc2b', 'USING btree (uri)', true),
			index('IDX_17cb3553c700a4985dff5a30ff', 'USING btree ("replyId")'),
			index('IDX_1e9b0b6b3b5f5e2b2f7d7c6f0e', 'USING btree ("anonymouslySendToUserId")'),
			index('IDX_52ccc804d7c69037d558bac4c9', 'USING btree ("renoteId")'),
			index('IDX_7125a826ab192eb27e11d358a5', 'USING btree ("userHost")'),
			index('IDX_NOTE_FILE_IDS', 'USING gin ("fileIds")'),
			index('IDX_NOTE_MENTIONS', 'USING gin (mentions)'),
			index('IDX_NOTE_TAGS', 'USING gin (tags)'),
			index('IDX_NOTE_VISIBLE_USER_IDS', 'USING gin ("visibleUserIds")'),
			index('IDX_a6f649630f55af3888e5a42919', 'USING btree ("userId", id DESC)'),
			index('IDX_d4ebdef929896d6dc4a3c5bb48', 'USING btree ("threadId")'),
			index('IDX_f22169eb10657bded6d875ac8f', 'USING btree ("channelId")'),
		],
		partitioned: [
			index('PK_96d0c172a4fba276b1bbed43058', 'USING btree (id)', true, true),
			index('IDX_153536c67d05e9adb24e99fc2b', 'USING btree (uri)'),
			index('IDX_17cb3553c700a4985dff5a30ff', 'USING btree ("replyId")'),
			index('IDX_1e9b0b6b3b5f5e2b2f7d7c6f0e', 'USING btree ("anonymouslySendToUserId")'),
			index('IDX_52ccc804d7c69037d558bac4c9', 'USING btree ("renoteId")'),
			index('IDX_7125a826ab192eb27e11d358a5', 'USING btree ("userHost")'),
			index('IDX_NOTE_FILE_IDS', 'USING gin ("fileIds")'),
			index('IDX_NOTE_MENTIONS', 'USING gin (mentions)'),
			index('IDX_NOTE_TAGS', 'USING gin (tags)'),
			index('IDX_NOTE_VISIBLE_USER_IDS', 'USING gin ("visibleUserIds")'),
			index('IDX_a6f649630f55af3888e5a42919', 'USING btree ("userId", id DESC)'),
			index('IDX_d4ebdef929896d6dc4a3c5bb48', 'USING btree ("threadId")'),
			index('IDX_f22169eb10657bded6d875ac8f', 'USING btree ("channelId")'),
		],
	},
	note_reaction: {
		plain: [
			index('PK_767ec729b108799b587a3fcc9cf', 'USING btree (id)', true, true),
			index('IDX_13761f64257f40c5636d0ff95e', 'USING btree ("userId")'),
			index('IDX_45145e4953780f3cd5656f0ea6', 'USING btree ("noteId")'),
			index('IDX_ad0c221b25672daf2df320a817', 'USING btree ("userId", "noteId")', true),
			index('IDX_NOTE_REACTION_NOTE_ID_ID', 'USING btree ("noteId", id)'),
		],
		partitioned: [
			index('PK_767ec729b108799b587a3fcc9cf', 'USING btree ("noteId", id)', true, true),
			index('IDX_ad0c221b25672daf2df320a817', 'USING btree ("userId", "noteId")', true),
			index('IDX_NOTE_REACTION_ID', 'USING btree (id)'),
			index('IDX_NOTE_REACTION_USER_ID_ID', 'USING btree ("userId", id)'),
		],
	},
};

export const foreignKeysReferencingNote = [
	'channel_note_pining.FK_10b19ef67d297ea9de325cd4502',
	'clip_note.FK_a012eaf5c87c65da1deb5fdbfa3',
	'note_favorite.FK_0e00498f180193423c992bc4370',
	'note_reaction.FK_45145e4953780f3cd5656f0ea6a',
	'note_unread.FK_e637cba4dc4410218c4251260e4',
	'note_watching.FK_03e7028ab8388a3f5e3ce2a8619',
	'poll.FK_da851e06d0dfe2ef397d8b1bf1b',
	'poll_vote.FK_aecfbd5ef60374918e63ee95fa7',
	'promo_note.FK_e263909ca4fe5d57f8d4230dd5c',
	'promo_read.FK_a46a1a603ecee695d7db26da5f4',
	'user_note_pining.FK_68881008f7c3588ad7ecae471cf',
	'note_pending_parent.FK_928ced07f37014b01ef1267c305',
];

export const outwardForeignKeys = [
	'note.FK_5b87d9d19127bd5d92026017a7b',
	'note.FK_f22169eb10657bded6d875ac8f9',
	'note.FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9',
	'note_reaction.FK_13761f64257f40c5636d0ff95ee',
];

export const parentOrderTriggers = ['note_parent_order_insert', 'note_parent_order_update'];

export const locatorTriggers = ['note_reaction_locator_delete', 'note_reaction_locator_insert', 'note_reaction_locator_update'];

export const parentOrderFunctionBody = `
	BEGIN
		IF (NEW."replyId" >= NEW."id" AND (TG_OP = 'INSERT' OR NEW."replyId" IS DISTINCT FROM OLD."replyId"))
			OR (NEW."renoteId" >= NEW."id" AND (TG_OP = 'INSERT' OR NEW."renoteId" IS DISTINCT FROM OLD."renoteId")) THEN
			RAISE EXCEPTION 'note % refers to a parent that is not older than itself (replyId %, renoteId %)', NEW."id", NEW."replyId", NEW."renoteId";
		END IF;
		RETURN NEW;
	END;
`;

export const dependentColumns: [string, string][] = [
	['poll', 'noteId'],
	['poll_vote', 'noteId'],
	['note_favorite', 'noteId'],
	['clip_note', 'noteId'],
	['user_note_pining', 'noteId'],
	['promo_note', 'noteId'],
	['promo_read', 'noteId'],
	['note_unlinked_relation', 'noteId'],
	['note_pending_parent', 'childId'],
];

export const allowedJobLogs = [
	/^another run is in progress$/,
	/^suspended at \w+$/,
	/^phase \w+ finished$/,
	/^\S+ rejects writes that \S+ accepts, dropping .+$/,
	/^adding .+ of \S+ to \S+$/,
	/^dropping the stale .+ of \S+$/,
	/^dropping .+ of \S+, which \S+ does not have$/,
	/^\S+ switched to the (partitioned|plain) copy$/,
	/^\S+ dropped$/,
	/^\S+ is switched to the (partitioned|plain) copy after \S+$/,
	/^\S+ stays on the plain copy while partitionMigration\.liveTable is \S+$/,
];

export const lockTimeoutJobLog = /failed: .*canceling statement due to lock timeout/;

export const startupJobId = 'partitionMigration-startup';

export const jobRunBudgetMs = 4 * 60 * 1000;

export const schedulerRegistrationIntervalMs = 5 * 60 * 1000;

export const schedulerPeriodMs = 5 * 60 * 1000;

export const schedulerJobId = /^repeat:partitionMigration:(\d+)$/;

export const jobLostWithRedis = /(?:could not renew lock|Missing (?:key|lock)) for job (\S+?)\.?(?:\s|$)/;

export const harnessDelivery = /\[queue deliver\]\tfailed\((EntityNotFoundError: Could not find any entity of type "MiUserKeypair" matching|UnrecoverableError: job stalled more than allowable limit\) .* to=https:\/\/[a-z0-9-]+\.e2e\.invalid\/)/;

export const postCommitJobLog = / (switched to the (partitioned|plain) copy|dropped)\$$/;

export const businessErrors = {
	identifiable: [
		'51c42bb4-931a-456b-bff7-e5a8a70dd298',
		'a149b3de-783e-433e-9ee6-d2642d817af4',
		'60527ec9-b4cb-4a88-a6bd-32d3ad26817d',
		'70c4e51f-5bea-449c-a030-53bee3cce202',
		'b302d4cf-c050-400a-bbb3-be208681f40c',
		'6dd26674-e060-4816-909a-45ba3f4da458',
		'a402c12b-34dd-41d2-97d8-4d2ffd96a1a6',
		'80848a2c-398f-4343-baa9-df1d57696c56',
		'b625fc69-635e-45e9-86f4-dbefbef35af5',
		'5ff67ada-ed3b-2e71-8e87-a1a421e177d2',
		'bddd57ac-ceb3-b29d-4334-86ea5fae481a',
	],
	classes: ['ClipService.NoSuchNoteError'],
	messages: ['poll not found', 'note not found'],
};

const headDriftAfterOutwardDrop = {
	up: headDrift.up,
	down: headDrift.down.map(query => query.startsWith('ALTER TABLE "user_profile" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9"')
		? 'ALTER TABLE "user_profile" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9" FOREIGN KEY ("pinnedGalleryPostId") REFERENCES "gallery_post"("id") ON DELETE SET NULL ON UPDATE NO ACTION'
		: query),
};

const entityForeignKeysToNote = {
	up: [
		'ALTER TABLE "clip_note" ADD CONSTRAINT "FK_a012eaf5c87c65da1deb5fdbfa3" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "note_favorite" ADD CONSTRAINT "FK_0e00498f180193423c992bc4370" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "note_pending_parent" ADD CONSTRAINT "FK_928ced07f37014b01ef1267c305" FOREIGN KEY ("childId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "note_reaction" ADD CONSTRAINT "FK_45145e4953780f3cd5656f0ea6a" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "poll" ADD CONSTRAINT "FK_da851e06d0dfe2ef397d8b1bf1b" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "poll_vote" ADD CONSTRAINT "FK_aecfbd5ef60374918e63ee95fa7" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "promo_note" ADD CONSTRAINT "FK_e263909ca4fe5d57f8d4230dd5c" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "promo_read" ADD CONSTRAINT "FK_a46a1a603ecee695d7db26da5f4" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
		'ALTER TABLE "user_note_pining" ADD CONSTRAINT "FK_68881008f7c3588ad7ecae471cf" FOREIGN KEY ("noteId") REFERENCES "note"("id") ON DELETE CASCADE ON UPDATE NO ACTION',
	],
	down: [
		'ALTER TABLE "clip_note" DROP CONSTRAINT "FK_a012eaf5c87c65da1deb5fdbfa3"',
		'ALTER TABLE "note_favorite" DROP CONSTRAINT "FK_0e00498f180193423c992bc4370"',
		'ALTER TABLE "note_pending_parent" DROP CONSTRAINT "FK_928ced07f37014b01ef1267c305"',
		'ALTER TABLE "note_reaction" DROP CONSTRAINT "FK_45145e4953780f3cd5656f0ea6a"',
		'ALTER TABLE "poll" DROP CONSTRAINT "FK_da851e06d0dfe2ef397d8b1bf1b"',
		'ALTER TABLE "poll_vote" DROP CONSTRAINT "FK_aecfbd5ef60374918e63ee95fa7"',
		'ALTER TABLE "promo_note" DROP CONSTRAINT "FK_e263909ca4fe5d57f8d4230dd5c"',
		'ALTER TABLE "promo_read" DROP CONSTRAINT "FK_a46a1a603ecee695d7db26da5f4"',
		'ALTER TABLE "user_note_pining" DROP CONSTRAINT "FK_68881008f7c3588ad7ecae471cf"',
	],
};

const reactionPrimaryKey = {
	up: [
		'ALTER TABLE "note_reaction" DROP CONSTRAINT "PK_767ec729b108799b587a3fcc9cf"',
		'ALTER TABLE "note_reaction" ADD CONSTRAINT "PK_767ec729b108799b587a3fcc9cf" PRIMARY KEY ("id")',
		'DROP INDEX "public"."IDX_ad0c221b25672daf2df320a817"',
		'CREATE UNIQUE INDEX "IDX_ad0c221b25672daf2df320a817" ON "note_reaction"  ("userId", "noteId") ',
	],
	down: [
		'ALTER TABLE "note_reaction" DROP CONSTRAINT "PK_767ec729b108799b587a3fcc9cf"',
		'ALTER TABLE "note_reaction" ADD CONSTRAINT "PK_767ec729b108799b587a3fcc9cf" PRIMARY KEY ("id", "noteId")',
		'DROP INDEX "public"."IDX_ad0c221b25672daf2df320a817"',
		'CREATE UNIQUE INDEX "IDX_ad0c221b25672daf2df320a817" ON "note_reaction" USING btree ("noteId", "userId") ',
	],
};

const coveredReactionIndexes = {
	up: [
		'CREATE INDEX "IDX_13761f64257f40c5636d0ff95e" ON "note_reaction"  ("userId") ',
		'CREATE INDEX "IDX_45145e4953780f3cd5656f0ea6" ON "note_reaction"  ("noteId") ',
	],
	down: [
		'DROP INDEX "public"."IDX_13761f64257f40c5636d0ff95e"',
		'DROP INDEX "public"."IDX_45145e4953780f3cd5656f0ea6"',
	],
};

const partitionedUriIndex = {
	up: [
		'DROP INDEX "public"."IDX_153536c67d05e9adb24e99fc2b"',
		'CREATE UNIQUE INDEX "IDX_153536c67d05e9adb24e99fc2b" ON "note"  ("uri") ',
	],
	down: [
		'DROP INDEX "public"."IDX_153536c67d05e9adb24e99fc2b"',
		'CREATE INDEX "IDX_153536c67d05e9adb24e99fc2b" ON "note" USING btree ("uri") ',
	],
};

export const checkMigrationsPlain = {
	up: [...headDriftAfterOutwardDrop.up, ...entityForeignKeysToNote.up],
	down: [...headDriftAfterOutwardDrop.down, ...entityForeignKeysToNote.down],
};

export const checkMigrationsPartitioned = {
	up: [...headDriftAfterOutwardDrop.up, ...entityForeignKeysToNote.up, ...reactionPrimaryKey.up, ...coveredReactionIndexes.up, ...partitionedUriIndex.up],
	down: [...headDriftAfterOutwardDrop.down, ...entityForeignKeysToNote.down, ...reactionPrimaryKey.down, ...coveredReactionIndexes.down, ...partitionedUriIndex.down],
};

export const fixtures = {
	noteCoexistence: { file: '1900000000001-e2eNoteCoexistence.js', name: 'E2eNoteCoexistence1900000000001' },
	noteColumnDrift: { file: '1900000000002-e2eNoteColumnDrift.js', name: 'E2eNoteColumnDrift1900000000002' },
	noteColumnDriftFix: { file: '1900000000003-e2eNoteColumnDriftFix.js', name: 'E2eNoteColumnDriftFix1900000000003' },
	reactionCoexistence: { file: '1900000000004-e2eReactionCoexistence.js', name: 'E2eReactionCoexistence1900000000004' },
	afterPlainSwitch: { file: '1900000000005-e2eAfterPlainSwitch.js', name: 'E2eAfterPlainSwitch1900000000005' },
	afterPartitionedSwitch: { file: '1900000000006-e2eAfterPartitionedSwitch.js', name: 'E2eAfterPartitionedSwitch1900000000006' },
	deployDuringBackfill: { file: '1900000000007-e2eDeployDuringBackfill.js', name: 'E2eDeployDuringBackfill1900000000007' },
	deployDuringIndexBuild: { file: '1900000000008-e2eDeployDuringIndexBuild.js', name: 'E2eDeployDuringIndexBuild1900000000008' },
};

export const driftRefusal = 'The columns of note and note_p differ (e2eDrift) while note_sync mirrors writes between them. Apply the column change to every copy with alterPartitionCopies.';

type IndexDelta = { without?: string[]; with?: ExpectedIndex[] };

export type StageExpectation = {
	columns: Record<string, { name: string; type: string }[]>;
	nullable: Record<string, string[]>;
	checks: Record<string, string[]>;
	indexes: Record<string, { live?: IndexDelta; standby?: IndexDelta }>;
	uniqueBeforeSwitch: string[];
};

const fixtureColumns = [{ name: 'e2eAdded', type: 'character varying(32)' }, { name: 'e2eDrift', type: 'integer' }];

const idLengthCheck = 'CHK_e2e_note_id_length CHECK ((length((id)::text) >= 10))';

const reactionUniqueConstraint = index('UQ_e2e_reaction_note_user_reaction', 'USING btree ("noteId", "userId", reaction)', true);

const headSchema: StageExpectation = { columns: {}, nullable: {}, checks: {}, indexes: {}, uniqueBeforeSwitch: [] };

export const stageExpectations: Record<string, StageExpectation> = {
	S2: {
		columns: { note: fixtureColumns },
		nullable: { note: ['pageCount'] },
		checks: { note: [idLengthCheck] },
		indexes: { note_reaction: { live: { without: ['IDX_ad0c221b25672daf2df320a817'] }, standby: { without: ['IDX_ad0c221b25672daf2df320a817'] } } },
		uniqueBeforeSwitch: [],
	},
	S3: {
		columns: { note: fixtureColumns },
		nullable: {},
		checks: {},
		indexes: {
			note: { live: { without: ['IDX_d4ebdef929896d6dc4a3c5bb48'] } },
			note_reaction: { live: { with: [reactionUniqueConstraint] }, standby: { without: ['IDX_ad0c221b25672daf2df320a817'] } },
		},
		uniqueBeforeSwitch: ['UQ_e2e_reaction_note_user_reaction'],
	},
	S4: { ...headSchema, indexes: { note: { standby: { without: ['IDX_d4ebdef929896d6dc4a3c5bb48'] } } } },
	S5: headSchema,
	S5b: headSchema,
};

export const switchedUniqueConstraints = { note_reaction: 'UQ_e2e_reaction_note_user_reaction', note_reaction_old: 'UQ_e2e_reaction_note_user_reaction_old' };

export const expectedJobLogs: Record<string, { ordered: RegExp[][]; present: RegExp[] }> = {
	S2: {
		ordered: [[
			/^note_p rejects writes that note accepts, dropping NOT NULL "pageCount"$/,
			/^adding CHK_e2e_note_id_length of note to note_p$/,
			/^note switched to the partitioned copy$/,
			/^note_reaction_p rejects writes that note_reaction accepts, dropping IDX_ad0c221b25672daf2df320a817_mig$/,
			/^note_reaction switched to the partitioned copy$/,
		]],
		present: [],
	},
	S3: {
		ordered: [[
			/^switching note_reaction to the plain copy: attempt 1 failed: .*canceling statement due to lock timeout/,
			/^note_reaction switched to the plain copy$/,
			/^note switched to the plain copy$/,
			/^note_p rejects writes that note accepts, dropping CHK_e2e_note_id_length$/,
		]],
		present: [/^note is switched to the plain copy after note_reaction$/],
	},
	S4: {
		ordered: [[
			/^dropping IDX_d4ebdef929896d6dc4a3c5bb48_mig of note_p, which note does not have$/,
			/^adding NOT NULL "pageCount" of note to note_p$/,
			/^note switched to the partitioned copy$/,
			/^adding IDX_ad0c221b25672daf2df320a817, UQ_e2e_reaction_note_user_reaction of note_reaction to note_reaction_p$/,
			/^note_reaction switched to the partitioned copy$/,
			/^note_reaction_old rejects writes that note_reaction accepts, dropping UQ_e2e_reaction_note_user_reaction_old$/,
		]],
		present: [],
	},
	S5: {
		ordered: [[
			/^dropping note_old: attempt 1 failed: .*canceling statement due to lock timeout/,
			/^note_old dropped$/,
		]],
		present: [/^note_reaction_old dropped$/],
	},
	S5b: {
		ordered: [
			[/^note_reaction switched to the plain copy$/, /^note_reaction_p dropped$/],
			[/^note_reaction switched to the plain copy$/, /^adding IDX_d4ebdef929896d6dc4a3c5bb48 of note to note_old$/, /^note switched to the plain copy$/, /^note_p dropped$/],
		],
		present: [],
	},
};

export const fixtureProbeErrors = ['23502', '23505', '23514', '42601'];

export const deletedNoteNotification = { message: /^EntityNotFoundError: Could not find any entity of type "MiNote" matching: \{\s*"where": \{\s*"id": "(\w+)"/, stack: /NoteEntityService\.findNoteOrFail[\s\S]*NotificationEntityService\.#packInternal[\s\S]*NotificationService\.#createNotificationInternal/ };

export const reactionIdTaken = { message: /^Could not find any entity of type "MiNoteReaction" matching/, detail: /^Key \(id\)=\((\w+)\) already exists\.$/, statement: /INSERT INTO "note_reaction"[\s(]/ };

export const lockLimits = { perPartition: 100 };

export const oldestThreadsPerStage = 3;

export const rekeyRoundCap = 8;

export const rekeyHorizonMs = 60 * 60 * 1000;

export const killSuspectMs = 5000;

export const statementFailureWindowMs = 30 * 1000;

export const threadStatementShape = /FROM "note" WHERE "id" IN \(.*\) ORDER BY "id" FOR (KEY SHARE|UPDATE)$|FROM "user" WHERE "id" = ANY\(\$1\) ORDER BY "id" FOR KEY SHARE$|"note_thread_muting"|"note_pending_parent"|"note_relation"|^UPDATE "note" SET "(threadId|replyId|renoteId|repliesCount|renoteCount)"/;

export const appRoles = ['writer-a', 'writer-b', 'probe', 'clean'];

export const runnerStatementClasses: [string, RegExp][] = [
	['global', /^(LOCK TABLE|DROP TABLE|ANALYZE ONLY|CREATE TRIGGER|DROP TRIGGER|DROP FUNCTION|TRUNCATE)\b|^DO \$\$/],
	['global', /^ALTER TABLE "?(note|note_reaction)(_p|_old)?"? /],
	['global', /^DROP INDEX (IF EXISTS )?"/],
	['per-partition', /^(CREATE (UNIQUE )?INDEX CONCURRENTLY|DROP INDEX CONCURRENTLY)\b/],
	['per-partition', /^ALTER INDEX \S+ ATTACH PARTITION/],
	['per-partition', /^ALTER TABLE "?(note|note_reaction)_p_[0-9a-z]{2}"? /],
	['per-partition', /^ANALYZE "?(note|note_reaction)_p_[0-9a-z]{2}"?/],
	['per-partition', /^INSERT INTO "note_reaction_locator"/],
	['per-partition', /^SELECT \(SELECT count\(\*\)/],
];

export const connectionClasses: [string, RegExp][] = [
	['dbLong', /^(CREATE (UNIQUE )?INDEX CONCURRENTLY|DROP INDEX CONCURRENTLY|ALTER INDEX \S+ ATTACH PARTITION|ANALYZE |WITH batch AS \(|SELECT \(SELECT count\(\*\)|INSERT INTO "note_reaction_locator"|INSERT INTO "note_unlinked_relation"|INSERT INTO "partition_migration_state")/],
	['dbLong', /^UPDATE "note" SET "replyId" = CASE WHEN/],
	['db', /^(LOCK TABLE "[^"]+"(, "[^"]+")? IN ACCESS EXCLUSIVE MODE|SELECT pg_try_advisory_lock\()/],
];

export const connectionTimeouts: Record<string, string> = { dbLong: 'unset', db: '32768' };

export const genericPlanIterations = 8;

export const copyReference = /(?<![\w."])"?(note|note_reaction)(_old|_p(_[0-9a-z]{2})?)?"?(?![\w"])/;

export const noSuchNote = '24fcbfc6-2e37-42b6-8388-c29b3861a08d';
