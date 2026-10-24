/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class UserDriveUsageCounter1792429514511 {
	name = 'UserDriveUsageCounter1792429514511'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE "user_drive_usage" ("userId" character varying(32) NOT NULL, "usage" bigint NOT NULL DEFAULT 0, CONSTRAINT "PK_c544a8dcee260fb34402704c2c6" PRIMARY KEY ("userId"))`);

		await queryRunner.query(`
			CREATE FUNCTION "drive_file_sync_usage"() RETURNS trigger AS $$
			BEGIN
				IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."userId" IS NOT NULL AND OLD."isLink" = FALSE THEN
					UPDATE "user_drive_usage" SET "usage" = "usage" - OLD."size" WHERE "userId" = OLD."userId";
				END IF;
				IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."userId" IS NOT NULL AND NEW."isLink" = FALSE THEN
					INSERT INTO "user_drive_usage" ("userId", "usage") VALUES (NEW."userId", NEW."size")
						ON CONFLICT ("userId") DO UPDATE SET "usage" = "user_drive_usage"."usage" + NEW."size";
				END IF;
				RETURN NULL;
			END; $$ LANGUAGE plpgsql
		`);

		await queryRunner.query(`CREATE TRIGGER "drive_file_usage_sync" AFTER INSERT OR UPDATE OR DELETE ON "drive_file" FOR EACH ROW EXECUTE FUNCTION "drive_file_sync_usage"()`);

		await queryRunner.query(`
			INSERT INTO "user_drive_usage" ("userId", "usage")
			SELECT "userId", SUM("size") FROM "drive_file" WHERE "userId" IS NOT NULL AND "isLink" = FALSE GROUP BY "userId"
			ON CONFLICT ("userId") DO UPDATE SET "usage" = EXCLUDED."usage"
		`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "drive_file_usage_sync" ON "drive_file"`);
		await queryRunner.query(`DROP FUNCTION "drive_file_sync_usage"()`);
		await queryRunner.query(`DROP TABLE "user_drive_usage"`);
	}
}
