/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

import { Inject, Injectable } from '@nestjs/common';
import { DataSource, EntityManager, QueryFailedError, Repository } from 'typeorm';
import { DI } from '@/di-symbols.js';
import type { Config } from '@/config.js';
import { MiPartitionMigrationState } from '@/models/PartitionMigrationState.js';
import type { PartitionMigrationPhaseState } from '@/models/PartitionMigrationState.js';
import type Logger from '@/logger.js';
import { bindThis } from '@/decorators.js';
import { IdService } from '@/core/IdService.js';
import { PARTITION_COUNT, childTableName, nextPrefix, ordinalToPrefix, prefixOf, prefixesAscending } from '@/misc/partition.js';
import {
	analyzePartitionedParent,
	buildSyncFunctionSql,
	inspectPartitionCopies,
	partitionCopyKeyColumns,
	partitionCopyTables,
	partitionedCopyName,
	partitionedCopyTriggers,
	plainCopyName,
	schemaMismatchSql,
	syncFunctionName,
	syncTriggerName,
} from '@/misc/partition-copies.js';
import type { PartitionCopies, PartitionCopyTable } from '@/misc/partition-copies.js';
import { copyThreadMutings, lockMutingUsers, mutingUserIdsOf, sweepPendingParents } from '@/misc/join-pending-children.js';
import { lockNoteRowsInIdOrder, lockNotesInIdOrder } from '@/misc/note-dependents.js';
import { unique } from '@/misc/prelude/array.js';
import { UNREFERENCEABLE_NOTE_ID } from '@/const.js';
import { QueueLoggerService } from '../QueueLoggerService.js';
import type * as Bull from 'bullmq';

const maxDuration = 1000 * 60 * 4;

const batchSizeDefault = 1000;

const batchSizeMin = 100;

const batchSizeMax = 5000;

const targetBatchBytes = 8 * 1024 * 1024;

const targetBatchMs = 100;

const lockTimeoutMs = 5000;

const watermarkSkewMarginMs = 1000 * 60 * 60;

const writerDrainGraceMs = 1000 * 60 * 60;

const maxCutoverRetryDelayMs = 1000 * 60 * 60 * 6;

const advisoryLockKey = 1787152817411;

const outwardForeignKeysPhase = 'outwardForeignKeysDrop';

const outwardForeignKeys: Record<PartitionCopyTable, { column: string; references: string }[]> = {
	note: [
		{ column: 'userId', references: 'user' },
		{ column: 'channelId', references: 'channel' },
		{ column: 'anonymouslySendToUserId', references: 'user' },
	],
	note_reaction: [
		{ column: 'userId', references: 'user' },
	],
};

const outwardForeignKeysSql = `
	SELECT con.conname AS "name", o."references" AS "references"
	FROM pg_constraint con
	JOIN pg_attribute a ON a.attrelid = con.conrelid AND con.conkey = ARRAY[a.attnum]
	JOIN unnest($2::text[], $3::text[]) AS o("column", "references") ON o."column" = a.attname AND con.confrelid = to_regclass(quote_ident(o."references"))
	WHERE con.conrelid = $1::regclass AND con.contype = 'f'
	ORDER BY con.conname
`;

const indexBuildsSql = `
	SELECT c.relname AS "name"
	FROM pg_stat_progress_create_index p
	JOIN pg_class c ON c.oid = p.index_relid
	WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1)
`;

const reactionLookupIndexes = [
	{ name: 'IDX_NOTE_REACTION_ID', body: 'USING btree (id)', columns: ['id'] },
	{ name: 'IDX_NOTE_REACTION_USER_ID_ID', body: 'USING btree ("userId", id)', columns: ['userId', 'id'] },
];

const reactionCutoverPrerequisites = ['reactionLocatorFill', 'reactionLookupIndexes'];

const noteSwitchPrerequisites = ['noteParentOrderPlain', 'noteParentOrderPartitioned'];

const parentOrderFunction = 'note_parent_order';

const parentOrderFunctionBody = `
	BEGIN
		IF (NEW."replyId" >= NEW."id" AND (TG_OP = 'INSERT' OR NEW."replyId" IS DISTINCT FROM OLD."replyId"))
			OR (NEW."renoteId" >= NEW."id" AND (TG_OP = 'INSERT' OR NEW."renoteId" IS DISTINCT FROM OLD."renoteId")) THEN
			RAISE EXCEPTION 'note % refers to a parent that is not older than itself (replyId %, renoteId %)', NEW."id", NEW."replyId", NEW."renoteId";
		END IF;
		RETURN NEW;
	END;
`;

const parentOrderFunctionSql = `CREATE OR REPLACE FUNCTION ${parentOrderFunction}() RETURNS trigger AS $$${parentOrderFunctionBody}$$ LANGUAGE plpgsql`;

const parentOrderTriggers = [
	{ name: 'note_parent_order_insert', event: 'INSERT' },
	{ name: 'note_parent_order_update', event: 'UPDATE' },
];

const parentOrderTriggerDefinitions = parentOrderTriggers.map(trigger => `CREATE TRIGGER ${trigger.name} BEFORE ${trigger.event} FOR EACH ROW EXECUTE FUNCTION ${parentOrderFunction}()`);

const parentOrderInstalledSql = `
	SELECT count(*)::int AS "count"
	FROM pg_trigger t
	JOIN pg_proc p ON p.oid = t.tgfoid
	WHERE t.tgrelid = $1::regclass AND t.tgenabled = 'O' AND p.prosrc = $2
		AND regexp_replace(pg_get_triggerdef(t.oid), ' ON \\S+ ', ' ') = ANY($3)
`;

const keyColumnsSql = 'SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum';

const plainBodySql = 'SELECT format(\'USING btree (%s)\', string_agg(quote_ident(a.attname), \', \' ORDER BY k.ord)) FROM unnest(i.indkey::int2[]) WITH ORDINALITY AS k(attnum, ord) JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum';

const uniqueConstraintSql = `
	SELECT concat(regexp_replace(pg_get_constraintdef(con.oid), '( DEFERRABLE)?( INITIALLY DEFERRED)?$', ''), substring(pg_get_indexdef(i.indexrelid) FROM ' WITH \\(.*\\)$'),
		CASE WHEN con.condeferrable THEN ' DEFERRABLE' END, CASE WHEN con.condeferred THEN ' INITIALLY DEFERRED' END)
	FROM pg_constraint con
	WHERE con.conindid = i.indexrelid AND con.conrelid = i.indrelid AND con.contype = 'u'
`;

const indexColumnsSql = `
	c.relname AS "name", substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') AS "body",
	i.indisunique AS "unique", i.indisprimary AS "primary", i.indisvalid AS "valid",
	(${keyColumnsSql}) AS "columns", substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') IS NOT DISTINCT FROM (${plainBodySql}) AS "plain",
	(${uniqueConstraintSql}) AS "constraint"
`;

const indexesSql = `
	SELECT ${indexColumnsSql}
	FROM pg_index i
	JOIN pg_class c ON c.oid = i.indexrelid
	WHERE i.indrelid = $1::regclass
	ORDER BY c.relname
`;

const unattachedChildIndexesSql = `
	SELECT ${indexColumnsSql}, p.inhrelid::regclass::text AS "partition"
	FROM pg_inherits p
	JOIN pg_index i ON i.indrelid = p.inhrelid
	JOIN pg_class c ON c.oid = i.indexrelid
	WHERE p.inhparent = $1::regclass AND NOT EXISTS (SELECT 1 FROM pg_inherits a WHERE a.inhrelid = i.indexrelid)
	ORDER BY c.relname
`;

const checkConstraintsSql = `
	SELECT conrelid = $1::regclass AS "live", conname AS "name", regexp_replace(pg_get_constraintdef(oid), ' NOT VALID$', '') AS "definition", convalidated AS "validated"
	FROM pg_constraint
	WHERE conrelid IN ($1::regclass, $2::regclass) AND contype = 'c'
	ORDER BY conname
`;

const notNullColumnsSql = `
	SELECT a.attname AS "column", format('NOT NULL %I', a.attname) AS "item", a.attnotnull AS "live", b.attnotnull AS "standby",
		format('CHECK ((%I IS NOT NULL))', a.attname) AS "check",
		b.attnum = ANY(coalesce(k.indkey::int2[], '{}') || coalesce(p.partattrs::int2[], '{}')) AS "key"
	FROM pg_attribute a
	JOIN pg_attribute b ON b.attrelid = $2::regclass AND b.attname = a.attname AND b.attnum > 0 AND NOT b.attisdropped
	LEFT JOIN pg_index k ON k.indrelid = b.attrelid AND k.indisprimary
	LEFT JOIN pg_partitioned_table p ON p.partrelid = b.attrelid
	WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
	ORDER BY a.attname
`;

const partitionConstraintsSql = `
	SELECT c.conrelid::regclass::text AS "partition"
	FROM pg_constraint c
	JOIN pg_inherits i ON i.inhrelid = c.conrelid
	WHERE i.inhparent = $1::regclass AND c.conname = $2 AND NOT c.convalidated
	ORDER BY 1
`;

const standbyDifferencesSql = `
	SELECT "item", count(*) FILTER (WHERE "rel" = $1::regclass) > count(*) FILTER (WHERE "rel" = $2::regclass) AS "live"
	FROM (
		SELECT conrelid AS "rel", pg_get_constraintdef(oid) AS "item"
		FROM pg_constraint
		WHERE conrelid IN ($1::regclass, $2::regclass) AND contype = 'f'
		UNION ALL
		SELECT a.attrelid, concat_ws(' ',
			format('column %I', a.attname),
			'default ' || pg_get_expr(d.adbin, d.adrelid),
			NULLIF('generated ' || a.attgenerated::text, 'generated '),
			NULLIF('identity ' || a.attidentity::text, 'identity '),
			'collate ' || NULLIF(a.attcollation, 0)::regcollation::text)
		FROM pg_attribute a
		LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid IN ($1::regclass, $2::regclass) AND a.attnum > 0 AND NOT a.attisdropped
		UNION ALL
		SELECT tgrelid, regexp_replace(pg_get_triggerdef(oid), ' ON \\S+ ', ' ')
		FROM pg_trigger
		WHERE tgrelid IN ($1::regclass, $2::regclass) AND NOT tgisinternal AND tgname <> ALL($3)
	) x
	GROUP BY "item"
	HAVING count(*) FILTER (WHERE "rel" = $1::regclass) <> count(*) FILTER (WHERE "rel" = $2::regclass)
	ORDER BY "item" COLLATE "C"
`;

type Queryable = Pick<EntityManager, 'query'>;

