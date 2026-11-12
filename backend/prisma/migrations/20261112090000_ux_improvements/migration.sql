-- AlterTable
ALTER TABLE "eng_routing_param" ADD COLUMN     "decimals" INTEGER,
ADD COLUMN     "max_valid" DOUBLE PRECISION,
ADD COLUMN     "min_valid" DOUBLE PRECISION,
ADD COLUMN     "param_type" VARCHAR(8) NOT NULL DEFAULT 'NUMBER';

-- AlterTable
ALTER TABLE "erp_mrp_suggestion" ADD COLUMN     "demand_refs" TEXT,
ADD COLUMN     "exception" VARCHAR(16);

-- AlterTable
ALTER TABLE "erp_purchase_order_line" ADD COLUMN     "promised_date" DATE;

-- AlterTable
ALTER TABLE "fin_doc" ADD COLUMN     "base_amount" DECIMAL(18,2),
ADD COLUMN     "exchange_rate" DECIMAL(18,6);

-- AlterTable
ALTER TABLE "fin_payment" ADD COLUMN     "base_amount" DECIMAL(18,2),
ADD COLUMN     "exchange_rate" DECIMAL(18,6),
ADD COLUMN     "fee_amount" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "fx_diff" DECIMAL(18,2) NOT NULL DEFAULT 0,
ADD COLUMN     "receipt_no" VARCHAR(32),
ADD COLUMN     "status" VARCHAR(8) NOT NULL DEFAULT 'VALID',
ADD COLUMN     "void_reason" VARCHAR(256),
ADD COLUMN     "voided_at" TIMESTAMP(3),
ADD COLUMN     "voided_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "md_equipment" ADD COLUMN     "op_types" VARCHAR(128);

-- AlterTable
ALTER TABLE "md_material" ADD COLUMN     "default_location_id" INTEGER;

-- AlterTable
ALTER TABLE "qms_complaint" ADD COLUMN     "country" VARCHAR(32),
ADD COLUMN     "customer_reply" TEXT,
ADD COLUMN     "event_date" DATE,
ADD COLUMN     "replied_at" DATE,
ADD COLUMN     "report_deadline" DATE,
ADD COLUMN     "report_no" VARCHAR(64),
ADD COLUMN     "reportable" BOOLEAN,
ADD COLUMN     "reported_at" DATE,
ADD COLUMN     "reporter_contact" VARCHAR(128);

-- AlterTable
ALTER TABLE "qms_inspection_item" ADD COLUMN     "checked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "item_type" VARCHAR(8) NOT NULL DEFAULT 'QUAL',
ADD COLUMN     "lower" DOUBLE PRECISION,
ADD COLUMN     "sample_values" TEXT,
ADD COLUMN     "unit" VARCHAR(16),
ADD COLUMN     "upper" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "qms_material_inspection_item" ADD COLUMN     "item_type" VARCHAR(8) NOT NULL DEFAULT 'QUAL',
ADD COLUMN     "lower" DOUBLE PRECISION,
ADD COLUMN     "unit" VARCHAR(16),
ADD COLUMN     "upper" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "qms_ncr" ADD COLUMN     "closed_at" TIMESTAMP(3),
ADD COLUMN     "closed_by" VARCHAR(64),
ADD COLUMN     "due_date" DATE;

-- AlterTable
ALTER TABLE "sys_user" ADD COLUMN     "must_change_password" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "wms_issue" ADD COLUMN     "reverse_reason" VARCHAR(256),
ADD COLUMN     "reversed_at" TIMESTAMP(3),
ADD COLUMN     "reversed_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "wms_issue_line" ADD COLUMN     "picked_qty" DOUBLE PRECISION;

-- AlterTable
ALTER TABLE "wms_shipment" ADD COLUMN     "reverse_reason" VARCHAR(256),
ADD COLUMN     "reversed_at" TIMESTAMP(3),
ADD COLUMN     "reversed_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "wms_stock_count" ADD COLUMN     "blind" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "location_ids" VARCHAR(512),
ADD COLUMN     "reverse_reason" VARCHAR(256),
ADD COLUMN     "reversed_at" TIMESTAMP(3),
ADD COLUMN     "reversed_by" VARCHAR(64);

-- CreateTable
CREATE TABLE "wms_supplier_return" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "supplier_id" INTEGER,
    "ncr_id" INTEGER,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL,
    "owner_customer_id" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "shipped_by" VARCHAR(64),
    "shipped_at" TIMESTAMP(3),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "wms_supplier_return_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "wms_supplier_return_no_key" ON "wms_supplier_return"("no");

-- CreateIndex
CREATE INDEX "wms_supplier_return_ncr_id_idx" ON "wms_supplier_return"("ncr_id");

-- CreateIndex
CREATE UNIQUE INDEX "eng_routing_param_operation_id_code_key" ON "eng_routing_param"("operation_id", "code");

