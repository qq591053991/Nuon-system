-- AlterTable
ALTER TABLE "eng_bom" ADD COLUMN     "change_reason" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMP(3),
ADD COLUMN     "submitted_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "eng_routing" ADD COLUMN     "change_reason" TEXT,
ADD COLUMN     "submitted_at" TIMESTAMP(3),
ADD COLUMN     "submitted_by" VARCHAR(64);

-- AlterTable
ALTER TABLE "erp_purchase_order" ALTER COLUMN "total_amount" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "erp_purchase_order_line" ADD COLUMN     "purchase_price" DECIMAL(18,6),
ADD COLUMN     "purchase_qty" DOUBLE PRECISION,
ADD COLUMN     "purchase_uom" VARCHAR(16),
ALTER COLUMN "unit_price" SET DATA TYPE DECIMAL(18,6),
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "erp_sales_order" ALTER COLUMN "total_amount" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "erp_sales_order_line" ALTER COLUMN "unit_price" SET DATA TYPE DECIMAL(18,6),
ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "fin_doc" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,2),
ALTER COLUMN "paid_amount" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "fin_payment" ALTER COLUMN "amount" SET DATA TYPE DECIMAL(18,2);

-- AlterTable
ALTER TABLE "md_material" ADD COLUMN     "purchase_factor" DOUBLE PRECISION NOT NULL DEFAULT 1,
ADD COLUMN     "purchase_uom" VARCHAR(16),
ALTER COLUMN "std_cost" SET DATA TYPE DECIMAL(18,6);

-- AlterTable
ALTER TABLE "mes_key_part" ADD COLUMN     "action" VARCHAR(16) NOT NULL DEFAULT 'BIND',
ADD COLUMN     "ncr_id" INTEGER,
ADD COLUMN     "remark" VARCHAR(256);

-- AlterTable
ALTER TABLE "mes_serial" ADD COLUMN     "release_id" INTEGER;

-- AlterTable
ALTER TABLE "mes_work_order" ADD COLUMN     "released_qty" DOUBLE PRECISION NOT NULL DEFAULT 0;

-- AlterTable
ALTER TABLE "sys_audit_log" ADD COLUMN     "hash" VARCHAR(64),
ADD COLUMN     "prev_hash" VARCHAR(64),
ADD COLUMN     "seal_no" INTEGER;

-- AlterTable
ALTER TABLE "sys_user" ADD COLUMN     "badge_no" VARCHAR(64),
ADD COLUMN     "failed_login_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "locked_until" TIMESTAMP(3),
ADD COLUMN     "password_changed_at" TIMESTAMP(3),
ADD COLUMN     "pin_hash" VARCHAR(128);

-- AlterTable
ALTER TABLE "wms_issue" ADD COLUMN     "issue_type" VARCHAR(16) NOT NULL DEFAULT 'ISSUE';