type Phase = {
	name: string;
	run: (job: Bull.Job, deadline: number) => Promise<boolean>;
};

type CopyIndex = {
	name: string;
	body: string;
	unique: boolean;
	primary: boolean;
	valid: boolean;
	columns: string[] | null;
	plain: boolean;
	constraint: string | null;
};

type ChildIndex = CopyIndex & {
	partition: string;
};

type IndexTarget = {
	index: CopyIndex;
	name: string;
};

type StandbyIndex = IndexTarget & {
	unique: boolean;
	constraint: string | null;
};

type CheckConstraint = {
	live: boolean;
	name: string;
	definition: string;
	validated: boolean;
};

type NotNullColumn = {
	column: string;
	item: string;
	live: boolean;
	standby: boolean;
	check: string;
	key: boolean;
};

type ConstraintGaps = {
	checks: CheckConstraint[];
	extraChecks: CheckConstraint[];
	extraNotNulls: NotNullColumn[];
	missingChecks: CheckConstraint[];
	unvalidatedChecks: CheckConstraint[];
	missingNotNulls: NotNullColumn[];
};

type CopyStates = {
	built: string;
	parity: string;
	switch: string;
	drop: string;
	partitionColumn: string;
	pendingForeignKeys: string | null;
};

const copyStates: Record<PartitionCopyTable, CopyStates> = {
	note: {
		built: 'noteIndexes',
		parity: 'noteParity',
		switch: 'noteSwitch',
		drop: 'noteDrop',
		partitionColumn: 'id',
		pendingForeignKeys: null,
	},
	note_reaction: {
		built: 'reactionIndexes',
		parity: 'reactionParity',
		switch: 'reactionSwitch',
		drop: 'reactionDrop',
		partitionColumn: 'noteId',
		pendingForeignKeys: 'note_reaction_swap_pending_fk',
	},
};

class ThreadMutingChangedError extends Error {}

@Injectable()
export class PartitionMigrationProcessorService {
	private logger: Logger;
	private partitionMigrationStatesRepository: Repository<MiPartitionMigrationState>;

	constructor(
		@Inject(DI.config)
		private config: Config,

		@Inject(DI.db)
		private db: DataSource,

		@Inject(DI.dbLong)
		private dbLong: DataSource,

		private idService: IdService,
		private queueLoggerService: QueueLoggerService,
	) {
		this.logger = this.queueLoggerService.logger.createSubLogger('partition-migration');
		this.partitionMigrationStatesRepository = this.dbLong.getRepository(MiPartitionMigrationState);
	}

	@bindThis
	private logToJob(job: Bull.Job, msg: string): void {
		job.log(msg).catch(() => {});
	}

	@bindThis
	private async loadState(name: string): Promise<PartitionMigrationPhaseState> {
		const row = await this.partitionMigrationStatesRepository.findOneBy({ name });
		return row?.state ?? {};
	}

	@bindThis
	private async saveState(name: string, state: PartitionMigrationPhaseState): Promise<void> {
		await this.partitionMigrationStatesRepository.upsert({ name, state }, ['name']);
	}

	@bindThis
	private async isFinished(name: string): Promise<boolean> {
		const row = await this.partitionMigrationStatesRepository.findOneBy({ name });
		return row?.finishedAt != null;
	}

	@bindThis
	private async finish(name: string): Promise<void> {
		await this.partitionMigrationStatesRepository.upsert({ name, finishedAt: new Date() }, ['name']);
	}

	@bindThis
	private async isBeingBuilt(...names: string[]): Promise<boolean> {
		const builds: { name: string }[] = await this.dbLong.query(indexBuildsSql, [names]);
		return builds.length > 0;
	}

	@bindThis
	private async initialBatchSize(table: string): Promise<number> {
		const [row]: { reltuples: number; relpages: number }[] = await this.dbLong.query(
			'SELECT reltuples::float8 AS "reltuples", relpages::float8 AS "relpages" FROM pg_class WHERE relname = $1 AND relnamespace = \'public\'::regnamespace',
			[table],
		);
		if (row == null || row.reltuples <= 0 || row.relpages <= 0) return batchSizeDefault;
		const avgRowBytes = (row.relpages * 8192) / row.reltuples;
		return Math.min(batchSizeMax, Math.max(batchSizeMin, Math.round(targetBatchBytes / avgRowBytes)));
	}

	@bindThis
	private nextBatchSize(current: number, elapsedMs: number): number {
		if (elapsedMs > targetBatchMs * 2) return Math.max(batchSizeMin, Math.floor(current / 2));
		if (elapsedMs < targetBatchMs / 2) return Math.min(batchSizeMax, Math.ceil(current * 1.25));
		return current;
	}

	@bindThis
	private async runBackfill(
		name: string,
		deadline: number,
		batchSql: string,
		table = 'note',
	): Promise<boolean> {
		const state = await this.loadState(name);
		if (state.watermark == null) {
			state.watermark = this.idService.gen(Date.now() + watermarkSkewMarginMs, true);
			state.batchSize = await this.initialBatchSize(table);
			await this.saveState(name, state);
		}
		while (Date.now() < deadline) {
			const begin = Date.now();
			const [{ maxId }]: { maxId: string | null }[] = await this.dbLong.query(batchSql, [state.cursor ?? '0', state.watermark, state.batchSize ?? batchSizeDefault]);
			if (maxId == null) return true;
			state.cursor = maxId;
			state.batchSize = this.nextBatchSize(state.batchSize ?? batchSizeDefault, Date.now() - begin);
			await this.saveState(name, state);
		}
		return false;
	}

	@bindThis
	private async runNoteUriBackfill(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runBackfill('noteUriBackfill', deadline, `
			WITH batch AS (
				SELECT "id", "uri" FROM "note"
				WHERE "id" > $1 AND "id" <= $2
				ORDER BY "id"
				LIMIT $3
			), ins AS (
				INSERT INTO "note_uri" ("uri", "noteId")
				SELECT "uri", "id" FROM batch
				WHERE "uri" IS NOT NULL
				ON CONFLICT DO NOTHING
			)
			SELECT max("id") AS "maxId" FROM batch
		`);
	}

	@bindThis
	private async runNoteRelationBackfill(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runBackfill('noteRelationBackfill', deadline, `
			WITH batch AS (
				SELECT "id", "replyId", "renoteId", "text", "cw", "hasPoll", "fileIds"
				FROM "note"
				WHERE "id" > $1 AND "id" <= $2
				ORDER BY "id"
				LIMIT $3
			), reply_edges AS (
				INSERT INTO "note_relation" ("childId", "parentId", "kind")
				SELECT "id", "replyId", 0
				FROM batch
				WHERE "replyId" IS NOT NULL AND "replyId" <> '${UNREFERENCEABLE_NOTE_ID}' AND "id" > "replyId"
				ON CONFLICT DO NOTHING
			), renote_edges AS (
				INSERT INTO "note_relation" ("childId", "parentId", "kind", "parentReplyUserId", "parentReplyUserHost", "parentRenoteUserId", "parentRenoteUserHost")
				SELECT b."id", b."renoteId",
					CASE WHEN b."text" IS NOT NULL OR b."cw" IS NOT NULL OR b."replyId" IS NOT NULL OR b."hasPoll" OR b."fileIds" <> '{}' THEN 1 ELSE 2 END,
					p."replyUserId", p."replyUserHost", p."renoteUserId", p."renoteUserHost"
				FROM batch b
				LEFT JOIN "note" p ON p."id" = b."renoteId"
				WHERE b."renoteId" IS NOT NULL AND b."renoteId" <> '${UNREFERENCEABLE_NOTE_ID}' AND b."id" > b."renoteId"
				ON CONFLICT DO NOTHING
			)
			SELECT max("id") AS "maxId" FROM batch
		`);
	}

