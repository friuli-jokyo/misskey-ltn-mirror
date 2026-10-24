/*
 * SPDX-FileCopyrightText: syuilo and misskey-project
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class NoteReactionLocator1792429514524 {
	name = 'NoteReactionLocator1792429514524'

	async up(queryRunner) {
		await queryRunner.query(`CREATE TABLE IF NOT EXISTS "note_reaction_locator" ("id" character varying(32) NOT NULL, "noteId" character varying(32) NOT NULL, "userId" character varying(32) NOT NULL, CONSTRAINT "PK_9efc942b1b596b8dc39d5f2fad6" PRIMARY KEY ("id"))`);
		await queryRunner.query(`CREATE INDEX IF NOT EXISTS "IDX_bef634b9dbc2a6a86fc91e7731" ON "note_reaction_locator" ("userId", "id")`);
		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION note_reaction_locator_insert() RETURNS trigger AS $$
			BEGIN
				IF left(NEW."id", 2) <> left(NEW."noteId", 2) THEN
					INSERT INTO "note_reaction_locator" ("id", "noteId", "userId") VALUES (NEW."id", NEW."noteId", NEW."userId") ON CONFLICT DO NOTHING;
				END IF;
				RETURN NULL;
			END;
			$$ LANGUAGE plpgsql
		`);
		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION note_reaction_locator_delete() RETURNS trigger AS $$
			BEGIN
				IF left(OLD."id", 2) <> left(OLD."noteId", 2) THEN
					DELETE FROM "note_reaction_locator" WHERE "id" = OLD."id" AND "noteId" = OLD."noteId";
				END IF;
				RETURN NULL;
			END;
			$$ LANGUAGE plpgsql
		`);
		await queryRunner.query(`
			CREATE OR REPLACE FUNCTION note_reaction_locator_update() RETURNS trigger AS $$
			BEGIN
				IF (OLD."id", OLD."noteId", OLD."userId") IS NOT DISTINCT FROM (NEW."id", NEW."noteId", NEW."userId") THEN
					RETURN NULL;
				END IF;
				IF left(OLD."id", 2) <> left(OLD."noteId", 2) THEN
					DELETE FROM "note_reaction_locator" WHERE "id" = OLD."id" AND "noteId" = OLD."noteId";
				END IF;
				IF left(NEW."id", 2) <> left(NEW."noteId", 2) THEN
					INSERT INTO "note_reaction_locator" ("id", "noteId", "userId") VALUES (NEW."id", NEW."noteId", NEW."userId") ON CONFLICT DO NOTHING;
				END IF;
				RETURN NULL;
			END;
			$$ LANGUAGE plpgsql
		`);
		await queryRunner.query(`
			DO $$
			DECLARE
				target text;
			BEGIN
				SELECT c.oid::regclass::text INTO target
				FROM pg_class c
				WHERE c.relnamespace = 'public'::regnamespace AND c.relname IN ('note_reaction', 'note_reaction_p') AND c.relkind = 'p';
				IF target IS NULL THEN
					RETURN;
				END IF;
				EXECUTE format('DROP TRIGGER IF EXISTS note_reaction_locator_insert ON %s', target);
				EXECUTE format('DROP TRIGGER IF EXISTS note_reaction_locator_delete ON %s', target);
				EXECUTE format('DROP TRIGGER IF EXISTS note_reaction_locator_update ON %s', target);
				EXECUTE format('CREATE TRIGGER note_reaction_locator_insert AFTER INSERT ON %s FOR EACH ROW EXECUTE FUNCTION note_reaction_locator_insert()', target);
				EXECUTE format('CREATE TRIGGER note_reaction_locator_delete AFTER DELETE ON %s FOR EACH ROW EXECUTE FUNCTION note_reaction_locator_delete()', target);
				EXECUTE format('CREATE TRIGGER note_reaction_locator_update AFTER UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION note_reaction_locator_update()', target);
			END $$
		`);
	}

	async down(queryRunner) {
		await queryRunner.query(`DELETE FROM "partition_migration_state" WHERE "name" = 'reactionLocatorFill'`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS note_reaction_locator_update() CASCADE`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS note_reaction_locator_delete() CASCADE`);
		await queryRunner.query(`DROP FUNCTION IF EXISTS note_reaction_locator_insert() CASCADE`);
		await queryRunner.query(`DROP TABLE IF EXISTS "note_reaction_locator"`);
	}
}
