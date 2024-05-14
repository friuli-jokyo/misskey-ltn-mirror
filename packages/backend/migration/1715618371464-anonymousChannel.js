/*
 * SPDX-FileCopyrightText: syuilo and other misskey contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 */

export class AnonymousChannel1715618371464 {
    name = 'AnonymousChannel1715618371464'

    async up(queryRunner) {
        await queryRunner.query(`CREATE TYPE "public"."channel_anonymousstrategy_enum" AS ENUM('daily', 'weekly', 'monthly', 'yearly', 'manual')`);
        await queryRunner.query(`ALTER TABLE "channel" ADD "anonymousStrategy" "public"."channel_anonymousstrategy_enum"`);
        await queryRunner.query(`ALTER TABLE "channel" ADD "requirePublicWriteAccess" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`ALTER TABLE "note" ADD "anonymousChannelUsername" character varying(128)`);
        await queryRunner.query(`CREATE TABLE "channel_anonymous_salt" ("id" character varying(32) NOT NULL, "channelId" character varying(32) NOT NULL, "since" character varying(32) NOT NULL, "until" character varying(32), "salt" bigint NOT NULL, CONSTRAINT "PK_b918eb2c39bc401382cf4450af3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_37988dcb4783a496681dcd4b4a" ON "channel_anonymous_salt" ("channelId") `);
        await queryRunner.query(`CREATE INDEX "IDX_b86b095617434a08bd1826489" ON "channel_anonymous_salt" ("since") `);
        await queryRunner.query(`CREATE INDEX "IDX_9b6d30f18ed64a82ac5aa5fc0" ON "channel_anonymous_salt" ("until") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f7be165bf5ef42328a171a8a1" ON "channel_anonymous_salt" ("channelId", "since", "until") `);
        await queryRunner.query(`ALTER TABLE "channel_anonymous_salt" ADD CONSTRAINT "FK_52001e5bea6d49bd8a19243d3b" FOREIGN KEY ("channelId") REFERENCES "channel"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "channel_anonymous_salt" DROP CONSTRAINT "FK_52001e5bea6d49bd8a19243d3b"`);
        await queryRunner.query(`DROP INDEX "IDX_f7be165bf5ef42328a171a8a1"`);
        await queryRunner.query(`DROP INDEX "IDX_9b6d30f18ed64a82ac5aa5fc0"`);
        await queryRunner.query(`DROP INDEX "IDX_b86b095617434a08bd1826489"`);
        await queryRunner.query(`DROP INDEX "IDX_37988dcb4783a496681dcd4b4a"`);
        await queryRunner.query(`DROP TABLE "channel_anonymous_salt"`);
        await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "anonymousChannelUsername"`);
        await queryRunner.query(`ALTER TABLE "channel" DROP COLUMN "requirePublicWriteAccess"`);
        await queryRunner.query(`ALTER TABLE "channel" DROP COLUMN "anonymousStrategy"`);
        await queryRunner.query(`DROP TYPE "public"."channel_anonymousstrategy_enum"`);
    }
}