	@bindThis
	private async runNoteInvertedRelationUnlink(_job: Bull.Job, deadline: number): Promise<boolean> {
		const name = 'noteInvertedRelationUnlink';
		const state = await this.loadState(name);
		if (state.watermark == null) {
			state.watermark = this.idService.gen(Date.now() + watermarkSkewMarginMs, true);
			state.batchSize = await this.initialBatchSize('note');
			await this.saveState(name, state);
		}
		while (Date.now() < deadline) {
			const begin = Date.now();
			const maxId = await this.dbLong.transaction('READ COMMITTED', async transactionalEntityManager => {
				const batch: { id: string; userId: string; threadId: string | null; replyId: string | null; renoteId: string | null }[] = await transactionalEntityManager.query(`
					SELECT "id", "userId", "threadId",
						CASE WHEN "replyId" >= "id" THEN "replyId" END AS "replyId",
						CASE WHEN "renoteId" >= "id" THEN "renoteId" END AS "renoteId"
					FROM "note"
					WHERE "id" > $1 AND "id" <= $2
					ORDER BY "id"
					LIMIT $3
				`, [state.cursor ?? '0', state.watermark, state.batchSize ?? batchSizeDefault]);
				if (batch.length === 0) return null;

				const threadIds = unique(batch.flatMap(row => (row.replyId != null && row.threadId != null ? [row.threadId] : [])));
				const mutingUserIds = await lockMutingUsers(transactionalEntityManager, threadIds);
				const locked = await lockNoteRowsInIdOrder(transactionalEntityManager, batch.filter(row => row.replyId != null || row.renoteId != null).map(row => row.id), 'UPDATE');
				if (locked.some(row => batch.some(note => note.id === row.id && note.replyId != null && note.threadId !== row.threadId))) return undefined;
				const lockedIds = locked.map(row => row.id);
				const inverted = batch.filter(row => lockedIds.includes(row.id));

				if (inverted.length > 0) {
					const parents: { id: string; userId: string; userHost: string | null; uri: string | null }[] = await transactionalEntityManager.query('SELECT "id", "userId", "userHost", "uri" FROM "note" WHERE "id" = ANY($1)', [[...new Set(inverted.flatMap(row => [row.replyId, row.renoteId]).filter(id => id != null))]]);
					const parentUris = new Map(parents.map(parent => [parent.id, parent.userHost == null ? `${this.config.url}/notes/${parent.id}` : parent.uri]));
					const parentUriOf = (id: string | null) => (id != null ? parentUris.get(id) ?? null : null);

					await transactionalEntityManager.query(`
						INSERT INTO "note_unlinked_relation" ("noteId", "replyId", "renoteId", "replyUri", "renoteUri")
						SELECT * FROM unnest($1::varchar[], $2::varchar[], $3::varchar[], $4::varchar[], $5::varchar[])
						ON CONFLICT DO NOTHING
					`, [inverted.map(row => row.id), inverted.map(row => row.replyId), inverted.map(row => row.renoteId), inverted.map(row => parentUriOf(row.replyId)), inverted.map(row => parentUriOf(row.renoteId))]);

					await transactionalEntityManager.query(`
						UPDATE "note" SET
							"replyId" = CASE WHEN "replyId" >= "id" THEN $2 ELSE "replyId" END,
							"renoteId" = CASE WHEN "renoteId" >= "id" THEN $2 ELSE "renoteId" END
						WHERE "id" = ANY($1) AND ("replyId" >= "id" OR "renoteId" >= "id")
					`, [inverted.map(row => row.id), UNREFERENCEABLE_NOTE_ID]);

					const unlinkedReplyIds = inverted.filter(row => row.replyId != null).map(row => row.id);
					if (unlinkedReplyIds.length > 0) {
						await transactionalEntityManager.query('UPDATE "note" SET "threadId" = NULL WHERE "id" = ANY($1)', [unlinkedReplyIds]);

						const visited = new Set<string>(unlinkedReplyIds);
						let frontier = new Map(inverted.filter(row => row.replyId != null && row.threadId != null).map(row => [row.id, row.id]));
						while (frontier.size > 0) {
							const children: { id: string; replyId: string }[] = await transactionalEntityManager.query('SELECT "id", "replyId" FROM "note" WHERE "replyId" = ANY($1)', [[...frontier.keys()]]);
							const next = new Map<string, string>();
							for (const child of children) {
								if (visited.has(child.id)) continue;
								visited.add(child.id);
								next.set(child.id, frontier.get(child.replyId)!);
							}
							if (next.size === 0) break;
							await lockNotesInIdOrder(transactionalEntityManager, [...next.keys()], 'UPDATE');
							await transactionalEntityManager.query(
								'UPDATE "note" AS n SET "threadId" = v."threadId" FROM unnest($1::varchar[], $2::varchar[]) AS v("id", "threadId") WHERE n."id" = v."id"',
								[[...next.keys()], [...next.values()]],
							);
							frontier = next;
						}

						if ((await mutingUserIdsOf(transactionalEntityManager, threadIds)).some(userId => !mutingUserIds.includes(userId))) throw new ThreadMutingChangedError();
						for (const row of inverted) {
							if (row.replyId != null && row.threadId != null) await copyThreadMutings(transactionalEntityManager, this.idService, mutingUserIds, [row.threadId], row.id);
						}
					}

					const replyCounts = new Map<string, number>();
					for (const row of inverted) {
						if (row.replyId != null) replyCounts.set(row.replyId, (replyCounts.get(row.replyId) ?? 0) + 1);
					}
					for (const [parentId, count] of replyCounts) {
						await transactionalEntityManager.query('UPDATE "note" SET "repliesCount" = GREATEST("repliesCount" - $2, 0) WHERE "id" = $1', [parentId, count]);
					}

					const renoted = inverted.filter(row => row.renoteId != null);
					if (renoted.length > 0) {
						const targetUserIds = new Map(parents.map(parent => [parent.id, parent.userId]));
						const bots: { id: string }[] = await transactionalEntityManager.query('SELECT "id" FROM "user" WHERE "id" = ANY($1) AND "isBot"', [[...new Set(renoted.map(row => row.userId))]]);
						const botIds = new Set(bots.map(bot => bot.id));
						const renoteCounts = new Map<string, number>();
						for (const row of renoted) {
							if (botIds.has(row.userId) || targetUserIds.get(row.renoteId!) === row.userId) continue;
							renoteCounts.set(row.renoteId!, (renoteCounts.get(row.renoteId!) ?? 0) + 1);
						}
						for (const [parentId, count] of renoteCounts) {
							await transactionalEntityManager.query('UPDATE "note" SET "renoteCount" = GREATEST("renoteCount" - $2, 0) WHERE "id" = $1', [parentId, count]);
						}
					}
				}

				return batch[batch.length - 1].id;
			}).catch((e: unknown) => {
				if (e instanceof ThreadMutingChangedError) return undefined;
				throw e;
			});
			if (maxId === undefined) continue;
			if (maxId == null) return true;
			state.cursor = maxId;
			state.batchSize = this.nextBatchSize(state.batchSize ?? batchSizeDefault, Date.now() - begin);
			await this.saveState(name, state);
		}
		return false;
	}

