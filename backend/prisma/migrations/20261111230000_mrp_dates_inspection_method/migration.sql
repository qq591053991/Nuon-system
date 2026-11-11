-- AlterTable
ALTER TABLE "erp_mrp_suggestion" ADD COLUMN     "required_date" DATE,
ADD COLUMN     "week" VARCHAR(10);

-- AlterTable
ALTER TABLE "qms_inspection_item" ADD COLUMN     "method" VARCHAR(128),
ADD COLUMN     "spec_item_id" INTEGER;

