export class UserPinnedGallery1700823392948 {
    name = 'UserPinnedGallery1700823392948'

    async up(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user_profile" ADD "pinnedGalleryPostId" character varying(32)`);
        await queryRunner.query(`ALTER TABLE "user_profile" ADD CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9" FOREIGN KEY ("pinnedGalleryPostId") REFERENCES "gallery_post"("id") ON DELETE SET NULL ON UPDATE NO ACTION`);
    }

    async down(queryRunner) {
        await queryRunner.query(`ALTER TABLE "user_profile" DROP CONSTRAINT "FK_1e9b0b6b3b5f5e2b2f7d7c6f0e9"`);
        await queryRunner.query(`ALTER TABLE "user_profile" DROP COLUMN "pinnedGalleryPostId"`);
    }
}