	@bindThis
	private async installParentOrder(job: Bull.Job, target: string): Promise<boolean> {
		try {
			await this.dbLong.transaction(async em => {
				await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
				await em.query(parentOrderFunctionSql);
				for (const trigger of parentOrderTriggers) {
					await em.query(`DROP TRIGGER IF EXISTS "${trigger.name}" ON "${target}"`);
					await em.query(`CREATE TRIGGER "${trigger.name}" BEFORE ${trigger.event} ON "${target}" FOR EACH ROW EXECUTE FUNCTION ${parentOrderFunction}()`);
				}
			});
		} catch (e) {
			const msg = `installing the parent order triggers on ${target} failed: ${String(e)}`;
			this.logger.warn(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async runParentOrder(job: Bull.Job, partitioned: boolean): Promise<boolean> {
		const copies = await inspectPartitionCopies(this.dbLong, 'note');
		const target = copies.partitioned === partitioned ? 'note' : copies.inactive;
		if (target == null) return true;
		return await this.installParentOrder(job, target);
	}

	@bindThis
	private async lacksParentOrder(q: Queryable, tables: string[]): Promise<string[]> {
		const lacking: string[] = [];
		for (const table of tables) {
			const [{ count }]: { count: number }[] = await q.query(parentOrderInstalledSql, [`"${table}"`, parentOrderFunctionBody, parentOrderTriggerDefinitions]);
			if (count !== parentOrderTriggerDefinitions.length) lacking.push(table);
		}
		return lacking;
	}

	@bindThis
	private async ensureParentOrder(job: Bull.Job, tables: string[]): Promise<boolean> {
		for (const table of await this.lacksParentOrder(this.dbLong, tables)) {
			const msg = `installing the parent order triggers on ${table} again before switching note`;
			this.logger.warn(msg);
			this.logToJob(job, msg);
			if (!await this.installParentOrder(job, table)) return false;
		}
		return true;
	}

	@bindThis
	private async runNoteParentOrderPlain(job: Bull.Job, _deadline: number): Promise<boolean> {
		return await this.runParentOrder(job, false);
	}

	@bindThis
	private async runNoteParentOrderPartitioned(job: Bull.Job, _deadline: number): Promise<boolean> {
		return await this.runParentOrder(job, true);
	}

	@bindThis
	private async runNotePendingParentBackfill(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await sweepPendingParents(this.dbLong, this.idService, deadline);
	}

	@bindThis
	private async runUserNoteIdFloorIndex(_job: Bull.Job, _deadline: number): Promise<boolean> {
		const existing: { valid: boolean }[] = await this.dbLong.query(
			'SELECT i.indisvalid AS "valid" FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = \'IDX_USER_NOTE_ID_FLOOR\'',
		);
		if (existing.length > 0 && existing[0].valid) return true;
		if (existing.length > 0 && await this.isBeingBuilt('IDX_USER_NOTE_ID_FLOOR')) return false;
		if (existing.length > 0) await this.dbLong.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_USER_NOTE_ID_FLOOR"');
		await this.dbLong.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_USER_NOTE_ID_FLOOR" ON "user" ("noteIdFloor") WHERE "noteIdFloor" IS NOT NULL');
		return true;
	}

	@bindThis
	private async runUserNoteIdFloorBackfill(_job: Bull.Job, deadline: number): Promise<boolean> {
		const name = 'userNoteIdFloorBackfill';
		const state = await this.loadState(name);
		if (state.watermark == null) {
			if (state.nextAttemptAt == null) {
				state.nextAttemptAt = Date.now() + writerDrainGraceMs;
				await this.saveState(name, state);
			}
			if (Date.now() < state.nextAttemptAt) return false;
		}

		const [{ relkind }]: { relkind: string }[] = await this.dbLong.query('SELECT relkind FROM pg_class WHERE oid = \'note\'::regclass');
		if (relkind !== 'p') {
			if (state.batchEnd != null || state.ord != null) {
				delete state.batchEnd;
				delete state.ord;
				await this.saveState(name, state);
			}
			return await this.runBackfill(name, deadline, `
				WITH batch AS (
					SELECT "id" FROM "user"
					WHERE "host" IS NOT NULL AND "id" > $1 AND "id" <= $2
					ORDER BY "id"
					LIMIT $3
				), floors AS (
					SELECT b."id", (SELECT min(n."id") FROM "note" n WHERE n."userId" = b."id") AS "floor"
					FROM batch b
				), upd AS (
					UPDATE "user" u SET "noteIdFloor" = f."floor"
					FROM floors f
					WHERE u."id" = f."id" AND f."floor" < COALESCE(u."noteIdFloor", u."id")
				)
				SELECT max("id") AS "maxId" FROM batch
			`, 'user');
		}

		if (state.watermark == null) {
			state.watermark = this.idService.gen(Date.now() + watermarkSkewMarginMs, true);
			await this.saveState(name, state);
		}
		while (Date.now() < deadline) {
			const users: { id: string; floor: string }[] = state.batchEnd == null
				? await this.dbLong.query(
					'SELECT "id", COALESCE("noteIdFloor", "id") AS "floor" FROM "user" WHERE "host" IS NOT NULL AND "id" > $1 AND "id" <= $2 ORDER BY "id" LIMIT $3',
					[state.cursor ?? '0', state.watermark, batchSizeDefault],
				)
				: await this.dbLong.query(
					'SELECT "id", COALESCE("noteIdFloor", "id") AS "floor" FROM "user" WHERE "host" IS NOT NULL AND "id" > $1 AND "id" <= $2',
					[state.cursor ?? '0', state.batchEnd],
				);
			if (state.batchEnd == null) {
				if (users.length === 0) return true;
				state.batchEnd = users[users.length - 1].id;
			}

			const pending = new Map(users.map(user => [user.id, prefixOf(user.floor)]));
			for (let ord = state.ord ?? 0; ord < PARTITION_COUNT; ord++) {
				const prefix = ordinalToPrefix(ord);
				for (const [userId, floorPrefix] of pending) {
					if (floorPrefix < prefix) pending.delete(userId);
				}
				if (pending.size === 0) break;
				if (Date.now() >= deadline) {
					state.ord = ord;
					await this.saveState(name, state);
					return false;
				}
				const upper = nextPrefix(prefix);
				const rows: { userId: string; minId: string }[] = upper == null
					? await this.dbLong.query('SELECT "userId", min("id") AS "minId" FROM "note" WHERE "id" >= $1 AND "userId" = ANY($2) GROUP BY "userId"', [prefix, [...pending.keys()]])
					: await this.dbLong.query('SELECT "userId", min("id") AS "minId" FROM "note" WHERE "id" >= $1 AND "id" < $2 AND "userId" = ANY($3) GROUP BY "userId"', [prefix, upper, [...pending.keys()]]);
				if (rows.length === 0) continue;
				await this.dbLong.query(`
					UPDATE "user" u SET "noteIdFloor" = f."floor"
					FROM unnest($1::varchar[], $2::varchar[]) AS f("id", "floor")
					WHERE u."id" = f."id" AND f."floor" < COALESCE(u."noteIdFloor", u."id")
				`, [rows.map(row => row.userId), rows.map(row => row.minId)]);
				for (const row of rows) pending.delete(row.userId);
			}

			state.cursor = state.batchEnd;
			delete state.batchEnd;
			delete state.ord;
			await this.saveState(name, state);
		}
		return false;
	}

	@bindThis
	private async copiesMatch(job: Bull.Job, table: string, other: string): Promise<boolean> {
		const mismatches: { col: string }[] = await this.dbLong.query(schemaMismatchSql(table, other));
		if (mismatches.length > 0) {
			const msg = `schema mismatch between ${table} and ${other}: ${mismatches.map(x => x.col).join(', ')}`;
			this.logger.error(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async assertCopiesMatch(em: EntityManager, table: string, other: string): Promise<void> {
		const mismatches: { col: string }[] = await em.query(schemaMismatchSql(table, other));
		if (mismatches.length > 0) {
			throw new Error(`schema mismatch between ${table} and ${other}: ${mismatches.map(x => x.col).join(', ')}`);
		}
	}

	@bindThis
	private async ensureChildPartitions(table: string, shadow: string, deadline: number): Promise<boolean> {
		const existing: { relname: string }[] = await this.dbLong.query(
			'SELECT c.relname FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid WHERE i.inhparent = $1::regclass',
			[`"${shadow}"`],
		);
		const existingNames = new Set(existing.map(x => x.relname));
		for (let ord = 0; ord < PARTITION_COUNT; ord++) {
			const from = ordinalToPrefix(ord);
			const child = childTableName(table, from);
			if (existingNames.has(child)) continue;
			if (Date.now() >= deadline) return false;
			const to = nextPrefix(from);
			await this.dbLong.query(`CREATE TABLE IF NOT EXISTS "${child}" PARTITION OF "${shadow}" FOR VALUES FROM ('${from}') TO ${to != null ? `('${to}')` : '(MAXVALUE)'}`);
		}
		return true;
	}

	@bindThis
	private async runPrepare(job: Bull.Job, deadline: number, table: PartitionCopyTable): Promise<boolean> {
		const shadow = partitionedCopyName(table);
		if (!await this.copiesMatch(job, table, shadow)) return false;
		if (!await this.ensureChildPartitions(table, shadow, deadline)) return false;
		if (!await this.dropRejectingConstraints(job, table, shadow, true)) return false;
		try {
			await this.dbLong.transaction(async em => {
				await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
				await em.query(buildSyncFunctionSql(table, shadow, syncFunctionName(table, false), partitionCopyKeyColumns[table]));
				await em.query(`DROP TRIGGER IF EXISTS "${syncTriggerName(table)}" ON "${table}"`);
				await em.query(`CREATE TRIGGER "${syncTriggerName(table)}" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${syncFunctionName(table, false)}()`);
			});
		} catch (e) {
			const msg = `installing the sync trigger on ${table} failed: ${String(e)}`;
			this.logger.warn(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async runNotePrepare(job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runPrepare(job, deadline, 'note');
	}

	@bindThis
	private async runNoteBackfill(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runBackfill('noteBackfill', deadline, `
			WITH batch AS (
				SELECT * FROM "note"
				WHERE "id" > $1 AND "id" <= $2
				ORDER BY "id"
				LIMIT $3
				FOR SHARE
			), ins AS (
				INSERT INTO "note_p"
				SELECT * FROM batch
				ON CONFLICT ("id") DO NOTHING
			)
			SELECT max("id") AS "maxId" FROM batch
		`);
	}

	@bindThis
	private async runReactionNoteIdIdIndex(_job: Bull.Job, _deadline: number): Promise<boolean> {
		const [{ relkind }]: { relkind: string }[] = await this.dbLong.query('SELECT relkind FROM pg_class WHERE oid = \'note_reaction\'::regclass');
		if (relkind === 'p') return true;
		const existing: { valid: boolean }[] = await this.dbLong.query(
			'SELECT i.indisvalid AS "valid" FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = \'IDX_NOTE_REACTION_NOTE_ID_ID\'',
		);
		if (existing.length > 0 && existing[0].valid) return true;
		if (existing.length > 0 && await this.isBeingBuilt('IDX_NOTE_REACTION_NOTE_ID_ID')) return false;
		if (existing.length > 0) await this.dbLong.query('DROP INDEX CONCURRENTLY IF EXISTS "IDX_NOTE_REACTION_NOTE_ID_ID"');
		await this.dbLong.query('CREATE INDEX CONCURRENTLY IF NOT EXISTS "IDX_NOTE_REACTION_NOTE_ID_ID" ON "note_reaction" ("noteId", "id")');
		return true;
	}

	@bindThis
	private async runOutwardForeignKeysDrop(job: Bull.Job, _deadline: number): Promise<boolean> {
		for (const table of partitionCopyTables) {
			const copies = await inspectPartitionCopies(this.dbLong, table);
			const plain = copies.partitioned ? copies.inactive : table;
			if (plain == null) continue;
			const existing: { name: string; references: string }[] = await this.dbLong.query(outwardForeignKeysSql, [
				`"${plain}"`,
				outwardForeignKeys[table].map(foreignKey => foreignKey.column),
				outwardForeignKeys[table].map(foreignKey => foreignKey.references),
			]);
			if (existing.length === 0) continue;
			try {
				await this.dbLong.transaction(async em => {
					await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
					if (existing.some(foreignKey => foreignKey.references === 'user')) await em.query('LOCK TABLE "user" IN EXCLUSIVE MODE');
					for (const { name } of existing) {
						await em.query(`ALTER TABLE "${plain}" DROP CONSTRAINT IF EXISTS "${name}"`);
					}
				});
			} catch (e) {
				const msg = `dropping the foreign keys of ${plain} failed: ${String(e)}`;
				this.logger.warn(msg);
				this.logToJob(job, msg);
				return false;
			}
		}
		return true;
	}

	@bindThis
	private async runNoteIndexes(job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runIndexSync(job, deadline, 'note', 'note_p', 'id');
	}

	@bindThis
	private async listIndexes(q: Queryable, table: string): Promise<CopyIndex[]> {
		return await q.query(indexesSql, [`"${table}"`]);
	}

	@bindThis
	private covers(other: CopyIndex, index: CopyIndex, strict: boolean): boolean {
		const columns = index.columns;
		if (!index.plain || !other.plain || columns == null || other.columns == null || other.columns.length < columns.length) return false;
		if (columns.some((column, i) => other.columns?.[i] !== column)) return false;
		if (other.columns.length > columns.length) return !index.unique;
		return strict ? other.unique && !index.unique : other.unique || !index.unique;
	}

	@bindThis
	private uniqueOnCopy(index: CopyIndex, partitioned: boolean, partitionColumn: string): boolean {
		return index.unique && (!partitioned || index.columns?.includes(partitionColumn) === true);
	}

	@bindThis
	private constraintOnCopy(index: CopyIndex, partitioned: boolean, partitionColumn: string): string | null {
		return this.uniqueOnCopy(index, partitioned, partitionColumn) ? index.constraint : null;
	}

	@bindThis
	private deferral(constraint: string): string {
		return / DEFERRABLE( INITIALLY DEFERRED)?$/.exec(constraint)?.[0] ?? '';
	}

	@bindThis
	private uncoveredIndexes(table: PartitionCopyTable, indexes: CopyIndex[], target: CopyIndex[], toPartitioned: boolean): CopyIndex[] {
		const lookups = table === 'note_reaction' ? reactionLookupIndexes : [];
		const wanted = toPartitioned ? indexes : indexes.filter(index => !lookups.some(lookup => lookup.body === index.body));
		const planned = wanted.map(index => ({ ...index, unique: this.uniqueOnCopy(index, toPartitioned, copyStates[table].partitionColumn) }));
		const fixed = [
			...target.filter(index => index.primary),
			...(toPartitioned ? lookups.map(index => ({ ...index, unique: false, primary: false, valid: true, plain: true, constraint: null })) : []),
		];
		return wanted.filter((index, i) => this.constraintOnCopy(index, toPartitioned, copyStates[table].partitionColumn) != null
			|| (!fixed.some(other => this.covers(other, planned[i], false)) && !planned.some((other, j) => j !== i && this.covers(other, planned[i], true))));
	}

	@bindThis
	private async runIndexSync(job: Bull.Job, deadline: number, table: PartitionCopyTable, shadow: string, partitionColumn: string): Promise<boolean> {
		const indexes = this.uncoveredIndexes(table, (await this.listIndexes(this.dbLong, table)).filter(index => !index.primary), await this.listIndexes(this.dbLong, shadow), true);
		return await this.syncPartitionedIndexes(job, deadline, table, shadow, partitionColumn, indexes.map(index => ({ index, name: `${index.name}_mig` })));
	}

	@bindThis
	private async syncPartitionedIndexes(job: Bull.Job, deadline: number, table: string, shadow: string, partitionColumn: string, targets: IndexTarget[]): Promise<boolean> {
		const existing: { name: string; body: string; unique: boolean; constraint: string | null }[] = await this.dbLong.query(`
			SELECT c.relname AS "name", substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') AS "body", i.indisunique AS "unique", (${uniqueConstraintSql}) AS "constraint"
			FROM pg_class c
			JOIN pg_index i ON i.indexrelid = c.oid
			WHERE c.relnamespace = 'public'::regnamespace AND c.relname = ANY($1) AND i.indrelid = $2::regclass
		`, [targets.map(({ name }) => name), `"${shadow}"`]);
		const parents = targets.map(({ index, name }) => {
			const unique = this.uniqueOnCopy(index, true, partitionColumn);
			const constraint = this.constraintOnCopy(index, true, partitionColumn);
			const found = existing.find(row => row.name === name);
			return { index, name, unique, constraint, found, stale: found != null && (found.body !== index.body || found.unique !== unique || found.constraint !== constraint) };
		});
		const stale = parents.filter(parent => parent.stale);
		if (stale.length > 0) {
			const msg = `dropping the stale ${stale.map(parent => parent.name).join(', ')} of ${shadow}`;
			this.logger.info(msg);
			this.logToJob(job, msg);
		}
		for (const parent of stale) {
			if (!await this.runLockedDdl(job, parent.found?.constraint != null ? `ALTER TABLE "${shadow}" DROP CONSTRAINT IF EXISTS "${parent.name}"` : `DROP INDEX IF EXISTS "${parent.name}"`)) return false;
		}
		const childByName = new Map<string, { name: string; valid: boolean; attached: boolean; body: string; unique: boolean; constraint: string | null }>();
		for (const parent of parents) {
			if ((parent.found == null || parent.stale) && !await this.runLockedDdl(job, parent.constraint != null
				? `ALTER TABLE ONLY "${shadow}" ADD CONSTRAINT "${parent.name}" ${parent.constraint}`
				: `CREATE ${parent.unique ? 'UNIQUE ' : ''}INDEX IF NOT EXISTS "${parent.name}" ON ONLY "${shadow}" ${parent.index.body}`)) return false;

			const children: { name: string; valid: boolean; attached: boolean; body: string; unique: boolean; constraint: string | null }[] = await this.dbLong.query(`
				SELECT c.relname AS "name", i.indisvalid AS "valid", (inh.inhparent IS NOT NULL) AS "attached",
					substring(pg_get_indexdef(i.indexrelid) FROM ' (USING .*)$') AS "body", i.indisunique AS "unique", (${uniqueConstraintSql}) AS "constraint"
				FROM pg_class c
				JOIN pg_namespace n ON n.oid = c.relnamespace AND n.nspname = 'public'
				JOIN pg_index i ON i.indexrelid = c.oid
				LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid
				WHERE c.relname LIKE $1
			`, [`${parent.name}\\_%`]);
			for (const child of children) childByName.set(child.name, child);
		}

		for (const prefix of prefixesAscending()) {
			for (const parent of parents) {
				if (Date.now() >= deadline) return false;
				const childName = `${parent.name}_${prefix}`;
				const partition = childTableName(table, prefix);
				let child = childByName.get(childName);
				if (child != null && (!child.valid || (!child.attached && (child.body !== parent.index.body || child.unique !== parent.unique || (child.constraint != null && child.constraint !== parent.constraint))))) {
					if (await this.isBeingBuilt(childName)) return false;
					if (child.constraint == null) {
						await this.dbLong.query(`DROP INDEX CONCURRENTLY IF EXISTS "${childName}"`);
					} else if (!await this.runLockedDdl(job, `ALTER TABLE "${partition}" DROP CONSTRAINT IF EXISTS "${childName}"`)) {
						return false;
					}
					child = undefined;
				}
				if (child == null) {
					await this.dbLong.query(`CREATE ${parent.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS "${childName}" ON "${partition}" ${parent.index.body}`);
				}
				const statements = [
					...(parent.constraint != null && child?.constraint == null ? [`ALTER TABLE "${partition}" ADD CONSTRAINT "${childName}" UNIQUE USING INDEX "${childName}"${this.deferral(parent.constraint)}`] : []),
					...(child == null || !child.attached ? [`ALTER INDEX "${parent.name}" ATTACH PARTITION "${childName}"`] : []),
				];
				if (statements.length > 0 && !await this.runLockedDdl(job, ...statements)) return false;
			}
		}

		const invalid: { relname: string }[] = await this.dbLong.query(`
			SELECT c.relname
			FROM pg_class c
			JOIN pg_index i ON i.indexrelid = c.oid
			WHERE c.relname = ANY($1) AND NOT i.indisvalid
		`, [parents.map(parent => parent.name)]);
		if (invalid.length > 0) {
			const msg = `invalid parent indexes remain on ${shadow}: ${invalid.map(x => x.relname).join(', ')}`;
			this.logger.error(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async addPlainIndexes(job: Bull.Job, deadline: number, standby: string, targets: IndexTarget[]): Promise<boolean> {
		for (const { index, name } of targets) {
			if (Date.now() >= deadline) return false;
			const existing: { valid: boolean; constraint: string | null }[] = await this.dbLong.query(
				`SELECT i.indisvalid AS "valid", (${uniqueConstraintSql}) AS "constraint" FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = $1 AND i.indrelid = $2::regclass`,
				[name, `"${standby}"`],
			);
			const built = existing.length > 0 && existing[0].valid;
			if (existing.length > 0 && !built && await this.isBeingBuilt(name)) return false;
			if (existing.length > 0 && !built) await this.dbLong.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
			if (!built) await this.dbLong.query(`CREATE ${index.unique ? 'UNIQUE ' : ''}INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${standby}" ${index.body}`);
			if (index.constraint != null && (!built || existing[0].constraint == null)
				&& !await this.runLockedDdl(job, `ALTER TABLE "${standby}" ADD CONSTRAINT "${name}" UNIQUE USING INDEX "${name}"${this.deferral(index.constraint)}`)) return false;
		}
		return true;
	}

	@bindThis
	private servesIndex(other: CopyIndex, { index, name, unique, constraint }: StandbyIndex, partitionColumn: string): boolean {
		const kept = this.constraintOnCopy(other, true, partitionColumn);
		return !other.primary && other.body === index.body && (other.unique || !unique) && kept === constraint && (kept == null || other.name === name);
	}

	@bindThis
	private provides(index: CopyIndex, other: CopyIndex): boolean {
		return (index.body === other.body && (index.unique || !other.unique)) || this.covers(index, other, false);
	}

	@bindThis
	private async inspectConstraints(q: Queryable, table: string, standby: string): Promise<ConstraintGaps> {
		const checks: CheckConstraint[] = await q.query(checkConstraintsSql, [`"${table}"`, `"${standby}"`]);
		const columns: NotNullColumn[] = await q.query(notNullColumnsSql, [`"${table}"`, `"${standby}"`]);
		const live = checks.filter(check => check.live);
		const target = checks.filter(check => !check.live);
		const enforced = new Set([...live.map(check => check.definition), ...columns.filter(column => column.live).map(column => column.check)]);
		return {
			checks,
			extraChecks: target.filter(check => !enforced.has(check.definition)),
			extraNotNulls: columns.filter(column => column.standby && !column.live),
			missingChecks: live.filter(check => !target.some(other => other.definition === check.definition)),
			unvalidatedChecks: target.filter(check => !check.validated && live.some(other => other.validated && other.definition === check.definition) && !target.some(other => other.validated && other.definition === check.definition)),
			missingNotNulls: columns.filter(column => column.live && !column.standby),
		};
	}

	@bindThis
	private async inspectStandby(q: Queryable, table: PartitionCopyTable, standby: string, toPartitioned: boolean): Promise<{ missing: StandbyIndex[]; stale: CopyIndex[]; extra: CopyIndex[]; leftovers: ChildIndex[]; differences: string[]; constraints: ConstraintGaps }> {
		const suffix = toPartitioned ? '_mig' : '_old';
		const partitionColumn = copyStates[table].partitionColumn;
		const live = await this.listIndexes(q, table);
		const target = await this.listIndexes(q, standby);
		const constraints = await this.inspectConstraints(q, table, standby);
		const rows: { item: string; live: boolean }[] = [
			...await q.query(standbyDifferencesSql, [`"${table}"`, `"${standby}"`, [syncTriggerName(table), ...partitionedCopyTriggers[table]]]),
			...constraints.extraChecks.map(check => ({ item: check.definition, live: false })),
			...constraints.extraNotNulls.map(column => ({ item: column.item, live: false })),
		];
		const differences = rows.sort((a, b) => a.item < b.item ? -1 : a.item > b.item ? 1 : 0).map(row => `only ${row.live ? table : standby} has ${row.item}`);
		const wanted: StandbyIndex[] = this.uncoveredIndexes(table, live.filter(index => !index.primary && index.valid), target, toPartitioned)
			.map(index => ({ index, name: `${index.name}${suffix}`, unique: this.uniqueOnCopy(index, toPartitioned, partitionColumn), constraint: this.constraintOnCopy(index, true, partitionColumn) }));
		const promotable = (other: CopyIndex, wantedIndex: StandbyIndex) => !toPartitioned && other.constraint == null && this.servesIndex({ ...other, constraint: wantedIndex.constraint }, wantedIndex, partitionColumn);
		const stale = target.filter(other => !other.primary && wanted.some(wantedIndex => other.name === wantedIndex.name && !this.servesIndex(other, wantedIndex, partitionColumn) && !promotable(other, wantedIndex)));
		const comparable = (index: CopyIndex) => ({ ...index, unique: this.uniqueOnCopy(index, true, partitionColumn) });
		const lookup = (other: CopyIndex) => table === 'note_reaction' && toPartitioned && reactionLookupIndexes.some(index => index.body === other.body);
		const named = (other: CopyIndex) => wanted.some(({ name }) => name === other.name);
		const extra = target.filter(other => !other.primary && !stale.includes(other) && !lookup(other)
			&& !((other.valid || named(other)) && live.some(index => this.provides(comparable(index), comparable(other)))
				&& (this.constraintOnCopy(other, true, partitionColumn) == null || named(other))));
		const kept = target.filter(other => !stale.includes(other) && !extra.includes(other));
		const missing = wanted.filter(wantedIndex => !kept.some(other => other.valid && this.servesIndex(other, wantedIndex, partitionColumn)));
		const children: ChildIndex[] = toPartitioned ? await q.query(unattachedChildIndexesSql, [`"${standby}"`]) : [];
		const leftovers = children.filter(child => !missing.some(({ name }) => child.name === `${name}_${child.partition.slice(childTableName(table, '').length)}`));
		return { missing, stale, extra, leftovers, differences, constraints };
	}

	@bindThis
	private async dropRejectingConstraints(job: Bull.Job, table: PartitionCopyTable, standby: string, partitioned: boolean): Promise<boolean> {
		const partitionColumn = copyStates[table].partitionColumn;
		const comparable = (index: CopyIndex) => ({ ...index, unique: this.uniqueOnCopy(index, true, partitionColumn) });
		const live = (await this.listIndexes(this.dbLong, table)).map(comparable);
		const rejects = (index: CopyIndex) => index.unique && !index.primary && !live.some(other => this.provides(other, comparable(index)));
		const unattached: ChildIndex[] = partitioned ? await this.dbLong.query(unattachedChildIndexesSql, [`"${standby}"`]) : [];
		const rejecting = (await this.listIndexes(this.dbLong, standby)).filter(rejects);
		const indexes = rejecting.filter(index => index.constraint == null).map(index => index.name);
		const uniques = rejecting.filter(index => index.constraint != null).map(index => index.name);
		const children = unattached.filter(rejects);
		const { extraChecks, extraNotNulls } = await this.inspectConstraints(this.dbLong, table, standby);
		const checks = extraChecks.map(check => check.name);
		const notNulls = extraNotNulls.filter(column => !column.key);
		const dropped = [...indexes, ...uniques, ...children.map(child => child.name), ...checks, ...notNulls.map(column => column.item)];
		if (dropped.length === 0) return true;
		if (await this.isBeingBuilt(...indexes, ...uniques, ...children.map(child => child.name))) return false;
		const msg = `${standby} rejects writes that ${table} accepts, dropping ${dropped.join(', ')}`;
		this.logger.warn(msg);
		this.logToJob(job, msg);
		try {
			const statements = [
				...(partitioned ? indexes.map(name => `DROP INDEX IF EXISTS "${name}"`) : []),
				...[...uniques, ...checks].map(name => `ALTER TABLE "${standby}" DROP CONSTRAINT IF EXISTS "${name}"`),
				...children.filter(child => child.constraint != null).map(child => `ALTER TABLE ${child.partition} DROP CONSTRAINT IF EXISTS "${child.name}"`),
				...notNulls.map(column => `ALTER TABLE "${standby}" ALTER COLUMN "${column.column}" DROP NOT NULL`),
			];
			if (statements.length > 0) await this.runLockedStatements(statements);
			for (const name of [...(partitioned ? [] : indexes), ...children.filter(child => child.constraint == null).map(child => child.name)]) {
				await this.dbLong.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
			}
		} catch (e) {
			const msg = `dropping ${dropped.join(', ')} of ${standby} failed: ${String(e)}`;
			this.logger.warn(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async dropRejectingConstraintsOfStandbys(job: Bull.Job): Promise<boolean> {
		let dropped = true;
		for (const table of partitionCopyTables) {
			const copies = await inspectPartitionCopies(this.dbLong, table);
			if (!copies.synced || copies.inactive == null) continue;
			if (!await this.dropRejectingConstraints(job, table, copies.inactive, !copies.partitioned)) dropped = false;
		}
		return dropped;
	}

	@bindThis
	private async validateConstraint(deadline: number, standby: string, name: string, partitioned: boolean): Promise<boolean> {
		if (partitioned) {
			const partitions: { partition: string }[] = await this.dbLong.query(partitionConstraintsSql, [`"${standby}"`, name]);
			for (const { partition } of partitions) {
				if (Date.now() >= deadline) return false;
				await this.runLockedStatements([`ALTER TABLE ${partition} VALIDATE CONSTRAINT "${name}"`]);
			}
		}
		await this.runLockedStatements([`ALTER TABLE "${standby}" VALIDATE CONSTRAINT "${name}"`]);
		return true;
	}

	@bindThis
	private async addLiveConstraints(job: Bull.Job, deadline: number, table: PartitionCopyTable, standby: string, toPartitioned: boolean): Promise<boolean> {
		let gaps = await this.inspectConstraints(this.dbLong, table, standby);
		const added = [...gaps.missingChecks.map(check => check.name), ...gaps.unvalidatedChecks.map(check => check.name), ...gaps.missingNotNulls.map(column => column.item)];
		if (added.length === 0) return true;
		const msg = `adding ${added.join(', ')} of ${table} to ${standby}`;
		this.logger.info(msg);
		this.logToJob(job, msg);
		try {
			for (;;) {
				const check = gaps.missingChecks.at(0);
				const unvalidated = gaps.unvalidatedChecks.at(0);
				const column = gaps.missingNotNulls.at(0);
				if (check == null && unvalidated == null && column == null) return true;
				if (Date.now() >= deadline) return false;
				if (check != null) {
					await this.runLockedStatements([`ALTER TABLE "${standby}" ADD CONSTRAINT "${check.name}" ${check.definition} NOT VALID`]);
				} else if (unvalidated != null) {
					if (!await this.validateConstraint(deadline, standby, unvalidated.name, toPartitioned)) return false;
				} else if (column != null) {
					const helpers = gaps.checks.filter(other => !other.live && other.definition === column.check);
					const helper = helpers.find(other => other.validated) ?? helpers.at(0);
					if (helper == null) {
						await this.runLockedStatements([`ALTER TABLE "${standby}" ADD CONSTRAINT "${column.column}_not_null" ${column.check} NOT VALID`]);
					} else if (!helper.validated) {
						if (!await this.validateConstraint(deadline, standby, helper.name, toPartitioned)) return false;
					} else {
						const mirrored = gaps.checks.some(other => other.live && other.definition === column.check);
						await this.runLockedStatements([
							`ALTER TABLE "${standby}" ALTER COLUMN "${column.column}" SET NOT NULL`,
							...(mirrored ? [] : helpers.map(other => `ALTER TABLE "${standby}" DROP CONSTRAINT "${other.name}"`)),
						]);
					}
				}
				gaps = await this.inspectConstraints(this.dbLong, table, standby);
			}
		} catch (e) {
			if (e instanceof QueryFailedError && e.driverError?.code === '55P03') {
				const msg = `adding ${added.join(', ')} of ${table} to ${standby} failed: ${String(e)}`;
				this.logger.warn(msg);
				this.logToJob(job, msg);
			} else {
				await this.deferSwitch(job, table, toPartitioned, e);
			}
			return false;
		}
	}

	@bindThis
	private async alignStandby(job: Bull.Job, deadline: number, table: PartitionCopyTable, standby: string, toPartitioned: boolean): Promise<boolean> {
		const { missing, stale, extra, leftovers, differences } = await this.inspectStandby(this.dbLong, table, standby, toPartitioned);
		if (differences.length > 0) {
			const msg = `cannot switch ${table}: ${differences.join(', ')}`;
			this.logger.error(msg);
			this.logToJob(job, msg);
			return false;
		}
		if (stale.length > 0) {
			const msg = `dropping the stale ${stale.map(index => index.name).join(', ')} of ${standby}`;
			this.logger.info(msg);
			this.logToJob(job, msg);
		}
		if (extra.length > 0 || leftovers.length > 0) {
			const msg = `dropping ${[...extra, ...leftovers].map(index => index.name).join(', ')} of ${standby}, which ${table} does not have`;
			this.logger.info(msg);
			this.logToJob(job, msg);
		}
		if (await this.isBeingBuilt(...[...stale, ...extra, ...leftovers].map(index => index.name))) return false;
		for (const index of [...stale, ...extra]) {
			if (Date.now() >= deadline) return false;
			if (index.constraint == null && !toPartitioned) {
				await this.dbLong.query(`DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`);
			} else if (!await this.runLockedDdl(job, index.constraint != null ? `ALTER TABLE "${standby}" DROP CONSTRAINT IF EXISTS "${index.name}"` : `DROP INDEX IF EXISTS "${index.name}"`)) {
				return false;
			}
		}
		for (const child of leftovers) {
			if (Date.now() >= deadline) return false;
			if (child.constraint == null) {
				await this.dbLong.query(`DROP INDEX CONCURRENTLY IF EXISTS "${child.name}"`);
			} else if (!await this.runLockedDdl(job, `ALTER TABLE ${child.partition} DROP CONSTRAINT IF EXISTS "${child.name}"`)) {
				return false;
			}
		}
		if (!await this.addLiveConstraints(job, deadline, table, standby, toPartitioned)) return false;
		if (missing.length === 0) return true;
		const msg = `adding ${missing.map(({ index }) => index.name).join(', ')} of ${table} to ${standby}`;
		this.logger.info(msg);
		this.logToJob(job, msg);
		return toPartitioned
			? await this.syncPartitionedIndexes(job, deadline, table, standby, copyStates[table].partitionColumn, missing)
			: await this.addPlainIndexes(job, deadline, standby, missing);
	}

	@bindThis
	private async assertStandbyAligned(em: EntityManager, table: PartitionCopyTable, standby: string, toPartitioned: boolean): Promise<void> {
		const { missing, stale, extra, leftovers, differences, constraints } = await this.inspectStandby(em, table, standby, toPartitioned);
		const lacking = [...missing.map(({ index }) => index.name), ...constraints.missingChecks.map(check => check.name), ...constraints.missingNotNulls.map(column => column.item)];
		if (lacking.length > 0 || constraints.unvalidatedChecks.length > 0 || stale.length > 0 || extra.length > 0 || leftovers.length > 0 || differences.length > 0) {
			throw new Error(`${standby} is not aligned with ${table}: ${[...lacking.map(name => `${standby} lacks ${name}`), ...constraints.unvalidatedChecks.map(check => `${standby} has not validated ${check.name}`), ...stale.map(index => `${standby} has the stale ${index.name}`), ...[...extra, ...leftovers].map(index => `${standby} has ${index.name}, which ${table} does not have`), ...differences].join(', ')}`);
		}
	}

	@bindThis
	private async assertParentOrder(em: EntityManager, tables: string[]): Promise<void> {
		const lacking = await this.lacksParentOrder(em, tables);
		if (lacking.length > 0) {
			throw new Error(`the parent order triggers are missing on ${lacking.join(', ')}`);
		}
	}

	@bindThis
	private async runParity(job: Bull.Job, name: string, deadline: number, plain: string, column: string, table: PartitionCopyTable): Promise<boolean> {
		const state = await this.loadState(name);
		let ord = state.ord != null && state.ord < PARTITION_COUNT ? state.ord : 0;
		while (ord < PARTITION_COUNT) {
			if (Date.now() >= deadline) {
				state.ord = ord;
				await this.saveState(name, state);
				return false;
			}
			const prefix = ordinalToPrefix(ord);
			const upper = nextPrefix(prefix);
			const child = childTableName(table, prefix);
			const [row]: { expected: string; actual: string }[] = upper == null
				? await this.dbLong.query(`SELECT (SELECT count(*) FROM "${plain}" WHERE "${column}" >= $1) AS "expected", (SELECT count(*) FROM "${child}") AS "actual"`, [prefix])
				: await this.dbLong.query(`SELECT (SELECT count(*) FROM "${plain}" WHERE "${column}" >= $1 AND "${column}" < $2) AS "expected", (SELECT count(*) FROM "${child}") AS "actual"`, [prefix, upper]);
			if (row.expected !== row.actual) {
				const msg = `parity mismatch at ${child}: ${plain}=${row.expected} ${child}=${row.actual}`;
				this.logger.error(msg);
				this.logToJob(job, msg);
				state.ord = ord;
				await this.saveState(name, state);
				return false;
			}
			ord++;
		}
		await this.saveState(name, {});
		return true;
	}

	@bindThis
	private async switchCopies(job: Bull.Job, deadline: number, table: PartitionCopyTable): Promise<boolean> {
		const states = copyStates[table];
		const state = await this.loadState(states.switch);
		if (state.nextAttemptAt != null && Date.now() < state.nextAttemptAt) return false;

		const copies = await inspectPartitionCopies(this.dbLong, table);
		const toPartitioned = !copies.partitioned;
		if (table === 'note_reaction' && toPartitioned && !(await inspectPartitionCopies(this.dbLong, 'note')).partitioned) {
			this.logToJob(job, 'note_reaction is switched to the partitioned copy after note');
			return false;
		}
		if (table === 'note' && !toPartitioned && (await inspectPartitionCopies(this.dbLong, 'note_reaction')).partitioned) {
			this.logToJob(job, 'note is switched to the plain copy after note_reaction');
			return false;
		}
		const prerequisites = table === 'note' ? noteSwitchPrerequisites : toPartitioned ? reactionCutoverPrerequisites : [];
		for (const name of prerequisites) {
			if (!await this.isFinished(name)) {
				this.logToJob(job, `${table} is switched to the ${toPartitioned ? 'partitioned' : 'plain'} copy after ${name}`);
				return false;
			}
		}
		const retired = copies.partitioned ? partitionedCopyName(table) : plainCopyName(table);
		const standby = copies.inactive;
		if (standby == null || !copies.synced) {
			const msg = `cannot switch ${table}: ${standby ?? retired} is ${standby == null ? 'missing' : 'not synchronized'}`;
			this.logger.error(msg);
			this.logToJob(job, msg);
			return false;
		}
		if (!await this.copiesMatch(job, table, standby)) return false;
		if (table === 'note' && !await this.ensureParentOrder(job, [table, standby])) return false;
		if (!await this.alignStandby(job, deadline, table, standby, toPartitioned)) return false;
		if (!await this.runParity(job, states.parity, deadline, copies.partitioned ? standby : table, states.partitionColumn, table)) return false;

		const addedSuffix = copies.partitioned ? '_mig' : '_old';
		const strippedSuffix = copies.partitioned ? '_old' : '_mig';
		const pending = states.pendingForeignKeys;
		try {
			await this.db.transaction(async em => {
				await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
				await em.query(`LOCK TABLE "${table}", "${standby}" IN ACCESS EXCLUSIVE MODE`);
				await this.assertCopiesMatch(em, table, standby);
				await this.assertStandbyAligned(em, table, standby, toPartitioned);
				if (table === 'note') await this.assertParentOrder(em, [table, standby]);
				await em.query(`
					DO $$
					DECLARE
						r record;
						pk text;
					BEGIN
						${pending != null ? `CREATE TABLE IF NOT EXISTS "${pending}" ("tbl" text, "name" text, "def" text);` : ''}

						FOR r IN SELECT conname, conrelid::regclass::text AS tbl, pg_get_constraintdef(oid) AS def
							FROM pg_constraint WHERE confrelid = '${table}'::regclass AND contype = 'f'
						LOOP
							${pending != null ? `INSERT INTO "${pending}" VALUES (r.tbl, r.conname, r.def);` : ''}
							EXECUTE format('ALTER TABLE %s DROP CONSTRAINT %I', r.tbl, r.conname);
						END LOOP;

						SELECT conname INTO pk FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'p';

						EXECUTE 'DROP TRIGGER IF EXISTS "${syncTriggerName(table)}" ON "${table}"';
						EXECUTE 'DROP FUNCTION IF EXISTS ${syncFunctionName(table, copies.partitioned)}()';

						EXECUTE 'ALTER TABLE "${table}" RENAME TO "${retired}"';
						EXECUTE 'ALTER TABLE "${standby}" RENAME TO "${table}"';

						FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${retired}' LOOP
							EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, r.indexname || '${addedSuffix}');
						END LOOP;

						FOR r IN SELECT indexname FROM pg_indexes WHERE schemaname = 'public' AND tablename = '${table}' AND indexname LIKE '%\\${strippedSuffix}' LOOP
							EXECUTE format('ALTER INDEX %I RENAME TO %I', r.indexname, left(r.indexname, -${strippedSuffix.length}));
						END LOOP;

						FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = '${table}'::regclass AND contype = 'p' AND conname <> pk LOOP
							EXECUTE format('ALTER TABLE "${table}" RENAME CONSTRAINT %I TO %I', r.conname, pk);
						END LOOP;
					END $$
				`);
				await em.query(buildSyncFunctionSql(table, retired, syncFunctionName(table, toPartitioned), partitionCopyKeyColumns[table]));
				await em.query(`CREATE TRIGGER "${syncTriggerName(table)}" AFTER INSERT OR UPDATE OR DELETE ON "${table}" FOR EACH ROW EXECUTE FUNCTION ${syncFunctionName(table, toPartitioned)}()`);
				await em.query('UPDATE "partition_migration_state" SET "state" = \'{}\' WHERE "name" = ANY($1)', [[states.parity, states.switch]]);
			});
		} catch (e) {
			await this.deferSwitch(job, table, toPartitioned, e);
			return false;
		}
		const msg = `${table} switched to the ${toPartitioned ? 'partitioned' : 'plain'} copy`;
		this.logger.succ(msg);
		this.logToJob(job, msg);
		return true;
	}

	@bindThis
	private async deferSwitch(job: Bull.Job, table: PartitionCopyTable, toPartitioned: boolean, e: unknown): Promise<void> {
		const name = copyStates[table].switch;
		const state = await this.loadState(name);
		state.attempts = (state.attempts ?? 0) + 1;
		state.nextAttemptAt = Date.now() + Math.min(maxCutoverRetryDelayMs, 1000 * 60 * 5 * 2 ** state.attempts);
		state.lastError = String(e);
		await this.saveState(name, state);
		const msg = `switching ${table} to the ${toPartitioned ? 'partitioned' : 'plain'} copy: attempt ${state.attempts} failed: ${String(e)}`;
		this.logger.warn(msg);
		this.logToJob(job, msg);
	}

	@bindThis
	private async dropInactiveCopy(job: Bull.Job, table: PartitionCopyTable, copies: PartitionCopies): Promise<boolean> {
		const standby = copies.inactive;
		if (standby == null) return true;
		const states = copyStates[table];
		const state = await this.loadState(states.drop);
		if (state.nextAttemptAt != null && Date.now() < state.nextAttemptAt) return false;
		if (!await this.copiesMatch(job, table, standby)) return false;

		try {
			if (copies.synced) {
				await this.db.transaction(async em => {
					await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
					await em.query(`LOCK TABLE "${table}" IN ACCESS EXCLUSIVE MODE`);
					await this.assertCopiesMatch(em, table, standby);
					await em.query(`DROP TRIGGER IF EXISTS "${syncTriggerName(table)}" ON "${table}"`);
					await em.query(`DROP FUNCTION IF EXISTS ${syncFunctionName(table, copies.partitioned)}()`);
				});
			}
			await this.dbLong.transaction(async em => {
				await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
				await em.query(`DROP TABLE "${standby}"`);
				if (table === 'note_reaction' && !copies.partitioned) await em.query('TRUNCATE "note_reaction_locator"');
				await em.query('UPDATE "partition_migration_state" SET "state" = \'{}\' WHERE "name" = $1', [states.drop]);
			});
		} catch (e) {
			state.attempts = (state.attempts ?? 0) + 1;
			state.nextAttemptAt = Date.now() + Math.min(maxCutoverRetryDelayMs, 1000 * 60 * 5 * 2 ** state.attempts);
			state.lastError = String(e);
			await this.saveState(states.drop, state);
			const msg = `dropping ${standby}: attempt ${state.attempts} failed: ${String(e)}`;
			this.logger.warn(msg);
			this.logToJob(job, msg);
			return false;
		}
		const msg = `${standby} dropped`;
		this.logger.succ(msg);
		this.logToJob(job, msg);
		return true;
	}

	@bindThis
	private async settle(table: PartitionCopyTable): Promise<void> {
		for (const name of [copyStates[table].parity, copyStates[table].switch]) {
			if (Object.keys(await this.loadState(name)).length > 0) await this.saveState(name, {});
		}
	}

	@bindThis
	private async converge(job: Bull.Job, deadline: number): Promise<void> {
		const partitioned = this.config.partitionMigration.liveTable === 'partitioned';
		const tables: PartitionCopyTable[] = partitioned ? ['note', 'note_reaction'] : ['note_reaction', 'note'];
		for (const table of tables) {
			if (!await this.isFinished(copyStates[table].built) || !await this.isFinished(outwardForeignKeysPhase)) continue;
			const copies = await inspectPartitionCopies(this.dbLong, table);
			if (copies.inactive != null && !await this.copiesMatch(job, table, copies.inactive)) continue;
			if (copies.partitioned !== partitioned) {
				await this.switchCopies(job, deadline, table);
				continue;
			}
			await this.settle(table);
			if (this.config.partitionMigration.dropOldTables) await this.dropInactiveCopy(job, table, copies);
		}
		if (await this.isFinished(copyStates.note_reaction.built)) {
			await this.runForeignKeyRestore(deadline, 'note_reaction_swap_pending_fk');
		}
	}

	@bindThis
	private async runCutover(job: Bull.Job, deadline: number, table: PartitionCopyTable): Promise<boolean> {
		if ((await inspectPartitionCopies(this.dbLong, table)).partitioned) return true;
		if (this.config.partitionMigration.liveTable !== 'partitioned') {
			this.logToJob(job, `${table} stays on the plain copy while partitionMigration.liveTable is ${this.config.partitionMigration.liveTable}`);
			return false;
		}
		return await this.switchCopies(job, deadline, table);
	}

	@bindThis
	private async runNoteCutover(job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runCutover(job, deadline, 'note');
	}

	@bindThis
	private async runForeignKeyRestore(deadline: number, pendingTable: string): Promise<boolean> {
		const [{ pending }]: { pending: string | null }[] = await this.dbLong.query('SELECT to_regclass($1)::text AS "pending"', [pendingTable]);
		if (pending == null) return true;
		for (;;) {
			const rows: { tbl: string; name: string; def: string }[] = await this.dbLong.query(`SELECT "tbl", "name", "def" FROM "${pendingTable}" LIMIT 10`);
			if (rows.length === 0) {
				await this.dbLong.query(`DROP TABLE "${pendingTable}"`);
				return true;
			}
			for (const row of rows) {
				if (Date.now() >= deadline) return false;
				const exists: unknown[] = await this.dbLong.query('SELECT 1 FROM pg_constraint WHERE conname = $1 AND conrelid = $2::regclass', [row.name, row.tbl]);
				if (exists.length === 0) {
					await this.dbLong.query(`ALTER TABLE ${row.tbl} ADD CONSTRAINT "${row.name}" ${row.def} NOT VALID`);
				}
				await this.dbLong.query(`DELETE FROM "${pendingTable}" WHERE "tbl" = $1 AND "name" = $2`, [row.tbl, row.name]);
			}
		}
	}

	@bindThis
	private async runNoteAnalyze(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runAnalyze('noteAnalyze', deadline, 'note');
	}

	@bindThis
	private async runAnalyze(name: string, deadline: number, table: PartitionCopyTable): Promise<boolean> {
		const [{ partitions }]: { partitions: boolean }[] = await this.dbLong.query('SELECT to_regclass($1) IS NOT NULL AS "partitions"', [childTableName(table, ordinalToPrefix(0))]);
		if (!partitions) return true;
		const state = await this.loadState(name);
		let ord = state.ord ?? 0;
		while (ord < PARTITION_COUNT) {
			if (Date.now() >= deadline) {
				state.ord = ord;
				await this.saveState(name, state);
				return false;
			}
			await this.dbLong.query(`ANALYZE "${childTableName(table, ordinalToPrefix(ord))}"`);
			ord++;
		}
		state.ord = ord;
		await this.saveState(name, state);
		if (Date.now() >= deadline) return false;
		await analyzePartitionedParent(this.dbLong, table);
		return true;
	}

	@bindThis
	private async runReactionPrepare(job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runPrepare(job, deadline, 'note_reaction');
	}

	@bindThis
	private async runReactionBackfill(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runBackfill('reactionBackfill', deadline, `
			WITH batch AS (
				SELECT * FROM "note_reaction"
				WHERE "id" > $1 AND "id" <= $2
				ORDER BY "id"
				LIMIT $3
				FOR SHARE
			), ins AS (
				INSERT INTO "note_reaction_p"
				SELECT * FROM batch
				ON CONFLICT ("noteId", "id") DO NOTHING
			)
			SELECT max("id") AS "maxId" FROM batch
		`, 'note_reaction');
	}

	@bindThis
	private async runReactionIndexes(job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runIndexSync(job, deadline, 'note_reaction', 'note_reaction_p', 'noteId');
	}

	@bindThis
	private async runReactionLocatorFill(_job: Bull.Job, deadline: number): Promise<boolean> {
		const name = 'reactionLocatorFill';
		const copies = await inspectPartitionCopies(this.dbLong, 'note_reaction');
		if (!copies.partitioned && copies.inactive == null) return true;
		const state = await this.loadState(name);
		let ord = state.ord ?? 0;
		while (ord < PARTITION_COUNT) {
			if (Date.now() >= deadline) {
				state.ord = ord;
				await this.saveState(name, state);
				return false;
			}
			await this.dbLong.query(`
				INSERT INTO "note_reaction_locator" ("id", "noteId", "userId")
				SELECT "id", "noteId", "userId" FROM "${childTableName('note_reaction', ordinalToPrefix(ord))}"
				WHERE left("id", 2) <> left("noteId", 2)
				ON CONFLICT DO NOTHING
			`);
			ord++;
		}
		state.ord = ord;
		await this.saveState(name, state);
		return true;
	}

	@bindThis
	private async runLockedStatements(statements: string[]): Promise<void> {
		await this.dbLong.transaction(async em => {
			await em.query(`SET LOCAL lock_timeout = '${lockTimeoutMs}'`);
			for (const sql of statements) await em.query(sql);
		});
	}

	@bindThis
	private async runLockedDdl(job: Bull.Job, ...statements: string[]): Promise<boolean> {
		try {
			await this.runLockedStatements(statements);
		} catch (e) {
			const msg = `${statements.join('; ')} failed: ${String(e)}`;
			this.logger.warn(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async runReactionLookupIndexes(job: Bull.Job, deadline: number): Promise<boolean> {
		const copies = await inspectPartitionCopies(this.dbLong, 'note_reaction');
		const target = copies.partitioned ? 'note_reaction' : copies.inactive;
		if (target == null) return true;
		const indexes = reactionLookupIndexes.map(index => ({ ...index, parent: copies.partitioned ? index.name : `${index.name}_mig` }));
		const existing: { name: string }[] = await this.dbLong.query(
			'SELECT relname AS "name" FROM pg_class WHERE relnamespace = \'public\'::regnamespace AND relname = ANY($1)',
			[indexes.map(index => index.parent)],
		);
		const existingNames = new Set(existing.map(row => row.name));
		const children = new Map<string, { valid: boolean; attached: boolean }>();
		for (const index of indexes) {
			if (!existingNames.has(index.parent) && !await this.runLockedDdl(job, `CREATE INDEX IF NOT EXISTS "${index.parent}" ON ONLY "${target}" ${index.body}`)) return false;
			const rows: { name: string; valid: boolean; attached: boolean }[] = await this.dbLong.query(`
				SELECT c.relname AS "name", i.indisvalid AS "valid", (inh.inhparent IS NOT NULL) AS "attached"
				FROM pg_class c
				JOIN pg_index i ON i.indexrelid = c.oid
				LEFT JOIN pg_inherits inh ON inh.inhrelid = c.oid
				WHERE c.relnamespace = 'public'::regnamespace AND c.relname LIKE $1
			`, [`${index.name}\\_mig\\_%`]);
			for (const row of rows) children.set(row.name, row);
		}

		for (const prefix of prefixesAscending()) {
			for (const index of indexes) {
				if (Date.now() >= deadline) return false;
				const name = `${index.name}_mig_${prefix}`;
				let child = children.get(name);
				if (child != null && !child.valid) {
					if (await this.isBeingBuilt(name)) return false;
					await this.dbLong.query(`DROP INDEX CONCURRENTLY IF EXISTS "${name}"`);
					child = undefined;
				}
				if (child == null) {
					await this.dbLong.query(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ON "${childTableName('note_reaction', prefix)}" ${index.body}`);
				}
				if ((child == null || !child.attached) && !await this.runLockedDdl(job, `ALTER INDEX "${index.parent}" ATTACH PARTITION "${name}"`)) return false;
			}
		}

		const invalid: { relname: string }[] = await this.dbLong.query(
			'SELECT c.relname FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid WHERE c.relnamespace = \'public\'::regnamespace AND c.relname = ANY($1) AND NOT i.indisvalid',
			[indexes.map(index => index.parent)],
		);
		if (invalid.length > 0) {
			const msg = `invalid parent indexes remain on ${target}: ${invalid.map(x => x.relname).join(', ')}`;
			this.logger.error(msg);
			this.logToJob(job, msg);
			return false;
		}
		return true;
	}

	@bindThis
	private async runReactionCutover(job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runCutover(job, deadline, 'note_reaction');
	}

	@bindThis
	private async runReactionForeignKeys(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runForeignKeyRestore(deadline, 'note_reaction_swap_pending_fk');
	}

	@bindThis
	private async runReactionAnalyze(_job: Bull.Job, deadline: number): Promise<boolean> {
		return await this.runAnalyze('reactionAnalyze', deadline, 'note_reaction');
	}

	@bindThis
	public async process(job: Bull.Job): Promise<void> {
		const lockRunner = this.db.createQueryRunner();
		await lockRunner.connect();
		try {
			const [{ locked }]: { locked: boolean }[] = await lockRunner.query('SELECT pg_try_advisory_lock($1) AS "locked"', [advisoryLockKey]);
			if (!locked) {
				this.logToJob(job, 'another run is in progress');
				return;
			}
			try {
				await this.runPhases(job);
			} finally {
				await lockRunner.query('SELECT pg_advisory_unlock($1)', [advisoryLockKey]);
			}
		} finally {
			await lockRunner.release();
		}
	}

	@bindThis
	private async runPhases(job: Bull.Job): Promise<void> {
		const deadline = Date.now() + maxDuration;
		if (!await this.dropRejectingConstraintsOfStandbys(job)) return;
		await this.converge(job, deadline);
		const phases: Phase[] = [
			{ name: 'reactionNoteIdIdIndex', run: this.runReactionNoteIdIdIndex },
			{ name: 'noteUriBackfill', run: this.runNoteUriBackfill },
			{ name: 'noteInvertedRelationUnlink', run: this.runNoteInvertedRelationUnlink },
			{ name: 'noteParentOrderPlain', run: this.runNoteParentOrderPlain },
			{ name: 'noteRelationBackfill', run: this.runNoteRelationBackfill },
			{ name: 'notePendingParentBackfill', run: this.runNotePendingParentBackfill },
			{ name: 'userNoteIdFloorIndex', run: this.runUserNoteIdFloorIndex },
			{ name: 'userNoteIdFloorBackfill', run: this.runUserNoteIdFloorBackfill },
			{ name: 'notePrepare', run: this.runNotePrepare },
			{ name: 'noteBackfill', run: this.runNoteBackfill },
			{ name: 'noteParentOrderPartitioned', run: this.runNoteParentOrderPartitioned },
			{ name: outwardForeignKeysPhase, run: this.runOutwardForeignKeysDrop },
			{ name: 'noteIndexes', run: this.runNoteIndexes },
			{ name: 'noteCutover', run: this.runNoteCutover },
			{ name: 'noteAnalyze', run: this.runNoteAnalyze },
			{ name: 'reactionPrepare', run: this.runReactionPrepare },
			{ name: 'reactionBackfill', run: this.runReactionBackfill },
			{ name: 'reactionIndexes', run: this.runReactionIndexes },
			{ name: 'reactionLocatorFill', run: this.runReactionLocatorFill },
			{ name: 'reactionLookupIndexes', run: this.runReactionLookupIndexes },
			{ name: 'noteReactionCutover', run: this.runReactionCutover },
			{ name: 'reactionForeignKeys', run: this.runReactionForeignKeys },
			{ name: 'reactionAnalyze', run: this.runReactionAnalyze },
		];
		for (const phase of phases) {
			if (await this.isFinished(phase.name)) continue;
			this.logger.info(`running phase ${phase.name}...`);
			const finished = await phase.run(job, deadline);
			if (!finished) {
				this.logToJob(job, `suspended at ${phase.name}`);
				return;
			}
			await this.finish(phase.name);
			this.logger.succ(`phase ${phase.name} finished`);
			this.logToJob(job, `phase ${phase.name} finished`);
		}
	}
}
