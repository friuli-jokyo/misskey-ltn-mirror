/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DriveFileMd5Lookup1792429514515 {
	name = 'DriveFileMd5Lookup1792429514515'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "drive_file_md5" ("fileId" character varying(32) NOT NULL, "userId" character varying(32), "md5" character varying(32) NOT NULL, CONSTRAINT "PK_c93f57922b2b80127fc1292d467" PRIMARY KEY ("fileId"))`);
		await queryRunner.query(`CREATE INDEX "IDX_b6d0e3bf977997a9911b0a5311" ON "drive_file_md5" ("userId", "md5")`);

		await queryRunner.query(`
			CREATE FUNCTION "drive_file_sync_md5"() RETURNS trigger AS $$
			BEGIN
				IF TG_OP = 'DELETE' THEN
					DELETE FROM "drive_file_md5" WHERE "fileId" = OLD."id";
				ELSE
					INSERT INTO "drive_file_md5" ("fileId", "userId", "md5") VALUES (NEW."id", NEW."userId", NEW."md5")
						ON CONFLICT ("fileId") DO UPDATE SET "userId" = NEW."userId", "md5" = NEW."md5";
				END IF;
				RETURN NULL;
			END; $$ LANGUAGE plpgsql
		`);

		await queryRunner.query(`CREATE TRIGGER "drive_file_md5_sync" AFTER INSERT OR UPDATE OR DELETE ON "drive_file" FOR EACH ROW EXECUTE FUNCTION "drive_file_sync_md5"()`);

		await queryRunner.query(`
			INSERT INTO "drive_file_md5" ("fileId", "userId", "md5")
			SELECT "id", "userId", "md5" FROM "drive_file"
			ON CONFLICT ("fileId") DO NOTHING
		`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "drive_file_md5_sync" ON "drive_file"`);
		await queryRunner.query(`DROP FUNCTION "drive_file_sync_md5"()`);
		await queryRunner.query(`DROP TABLE "drive_file_md5"`);
	}
}
