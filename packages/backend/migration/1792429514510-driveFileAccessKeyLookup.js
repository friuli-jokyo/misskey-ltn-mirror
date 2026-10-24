/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DriveFileAccessKeyLookup1792429514510 {
	name = 'DriveFileAccessKeyLookup1792429514510'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "drive_file_access_key" ("accessKey" character varying(256) NOT NULL, "fileId" character varying(32) NOT NULL, "kind" smallint NOT NULL, CONSTRAINT "PK_c64f71c1fd47535098f2a2f8cf8" PRIMARY KEY ("accessKey"))`);
		await queryRunner.query(`CREATE INDEX "IDX_78a7dc77823e2476886c96be05" ON "drive_file_access_key" ("fileId")`);

		await queryRunner.query(`
			CREATE FUNCTION "drive_file_sync_access_keys"() RETURNS trigger AS $$
			BEGIN
				IF TG_OP IN ('UPDATE', 'DELETE') THEN
					DELETE FROM "drive_file_access_key" WHERE "fileId" = OLD."id";
				END IF;
				IF TG_OP IN ('INSERT', 'UPDATE') THEN
					IF NEW."accessKey" IS NOT NULL THEN
						INSERT INTO "drive_file_access_key" VALUES (NEW."accessKey", NEW."id", 0)
							ON CONFLICT ("accessKey") DO UPDATE SET "fileId" = NEW."id", "kind" = 0;
					END IF;
					IF NEW."thumbnailAccessKey" IS NOT NULL THEN
						INSERT INTO "drive_file_access_key" VALUES (NEW."thumbnailAccessKey", NEW."id", 1)
							ON CONFLICT ("accessKey") DO UPDATE SET "fileId" = NEW."id", "kind" = 1;
					END IF;
					IF NEW."webpublicAccessKey" IS NOT NULL THEN
						INSERT INTO "drive_file_access_key" VALUES (NEW."webpublicAccessKey", NEW."id", 2)
							ON CONFLICT ("accessKey") DO UPDATE SET "fileId" = NEW."id", "kind" = 2;
					END IF;
				END IF;
				RETURN NULL;
			END; $$ LANGUAGE plpgsql
		`);

		await queryRunner.query(`CREATE TRIGGER "drive_file_access_key_sync" AFTER INSERT OR UPDATE OR DELETE ON "drive_file" FOR EACH ROW EXECUTE FUNCTION "drive_file_sync_access_keys"()`);

		await queryRunner.query(`
			INSERT INTO "drive_file_access_key" ("accessKey", "fileId", "kind")
			SELECT "accessKey", "id", 0 FROM "drive_file" WHERE "accessKey" IS NOT NULL
			UNION ALL
			SELECT "thumbnailAccessKey", "id", 1 FROM "drive_file" WHERE "thumbnailAccessKey" IS NOT NULL
			UNION ALL
			SELECT "webpublicAccessKey", "id", 2 FROM "drive_file" WHERE "webpublicAccessKey" IS NOT NULL
			ON CONFLICT ("accessKey") DO NOTHING
		`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "drive_file_access_key_sync" ON "drive_file"`);
		await queryRunner.query(`DROP FUNCTION "drive_file_sync_access_keys"()`);
		await queryRunner.query(`DROP TABLE "drive_file_access_key"`);
	}
}
