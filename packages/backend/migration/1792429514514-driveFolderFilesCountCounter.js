/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class DriveFolderFilesCountCounter1792429514514 {
	name = 'DriveFolderFilesCountCounter1792429514514'

	async up(queryRunner) {
		await queryRunner.query(`ALTER TABLE "drive_folder" ADD "filesCount" integer NOT NULL DEFAULT 0`);

		await queryRunner.query(`
			CREATE FUNCTION "drive_file_sync_folder_files_count"() RETURNS trigger AS $$
			BEGIN
				IF TG_OP = 'UPDATE' AND NEW."folderId" IS NOT DISTINCT FROM OLD."folderId" THEN
					RETURN NULL;
				END IF;
				IF TG_OP = 'UPDATE' AND NEW."folderId" < OLD."folderId" THEN
					UPDATE "drive_folder" SET "filesCount" = "filesCount" + 1 WHERE "id" = NEW."folderId";
					UPDATE "drive_folder" SET "filesCount" = "filesCount" - 1 WHERE "id" = OLD."folderId";
					RETURN NULL;
				END IF;
				IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."folderId" IS NOT NULL THEN
					UPDATE "drive_folder" SET "filesCount" = "filesCount" - 1 WHERE "id" = OLD."folderId";
				END IF;
				IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."folderId" IS NOT NULL THEN
					UPDATE "drive_folder" SET "filesCount" = "filesCount" + 1 WHERE "id" = NEW."folderId";
				END IF;
				RETURN NULL;
			END; $$ LANGUAGE plpgsql
		`);

		await queryRunner.query(`CREATE TRIGGER "drive_file_folder_files_count_sync" AFTER INSERT OR UPDATE OR DELETE ON "drive_file" FOR EACH ROW EXECUTE FUNCTION "drive_file_sync_folder_files_count"()`);

		await queryRunner.query(`
			UPDATE "drive_folder" AS f SET "filesCount" = c.count
			FROM (SELECT "folderId", COUNT(*) AS count FROM "drive_file" WHERE "folderId" IS NOT NULL GROUP BY "folderId") AS c
			WHERE f."id" = c."folderId"
		`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DROP TRIGGER "drive_file_folder_files_count_sync" ON "drive_file"`);
		await queryRunner.query(`DROP FUNCTION "drive_file_sync_folder_files_count"()`);
		await queryRunner.query(`ALTER TABLE "drive_folder" DROP COLUMN "filesCount"`);
	}
}