-- CreateTable
CREATE TABLE "md_exchange_rate" (
    "id" SERIAL NOT NULL,
    "currency" VARCHAR(8) NOT NULL,
    "rate" DECIMAL(18,6) NOT NULL,
    "effective_date" DATE NOT NULL,
    "remark" VARCHAR(256),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_exchange_rate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_product_release" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "wo_id" INTEGER NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'RELEASED',
    "reason" TEXT,
    "released_by" VARCHAR(64),
    "released_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "mes_product_release_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "hr_qualification" (
    "id" SERIAL NOT NULL,
    "user_id" INTEGER NOT NULL,
    "op_code" VARCHAR(32) NOT NULL,
    "level" VARCHAR(16) NOT NULL DEFAULT 'QUALIFIED',
    "certified_at" DATE NOT NULL,
    "expires_at" DATE,
    "trainer" VARCHAR(64),
    "certificate" VARCHAR(128),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" VARCHAR(256),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "hr_qualification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qms_material_inspection_item" (
    "id" SERIAL NOT NULL,
    "material_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL DEFAULT 10,
    "name" VARCHAR(64) NOT NULL,
    "standard" VARCHAR(256),
    "method" VARCHAR(128),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "qms_material_inspection_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_customer_return" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "so_id" INTEGER,
    "shipment_id" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'RECEIVED',
    "return_date" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "ncr_id" INTEGER,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "wms_customer_return_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_customer_return_line" (
    "id" SERIAL NOT NULL,
    "return_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "sn" VARCHAR(64),
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL,
    "location_id" INTEGER NOT NULL,

    CONSTRAINT "wms_customer_return_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qms_complaint" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "received_date" DATE NOT NULL,
    "material_id" INTEGER,
    "sn" VARCHAR(64),
    "lot_no" VARCHAR(64),
    "description" TEXT NOT NULL,
    "is_adverse_event" BOOLEAN NOT NULL DEFAULT false,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "investigation" TEXT,
    "ncr_id" INTEGER,
    "capa_id" INTEGER,
    "closed_by" VARCHAR(64),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "qms_complaint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_attachment" (
    "id" SERIAL NOT NULL,
    "entity" VARCHAR(64) NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "filename" VARCHAR(256) NOT NULL,
    "content_type" VARCHAR(128),
    "size" INTEGER NOT NULL,
    "sha256" VARCHAR(64) NOT NULL,
    "storage_key" VARCHAR(256) NOT NULL,
    "uploaded_by" VARCHAR(64),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sys_attachment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "md_exchange_rate_currency_effective_date_key" ON "md_exchange_rate"("currency", "effective_date");

-- CreateIndex
CREATE UNIQUE INDEX "mes_product_release_no_key" ON "mes_product_release"("no");

-- CreateIndex
CREATE INDEX "mes_product_release_wo_id_idx" ON "mes_product_release"("wo_id");

-- CreateIndex
CREATE INDEX "hr_qualification_user_id_idx" ON "hr_qualification"("user_id");

-- CreateIndex
CREATE INDEX "qms_material_inspection_item_material_id_idx" ON "qms_material_inspection_item"("material_id");

-- CreateIndex
CREATE UNIQUE INDEX "wms_customer_return_no_key" ON "wms_customer_return"("no");

-- CreateIndex
CREATE INDEX "wms_customer_return_line_return_id_idx" ON "wms_customer_return_line"("return_id");

-- CreateIndex
CREATE UNIQUE INDEX "qms_complaint_no_key" ON "qms_complaint"("no");

-- CreateIndex
CREATE INDEX "sys_attachment_entity_entity_id_idx" ON "sys_attachment"("entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "sys_audit_log_seal_no_key" ON "sys_audit_log"("seal_no");

-- CreateIndex
CREATE UNIQUE INDEX "sys_user_badge_no_key" ON "sys_user"("badge_no");

-- CreateIndex
-- 货主为空也视为相同（PostgreSQL 15+）
CREATE UNIQUE INDEX "wms_stock_key_uq" ON "wms_stock"("material_id", "location_id", "lot_no", "status", "owner_customer_id") NULLS NOT DISTINCT;

-- AddForeignKey
ALTER TABLE "mes_serial" ADD CONSTRAINT "mes_serial_release_id_fkey" FOREIGN KEY ("release_id") REFERENCES "mes_product_release"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_product_release" ADD CONSTRAINT "mes_product_release_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "hr_qualification" ADD CONSTRAINT "hr_qualification_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "sys_user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_material_inspection_item" ADD CONSTRAINT "qms_material_inspection_item_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_customer_return_line" ADD CONSTRAINT "wms_customer_return_line_return_id_fkey" FOREIGN KEY ("return_id") REFERENCES "wms_customer_return"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_customer_return_line" ADD CONSTRAINT "wms_customer_return_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- =====================================================================
-- 合规：电子记录不可篡改（21 CFR Part 11 §11.10(e)）
--   1) 电子签名、库存流水：禁止 UPDATE / DELETE
--   2) 审计追踪：禁止 DELETE；只允许“封存”（写入 prev_hash/hash/seal_no），内容字段不可改
--   3) 审计追踪哈希链：audit_seal() 按顺序为未封存记录计算 sha256 链，audit_row_hash() 供校验复算
-- 生产环境另建议：应用数据库账号不授予 TRUNCATE / ALTER 权限（见 docs/operations.md）
-- =====================================================================

CREATE OR REPLACE FUNCTION nuon_deny_modify() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '电子记录不可修改或删除：%', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_esignature_immutable BEFORE UPDATE OR DELETE ON "sys_esignature"
  FOR EACH ROW EXECUTE FUNCTION nuon_deny_modify();
CREATE TRIGGER trg_stock_move_immutable BEFORE UPDATE OR DELETE ON "wms_stock_move"
  FOR EACH ROW EXECUTE FUNCTION nuon_deny_modify();

CREATE OR REPLACE FUNCTION nuon_audit_guard() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION '审计追踪不可删除' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.hash IS NULL AND NEW.hash IS NOT NULL
     AND (NEW.id, NEW.ts, NEW.username, NEW.full_name, NEW.entity, NEW.entity_id, NEW.action, NEW.changes)
         IS NOT DISTINCT FROM (OLD.id, OLD.ts, OLD.username, OLD.full_name, OLD.entity, OLD.entity_id, OLD.action, OLD.changes) THEN
    RETURN NEW; -- 仅允许封存
  END IF;
  RAISE EXCEPTION '审计追踪不可修改' USING ERRCODE = 'insufficient_privilege';
END $$ LANGUAGE plpgsql;

CREATE TRIGGER trg_audit_log_guard BEFORE UPDATE OR DELETE ON "sys_audit_log"
  FOR EACH ROW EXECUTE FUNCTION nuon_audit_guard();

-- 单条审计记录的哈希（封存与校验共用，保证算法一致）
CREATE OR REPLACE FUNCTION audit_row_hash(prev text, r "sys_audit_log") RETURNS text AS $$
  SELECT encode(sha256(convert_to(
    coalesce(prev, '') || '|' || r.id::text || '|' || to_char(r.ts, 'YYYY-MM-DD"T"HH24:MI:SS.MS') || '|' ||
    coalesce(r.username, '') || '|' || coalesce(r.full_name, '') || '|' || r.entity || '|' ||
    coalesce(r.entity_id::text, '') || '|' || r.action || '|' || coalesce(r.changes, ''), 'UTF8')), 'hex');
$$ LANGUAGE sql IMMUTABLE;

-- 封存：为所有未封存记录按 id 顺序续接哈希链，返回本次封存条数（并发安全：咨询锁）
CREATE OR REPLACE FUNCTION audit_seal() RETURNS integer AS $$
DECLARE
  r "sys_audit_log";
  head text;
  seq integer;
  n integer := 0;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('nuon_audit_seal'));
  SELECT hash, seal_no INTO head, seq FROM "sys_audit_log" WHERE seal_no IS NOT NULL ORDER BY seal_no DESC LIMIT 1;
  seq := coalesce(seq, 0);
  FOR r IN SELECT * FROM "sys_audit_log" WHERE seal_no IS NULL ORDER BY id LOOP
    seq := seq + 1;
    UPDATE "sys_audit_log" SET prev_hash = head, hash = audit_row_hash(head, r), seal_no = seq WHERE id = r.id;
    head := audit_row_hash(head, r);
    n := n + 1;
  END LOOP;
  RETURN n;
END $$ LANGUAGE plpgsql;

-- 校验：返回哈希链断裂/被篡改的记录（无返回 = 完整）
CREATE OR REPLACE FUNCTION audit_verify() RETURNS TABLE(id integer, seal_no integer, problem text) AS $$
  SELECT a.id, a.seal_no,
         CASE WHEN a.hash IS DISTINCT FROM audit_row_hash(a.prev_hash, a) THEN '内容与哈希不符（记录被篡改）'
              ELSE '与上一条记录的哈希不连续（记录被删除或插入）' END
  FROM "sys_audit_log" a
  LEFT JOIN "sys_audit_log" p ON p.seal_no = a.seal_no - 1
  WHERE a.seal_no IS NOT NULL
    AND (a.hash IS DISTINCT FROM audit_row_hash(a.prev_hash, a)
         OR (a.seal_no > 1 AND a.prev_hash IS DISTINCT FROM p.hash)
         OR (a.seal_no = 1 AND a.prev_hash IS NOT NULL))
  ORDER BY a.seal_no;
$$ LANGUAGE sql STABLE;
