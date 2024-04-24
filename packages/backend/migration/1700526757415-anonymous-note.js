export class AnonymousNote1700526757415 {
    name = 'AnonymousNote1700526757415'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "note" ADD "anonymouslySendToUserId" character varying(32)`);
        await queryRunner.query(`CREATE INDEX "IDX_1e9b0b6b3b5f5e2b2f7d7c6f0e" ON "note" ("anonymouslySendToUserId") `);
        await queryRunner.query(`ALTER TABLE "note" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9" FOREIGN KEY ("anonymouslySendToUserId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "note" DROP CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9"`);
        await queryRunner.query(`DROP INDEX "IDX_1e9b0b6b3b5f5e2b2f7d7c6f0e"`);
        await queryRunner.query(`ALTER TABLE "note" DROP COLUMN "anonymouslySendToUserId"`);
    }
}
