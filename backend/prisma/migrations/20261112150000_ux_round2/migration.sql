-- AlterTable
ALTER TABLE "erp_mrp_suggestion" ADD COLUMN     "notified_at" TIMESTAMP(3),
ADD COLUMN     "notified_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "fin_doc" ADD COLUMN     "invoice_date" DATE,
ADD COLUMN     "invoice_no" VARCHAR(64);

-- AlterTable
ALTER TABLE "fin_payment" ADD COLUMN     "bank_account" VARCHAR(128);

-- AlterTable
ALTER TABLE "hr_qualification" ADD COLUMN     "void_reason" VARCHAR(256),
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "md_customer" ADD COLUMN     "tax_rate" DECIMAL(6,4);

-- AlterTable
ALTER TABLE "md_material" ADD COLUMN     "name_en" VARCHAR(200);

-- AlterTable
ALTER TABLE "md_supplier" ADD COLUMN     "tax_rate" DECIMAL(6,4);

-- AlterTable
ALTER TABLE "qms_capa" ADD COLUMN     "owner_user_id" INTEGER;

-- AlterTable
ALTER TABLE "qms_inspection_item" ADD COLUMN     "defect_qty" INTEGER NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "qms_ncr" ADD COLUMN     "require_part_change" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "sys_user" ADD COLUMN     "must_change_pin" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "sys_setting" (
    "key" VARCHAR(64) NOT NULL,
    "value" TEXT NOT NULL,
    "updated_by" VARCHAR(64),
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sys_setting_pkey" PRIMARY KEY ("key")
);


-- 数据回填：第一轮以兼容方式存放的数据迁到正式字段
UPDATE "qms_inspection_item" SET "defect_qty" = ("sample_values"::jsonb->>'defects')::int
  WHERE "sample_values" LIKE '{"defects"%' AND ("sample_values"::jsonb->>'defects') ~ '^[0-9]+$';
UPDATE "qms_capa" c SET "owner_user_id" = u."id" FROM "sys_user" u
  WHERE c."owner_user_id" IS NULL AND c."owner" IS NOT NULL AND (c."owner" = u."full_name" OR c."owner" = u."username");
