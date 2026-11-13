-- CreateTable
CREATE TABLE "rfid_reader" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "reader_type" VARCHAR(16) NOT NULL,
    "purpose" VARCHAR(16) NOT NULL,
    "warehouse_id" INTEGER,
    "location_id" INTEGER,
    "outside_location_id" INTEGER,
    "direction_mode" VARCHAR(16) NOT NULL DEFAULT 'NONE',
    "inner_antenna" INTEGER,
    "outer_antenna" INTEGER,
    "rssi_min" DOUBLE PRECISION,
    "key_hash" VARCHAR(128),
    "key_hint" VARCHAR(16),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "last_heartbeat_at" TIMESTAMP(3),
    "last_ip" VARCHAR(64),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "rfid_reader_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfid_tag" (
    "id" SERIAL NOT NULL,
    "epc" VARCHAR(64) NOT NULL,
    "tag_type" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'ACTIVE',
    "material_id" INTEGER,
    "lot_no" VARCHAR(64),
    "qty" DOUBLE PRECISION,
    "owner_customer_id" INTEGER,
    "serial_id" INTEGER,
    "location_id" INTEGER,
    "receipt_id" INTEGER,
    "last_reader_id" INTEGER,
    "last_antenna" INTEGER,
    "last_rssi" DOUBLE PRECISION,
    "last_seen_at" TIMESTAMP(3),
    "void_reason" VARCHAR(256),
    "voided_by" VARCHAR(64),
    "voided_at" TIMESTAMP(3),
    "replaced_by_epc" VARCHAR(64),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "rfid_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfid_session" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "session_type" VARCHAR(16) NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "reader_id" INTEGER,
    "location_id" INTEGER,
    "po_id" INTEGER,
    "issue_id" INTEGER,
    "wo_id" INTEGER,
    "shipment_id" INTEGER,
    "count_id" INTEGER,
    "ref_type" VARCHAR(32),
    "ref_id" INTEGER,
    "ref_no" VARCHAR(256),
    "last_read_at" TIMESTAMP(3),
    "confirmed_by" VARCHAR(64),
    "confirmed_at" TIMESTAMP(3),
    "cancel_reason" VARCHAR(256),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "rfid_session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfid_session_tag" (
    "id" SERIAL NOT NULL,
    "session_id" INTEGER NOT NULL,
    "epc" VARCHAR(64) NOT NULL,
    "tag_id" INTEGER,
    "source" VARCHAR(16) NOT NULL DEFAULT 'READER',
    "first_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "read_count" INTEGER NOT NULL DEFAULT 1,
    "max_rssi" DOUBLE PRECISION,
    "antennas" VARCHAR(64),
    "direction" VARCHAR(8),
    "sn" VARCHAR(64),
    "po_line_id" INTEGER,
    "material_id" INTEGER,
    "lot_no" VARCHAR(64),
    "supplier_lot" VARCHAR(64),
    "qty" DOUBLE PRECISION,
    "location_id" INTEGER,
    "mfg_date" DATE,
    "expiry_date" DATE,
    "action" VARCHAR(16),
    "action_note" VARCHAR(256),

    CONSTRAINT "rfid_session_tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rfid_read" (
    "id" SERIAL NOT NULL,
    "reader_id" INTEGER NOT NULL,
    "session_id" INTEGER,
    "antenna" INTEGER,
    "epc" VARCHAR(64) NOT NULL,
    "rssi" DOUBLE PRECISION,
    "read_at" TIMESTAMP(3) NOT NULL,
    "received_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "source" VARCHAR(16) NOT NULL DEFAULT 'READER',
    "result" VARCHAR(16) NOT NULL,
    "username" VARCHAR(64),

    CONSTRAINT "rfid_read_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rfid_reader_code_key" ON "rfid_reader"("code");

-- CreateIndex
CREATE INDEX "rfid_reader_key_hash_idx" ON "rfid_reader"("key_hash");

-- CreateIndex
CREATE UNIQUE INDEX "rfid_tag_epc_key" ON "rfid_tag"("epc");

-- CreateIndex
CREATE INDEX "rfid_tag_material_id_lot_no_idx" ON "rfid_tag"("material_id", "lot_no");

-- CreateIndex
CREATE INDEX "rfid_tag_serial_id_idx" ON "rfid_tag"("serial_id");

-- CreateIndex
CREATE INDEX "rfid_tag_location_id_idx" ON "rfid_tag"("location_id");

-- CreateIndex
CREATE INDEX "rfid_tag_status_idx" ON "rfid_tag"("status");

-- CreateIndex
CREATE UNIQUE INDEX "rfid_session_no_key" ON "rfid_session"("no");

-- CreateIndex
CREATE INDEX "rfid_session_status_session_type_idx" ON "rfid_session"("status", "session_type");

-- CreateIndex
CREATE INDEX "rfid_session_reader_id_status_idx" ON "rfid_session"("reader_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "rfid_session_tag_session_id_epc_key" ON "rfid_session_tag"("session_id", "epc");

-- CreateIndex
CREATE INDEX "rfid_read_session_id_idx" ON "rfid_read"("session_id");

-- CreateIndex
CREATE INDEX "rfid_read_epc_idx" ON "rfid_read"("epc");

-- CreateIndex
CREATE INDEX "rfid_read_reader_id_received_at_idx" ON "rfid_read"("reader_id", "received_at");

-- AddForeignKey
ALTER TABLE "rfid_reader" ADD CONSTRAINT "rfid_reader_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "md_warehouse"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_reader" ADD CONSTRAINT "rfid_reader_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_reader" ADD CONSTRAINT "rfid_reader_outside_location_id_fkey" FOREIGN KEY ("outside_location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_tag" ADD CONSTRAINT "rfid_tag_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_tag" ADD CONSTRAINT "rfid_tag_serial_id_fkey" FOREIGN KEY ("serial_id") REFERENCES "mes_serial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_tag" ADD CONSTRAINT "rfid_tag_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_tag" ADD CONSTRAINT "rfid_tag_last_reader_id_fkey" FOREIGN KEY ("last_reader_id") REFERENCES "rfid_reader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_session" ADD CONSTRAINT "rfid_session_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "rfid_reader"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_session" ADD CONSTRAINT "rfid_session_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_session_tag" ADD CONSTRAINT "rfid_session_tag_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "rfid_session"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_read" ADD CONSTRAINT "rfid_read_reader_id_fkey" FOREIGN KEY ("reader_id") REFERENCES "rfid_reader"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rfid_read" ADD CONSTRAINT "rfid_read_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "rfid_session"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 合规：RFID 原始读取属于电子记录，禁止 UPDATE / DELETE（函数 nuon_deny_modify 见 20261111210000_review_improvements）
CREATE TRIGGER trg_rfid_read_immutable BEFORE UPDATE OR DELETE ON "rfid_read"
  FOR EACH ROW EXECUTE FUNCTION nuon_deny_modify();
