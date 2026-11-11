-- AlterTable
ALTER TABLE "sys_user" ADD COLUMN     "auth_source" VARCHAR(16) NOT NULL DEFAULT 'LOCAL',
ADD COLUMN     "external_id" VARCHAR(64),
ADD COLUMN     "last_login_at" TIMESTAMP(3);
