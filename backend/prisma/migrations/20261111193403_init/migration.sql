-- CreateTable
CREATE TABLE "sys_user" (
    "id" SERIAL NOT NULL,
    "username" VARCHAR(64) NOT NULL,
    "full_name" VARCHAR(64) NOT NULL,
    "password_hash" VARCHAR(128) NOT NULL,
    "roles" VARCHAR(256) NOT NULL DEFAULT '',
    "department" VARCHAR(64),
    "email" VARCHAR(128),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "sys_user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_audit_log" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" VARCHAR(64),
    "full_name" VARCHAR(64),
    "entity" VARCHAR(64) NOT NULL,
    "entity_id" INTEGER,
    "action" VARCHAR(16) NOT NULL,
    "changes" TEXT,

    CONSTRAINT "sys_audit_log_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_esignature" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "username" VARCHAR(64) NOT NULL,
    "full_name" VARCHAR(64) NOT NULL,
    "meaning" VARCHAR(64) NOT NULL,
    "entity" VARCHAR(64) NOT NULL,
    "entity_id" INTEGER NOT NULL,
    "doc_no" VARCHAR(64),
    "reason" VARCHAR(256),

    CONSTRAINT "sys_esignature_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sys_sequence" (
    "key" VARCHAR(64) NOT NULL,
    "value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "sys_sequence_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "md_customer" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "short_name" VARCHAR(64),
    "country" VARCHAR(32),
    "contact" VARCHAR(64),
    "phone" VARCHAR(32),
    "email" VARCHAR(128),
    "address" VARCHAR(256),
    "mah_name" VARCHAR(128),
    "tax_no" VARCHAR(64),
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "quality_agreement_no" VARCHAR(64),
    "quality_agreement_expiry" DATE,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_supplier" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "short_name" VARCHAR(64),
    "category" VARCHAR(64),
    "contact" VARCHAR(64),
    "phone" VARCHAR(32),
    "email" VARCHAR(128),
    "address" VARCHAR(256),
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "qualification_expiry" DATE,
    "iso13485" BOOLEAN NOT NULL DEFAULT false,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "payment_terms_days" INTEGER NOT NULL DEFAULT 30,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_supplier_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_material" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(64) NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "spec" VARCHAR(256),
    "category" VARCHAR(16) NOT NULL DEFAULT 'RAW',
    "uom" VARCHAR(16) NOT NULL DEFAULT 'PCS',
    "lot_control" BOOLEAN NOT NULL DEFAULT true,
    "serial_control" BOOLEAN NOT NULL DEFAULT false,
    "shelf_life_days" INTEGER,
    "safety_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lead_time_days" INTEGER NOT NULL DEFAULT 7,
    "min_order_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "std_cost" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "default_supplier_id" INTEGER,
    "owner_customer_id" INTEGER,
    "customer_id" INTEGER,
    "iqc_required" BOOLEAN NOT NULL DEFAULT true,
    "aql" DOUBLE PRECISION NOT NULL DEFAULT 1.0,
    "wavelength_nm" VARCHAR(64),
    "msl_level" VARCHAR(8),
    "esd_sensitive" BOOLEAN NOT NULL DEFAULT false,
    "model" VARCHAR(64),
    "registration_no" VARCHAR(64),
    "device_class" VARCHAR(8),
    "gtin" VARCHAR(14),
    "sn_prefix" VARCHAR(16),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eng_bom" (
    "id" SERIAL NOT NULL,
    "material_id" INTEGER NOT NULL,
    "version" VARCHAR(16) NOT NULL DEFAULT 'A0',
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "ecn_no" VARCHAR(64),
    "effective_date" DATE,
    "released_by" VARCHAR(64),
    "released_at" TIMESTAMP(3),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "eng_bom_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eng_bom_line" (
    "id" SERIAL NOT NULL,
    "bom_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 10,
    "component_id" INTEGER NOT NULL,
    "qty_per" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "scrap_rate" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "designator" VARCHAR(256),
    "remark" VARCHAR(256),

    CONSTRAINT "eng_bom_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_work_center" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "description" VARCHAR(256),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_work_center_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eng_routing" (
    "id" SERIAL NOT NULL,
    "material_id" INTEGER NOT NULL,
    "version" VARCHAR(16) NOT NULL DEFAULT 'A0',
    "name" VARCHAR(128),
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "released_by" VARCHAR(64),
    "released_at" TIMESTAMP(3),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "eng_routing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eng_routing_op" (
    "id" SERIAL NOT NULL,
    "routing_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "op_type" VARCHAR(16) NOT NULL DEFAULT 'ASSEMBLY',
    "work_center_id" INTEGER,
    "std_minutes" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "requires_equipment" BOOLEAN NOT NULL DEFAULT false,
    "key_part_material_id" INTEGER,
    "sop_no" VARCHAR(64),
    "instructions" TEXT,

    CONSTRAINT "eng_routing_op_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "eng_routing_param" (
    "id" SERIAL NOT NULL,
    "operation_id" INTEGER NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "unit" VARCHAR(16),
    "lower" DOUBLE PRECISION,
    "upper" DOUBLE PRECISION,
    "target" DOUBLE PRECISION,

    CONSTRAINT "eng_routing_param_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_equipment" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "model" VARCHAR(64),
    "serial_no" VARCHAR(64),
    "equipment_type" VARCHAR(16) NOT NULL DEFAULT 'PRODUCTION',
    "work_center_id" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'NORMAL',
    "calibration_required" BOOLEAN NOT NULL DEFAULT false,
    "calibration_cycle_days" INTEGER,
    "last_calibration_date" DATE,
    "next_calibration_date" DATE,
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_equipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_calibration" (
    "id" SERIAL NOT NULL,
    "equipment_id" INTEGER NOT NULL,
    "calibration_date" DATE NOT NULL,
    "result" VARCHAR(8) NOT NULL DEFAULT 'PASS',
    "certificate_no" VARCHAR(64),
    "agency" VARCHAR(128),
    "next_due_date" DATE,
    "remark" VARCHAR(256),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_calibration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_warehouse" (
    "id" SERIAL NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "warehouse_type" VARCHAR(16) NOT NULL DEFAULT 'RAW',
    "address" VARCHAR(256),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_warehouse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "md_location" (
    "id" SERIAL NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64),
    "location_type" VARCHAR(16) NOT NULL DEFAULT 'STORAGE',
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "md_location_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_sales_order" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "customer_id" INTEGER NOT NULL,
    "order_date" DATE NOT NULL,
    "delivery_date" DATE,
    "customer_po" VARCHAR(64),
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ship_to" VARCHAR(256),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "erp_sales_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_sales_order_line" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 1,
    "material_id" INTEGER NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "shipped_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "delivery_date" DATE,
    "remark" VARCHAR(256),

    CONSTRAINT "erp_sales_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_purchase_order" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "supplier_id" INTEGER NOT NULL,
    "order_date" DATE NOT NULL,
    "expected_date" DATE,
    "status" VARCHAR(20) NOT NULL DEFAULT 'DRAFT',
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "total_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "approved_by" VARCHAR(64),
    "approved_at" TIMESTAMP(3),
    "source" VARCHAR(64),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "erp_purchase_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_purchase_order_line" (
    "id" SERIAL NOT NULL,
    "order_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 1,
    "material_id" INTEGER NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "unit_price" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "received_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "expected_date" DATE,
    "remark" VARCHAR(256),

    CONSTRAINT "erp_purchase_order_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_mrp_run" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "run_at" TIMESTAMP(3) NOT NULL,
    "run_by" VARCHAR(64),
    "summary" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "erp_mrp_run_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "erp_mrp_suggestion" (
    "id" SERIAL NOT NULL,
    "run_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "level" INTEGER NOT NULL DEFAULT 0,
    "action" VARCHAR(20) NOT NULL,
    "gross_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "on_hand_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "on_order_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "safety_stock" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "net_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "suggested_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "due_date" DATE,
    "supplier_id" INTEGER,
    "customer_id" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "converted_doc_no" VARCHAR(32),
    "remark" VARCHAR(256),

    CONSTRAINT "erp_mrp_suggestion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_doc" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "doc_type" VARCHAR(4) NOT NULL,
    "customer_id" INTEGER,
    "supplier_id" INTEGER,
    "ref_type" VARCHAR(32),
    "ref_no" VARCHAR(32),
    "doc_date" DATE NOT NULL,
    "due_date" DATE,
    "currency" VARCHAR(8) NOT NULL DEFAULT 'CNY',
    "amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "paid_amount" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "fin_doc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "fin_payment" (
    "id" SERIAL NOT NULL,
    "doc_id" INTEGER NOT NULL,
    "pay_date" DATE NOT NULL,
    "amount" DOUBLE PRECISION NOT NULL,
    "method" VARCHAR(32),
    "reference" VARCHAR(64),
    "remark" VARCHAR(256),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "fin_payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_stock" (
    "id" SERIAL NOT NULL,
    "material_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
    "owner_customer_id" INTEGER,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "mfg_date" DATE,
    "expiry_date" DATE,
    "supplier_id" INTEGER,
    "supplier_lot" VARCHAR(64),
    "received_at" TIMESTAMP(3),

    CONSTRAINT "wms_stock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_stock_move" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "move_type" VARCHAR(20) NOT NULL,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "qty" DOUBLE PRECISION NOT NULL,
    "from_location_id" INTEGER,
    "to_location_id" INTEGER,
    "from_status" VARCHAR(16),
    "to_status" VARCHAR(16),
    "owner_customer_id" INTEGER,
    "ref_type" VARCHAR(32),
    "ref_id" INTEGER,
    "ref_no" VARCHAR(32),
    "username" VARCHAR(64),
    "remark" VARCHAR(256),

    CONSTRAINT "wms_stock_move_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_receipt" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "receipt_type" VARCHAR(20) NOT NULL,
    "supplier_id" INTEGER,
    "customer_id" INTEGER,
    "po_id" INTEGER,
    "wo_id" INTEGER,
    "status" VARCHAR(16) NOT NULL DEFAULT 'CONFIRMED',
    "receipt_date" DATE NOT NULL,
    "delivery_note" VARCHAR(64),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "wms_receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_receipt_line" (
    "id" SERIAL NOT NULL,
    "receipt_id" INTEGER NOT NULL,
    "line_no" INTEGER NOT NULL DEFAULT 1,
    "material_id" INTEGER NOT NULL,
    "po_line_id" INTEGER,
    "qty" DOUBLE PRECISION NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "supplier_lot" VARCHAR(64),
    "location_id" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'QUARANTINE',
    "mfg_date" DATE,
    "expiry_date" DATE,
    "inspection_id" INTEGER,

    CONSTRAINT "wms_receipt_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_issue" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "wo_id" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "confirmed_by" VARCHAR(64),
    "confirmed_at" TIMESTAMP(3),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "wms_issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_issue_line" (
    "id" SERIAL NOT NULL,
    "issue_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "location_id" INTEGER NOT NULL,
    "owner_customer_id" INTEGER,
    "qty" DOUBLE PRECISION NOT NULL,
    "expiry_date" DATE,

    CONSTRAINT "wms_issue_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_shipment" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "so_id" INTEGER,
    "customer_id" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'DRAFT',
    "ship_date" DATE,
    "carrier" VARCHAR(64),
    "tracking_no" VARCHAR(64),
    "ship_to" VARCHAR(256),
    "shipped_by" VARCHAR(64),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "wms_shipment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_shipment_line" (
    "id" SERIAL NOT NULL,
    "shipment_id" INTEGER NOT NULL,
    "so_line_id" INTEGER,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "location_id" INTEGER NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL,
    "serials" TEXT,

    CONSTRAINT "wms_shipment_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_stock_count" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "warehouse_id" INTEGER NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "posted_by" VARCHAR(64),
    "posted_at" TIMESTAMP(3),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "wms_stock_count_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "wms_stock_count_line" (
    "id" SERIAL NOT NULL,
    "count_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "location_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "status" VARCHAR(16) NOT NULL DEFAULT 'AVAILABLE',
    "owner_customer_id" INTEGER,
    "system_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "counted_qty" DOUBLE PRECISION,

    CONSTRAINT "wms_stock_count_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_work_order" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "material_id" INTEGER NOT NULL,
    "customer_id" INTEGER,
    "so_id" INTEGER,
    "so_line_id" INTEGER,
    "bom_id" INTEGER,
    "routing_id" INTEGER,
    "planned_qty" DOUBLE PRECISION NOT NULL,
    "completed_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "scrap_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "received_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "lot_no" VARCHAR(64),
    "planned_start" DATE,
    "planned_end" DATE,
    "actual_start" TIMESTAMP(3),
    "actual_end" TIMESTAMP(3),
    "status" VARCHAR(16) NOT NULL DEFAULT 'PLANNED',
    "dhr_status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "released_by" VARCHAR(64),
    "priority" INTEGER NOT NULL DEFAULT 3,
    "source" VARCHAR(64),
    "remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "mes_work_order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_wo_material" (
    "id" SERIAL NOT NULL,
    "wo_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "qty_per" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "required_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "issued_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "mes_wo_material_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_wo_operation" (
    "id" SERIAL NOT NULL,
    "wo_id" INTEGER NOT NULL,
    "seq" INTEGER NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "op_type" VARCHAR(16) NOT NULL,
    "work_center_id" INTEGER,
    "requires_equipment" BOOLEAN NOT NULL DEFAULT false,
    "key_part_material_id" INTEGER,
    "sop_no" VARCHAR(64),
    "instructions" TEXT,
    "params_json" TEXT,
    "good_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "ng_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,

    CONSTRAINT "mes_wo_operation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_serial" (
    "id" SERIAL NOT NULL,
    "sn" VARCHAR(64) NOT NULL,
    "wo_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64),
    "udi" VARCHAR(128),
    "status" VARCHAR(16) NOT NULL DEFAULT 'CREATED',
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "ng_seq" INTEGER,
    "location_id" INTEGER,
    "shipment_id" INTEGER,
    "customer_id" INTEGER,
    "completed_at" TIMESTAMP(3),
    "shipped_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "mes_serial_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_op_record" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wo_id" INTEGER NOT NULL,
    "sn_id" INTEGER,
    "seq" INTEGER NOT NULL,
    "op_code" VARCHAR(32) NOT NULL,
    "op_name" VARCHAR(64) NOT NULL,
    "result" VARCHAR(8) NOT NULL,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "operator" VARCHAR(64) NOT NULL,
    "operator_name" VARCHAR(64),
    "equipment_id" INTEGER,
    "is_rework" BOOLEAN NOT NULL DEFAULT false,
    "remark" VARCHAR(256),

    CONSTRAINT "mes_op_record_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_test_value" (
    "id" SERIAL NOT NULL,
    "record_id" INTEGER NOT NULL,
    "code" VARCHAR(32) NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "unit" VARCHAR(16),
    "value" DOUBLE PRECISION,
    "lower" DOUBLE PRECISION,
    "upper" DOUBLE PRECISION,
    "result" VARCHAR(8) NOT NULL,

    CONSTRAINT "mes_test_value_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "mes_key_part" (
    "id" SERIAL NOT NULL,
    "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sn_id" INTEGER NOT NULL,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64),
    "part_sn" VARCHAR(64),
    "record_id" INTEGER,
    "operator" VARCHAR(64),

    CONSTRAINT "mes_key_part_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qms_inspection" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "insp_type" VARCHAR(8) NOT NULL,
    "material_id" INTEGER NOT NULL,
    "lot_no" VARCHAR(64) NOT NULL DEFAULT '',
    "location_id" INTEGER,
    "owner_customer_id" INTEGER,
    "receipt_id" INTEGER,
    "receipt_line_id" INTEGER,
    "wo_id" INTEGER,
    "supplier_id" INTEGER,
    "lot_qty" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "aql" DOUBLE PRECISION,
    "code_letter" VARCHAR(2),
    "sample_size" INTEGER,
    "accept_num" INTEGER,
    "reject_num" INTEGER,
    "defect_qty" INTEGER NOT NULL DEFAULT 0,
    "status" VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    "inspector" VARCHAR(64),
    "inspected_at" TIMESTAMP(3),
    "result_remark" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "qms_inspection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qms_inspection_item" (
    "id" SERIAL NOT NULL,
    "inspection_id" INTEGER NOT NULL,
    "name" VARCHAR(64) NOT NULL,
    "standard" VARCHAR(256),
    "value" VARCHAR(128),
    "result" VARCHAR(8) NOT NULL DEFAULT 'PASS',

    CONSTRAINT "qms_inspection_item_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qms_ncr" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "source" VARCHAR(16) NOT NULL,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'MAJOR',
    "material_id" INTEGER,
    "lot_no" VARCHAR(64),
    "sn" VARCHAR(64),
    "wo_id" INTEGER,
    "op_seq" INTEGER,
    "op_name" VARCHAR(64),
    "inspection_id" INTEGER,
    "supplier_id" INTEGER,
    "customer_id" INTEGER,
    "qty" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "description" TEXT NOT NULL,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "disposition" VARCHAR(16),
    "disposition_remark" TEXT,
    "disposition_by" VARCHAR(64),
    "disposition_at" TIMESTAMP(3),
    "capa_id" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "qms_ncr_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "qms_capa" (
    "id" SERIAL NOT NULL,
    "no" VARCHAR(32) NOT NULL,
    "title" VARCHAR(128) NOT NULL,
    "source" VARCHAR(16) NOT NULL DEFAULT 'NCR',
    "description" TEXT,
    "root_cause" TEXT,
    "correction" TEXT,
    "corrective_action" TEXT,
    "preventive_action" TEXT,
    "owner" VARCHAR(64),
    "due_date" DATE,
    "status" VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    "effectiveness" TEXT,
    "closed_by" VARCHAR(64),
    "closed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" VARCHAR(64),

    CONSTRAINT "qms_capa_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sys_user_username_key" ON "sys_user"("username");

-- CreateIndex
CREATE INDEX "sys_audit_log_ts_idx" ON "sys_audit_log"("ts");

-- CreateIndex
CREATE INDEX "sys_audit_log_entity_entity_id_idx" ON "sys_audit_log"("entity", "entity_id");

-- CreateIndex
CREATE INDEX "sys_audit_log_username_idx" ON "sys_audit_log"("username");

-- CreateIndex
CREATE INDEX "sys_esignature_entity_entity_id_idx" ON "sys_esignature"("entity", "entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "md_customer_code_key" ON "md_customer"("code");

-- CreateIndex
CREATE UNIQUE INDEX "md_supplier_code_key" ON "md_supplier"("code");

-- CreateIndex
CREATE UNIQUE INDEX "md_material_code_key" ON "md_material"("code");

-- CreateIndex
CREATE INDEX "eng_bom_material_id_idx" ON "eng_bom"("material_id");

-- CreateIndex
CREATE INDEX "eng_bom_line_bom_id_idx" ON "eng_bom_line"("bom_id");

-- CreateIndex
CREATE UNIQUE INDEX "md_work_center_code_key" ON "md_work_center"("code");

-- CreateIndex
CREATE INDEX "eng_routing_material_id_idx" ON "eng_routing"("material_id");

-- CreateIndex
CREATE INDEX "eng_routing_op_routing_id_idx" ON "eng_routing_op"("routing_id");

-- CreateIndex
CREATE INDEX "eng_routing_param_operation_id_idx" ON "eng_routing_param"("operation_id");

-- CreateIndex
CREATE UNIQUE INDEX "md_equipment_code_key" ON "md_equipment"("code");

-- CreateIndex
CREATE INDEX "md_calibration_equipment_id_idx" ON "md_calibration"("equipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "md_warehouse_code_key" ON "md_warehouse"("code");

-- CreateIndex
CREATE UNIQUE INDEX "md_location_code_key" ON "md_location"("code");

-- CreateIndex
CREATE INDEX "md_location_warehouse_id_idx" ON "md_location"("warehouse_id");

-- CreateIndex
CREATE UNIQUE INDEX "erp_sales_order_no_key" ON "erp_sales_order"("no");

-- CreateIndex
CREATE INDEX "erp_sales_order_customer_id_idx" ON "erp_sales_order"("customer_id");

-- CreateIndex
CREATE INDEX "erp_sales_order_line_order_id_idx" ON "erp_sales_order_line"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "erp_purchase_order_no_key" ON "erp_purchase_order"("no");

-- CreateIndex
CREATE INDEX "erp_purchase_order_supplier_id_idx" ON "erp_purchase_order"("supplier_id");

-- CreateIndex
CREATE INDEX "erp_purchase_order_line_order_id_idx" ON "erp_purchase_order_line"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "erp_mrp_run_no_key" ON "erp_mrp_run"("no");

-- CreateIndex
CREATE INDEX "erp_mrp_suggestion_run_id_idx" ON "erp_mrp_suggestion"("run_id");

-- CreateIndex
CREATE UNIQUE INDEX "fin_doc_no_key" ON "fin_doc"("no");

-- CreateIndex
CREATE INDEX "fin_payment_doc_id_idx" ON "fin_payment"("doc_id");

-- CreateIndex
CREATE INDEX "wms_stock_material_id_idx" ON "wms_stock"("material_id");

-- CreateIndex
CREATE INDEX "wms_stock_location_id_idx" ON "wms_stock"("location_id");

-- CreateIndex
CREATE INDEX "wms_stock_lot_no_idx" ON "wms_stock"("lot_no");

-- CreateIndex
CREATE INDEX "wms_stock_status_idx" ON "wms_stock"("status");

-- CreateIndex
CREATE INDEX "wms_stock_move_ts_idx" ON "wms_stock_move"("ts");

-- CreateIndex
CREATE INDEX "wms_stock_move_material_id_idx" ON "wms_stock_move"("material_id");

-- CreateIndex
CREATE INDEX "wms_stock_move_lot_no_idx" ON "wms_stock_move"("lot_no");

-- CreateIndex
CREATE INDEX "wms_stock_move_ref_no_idx" ON "wms_stock_move"("ref_no");

-- CreateIndex
CREATE UNIQUE INDEX "wms_receipt_no_key" ON "wms_receipt"("no");

-- CreateIndex
CREATE INDEX "wms_receipt_line_receipt_id_idx" ON "wms_receipt_line"("receipt_id");

-- CreateIndex
CREATE INDEX "wms_receipt_line_material_id_lot_no_idx" ON "wms_receipt_line"("material_id", "lot_no");

-- CreateIndex
CREATE UNIQUE INDEX "wms_issue_no_key" ON "wms_issue"("no");

-- CreateIndex
CREATE INDEX "wms_issue_wo_id_idx" ON "wms_issue"("wo_id");

-- CreateIndex
CREATE INDEX "wms_issue_line_issue_id_idx" ON "wms_issue_line"("issue_id");

-- CreateIndex
CREATE INDEX "wms_issue_line_material_id_lot_no_idx" ON "wms_issue_line"("material_id", "lot_no");

-- CreateIndex
CREATE UNIQUE INDEX "wms_shipment_no_key" ON "wms_shipment"("no");

-- CreateIndex
CREATE INDEX "wms_shipment_so_id_idx" ON "wms_shipment"("so_id");

-- CreateIndex
CREATE INDEX "wms_shipment_line_shipment_id_idx" ON "wms_shipment_line"("shipment_id");

-- CreateIndex
CREATE UNIQUE INDEX "wms_stock_count_no_key" ON "wms_stock_count"("no");

-- CreateIndex
CREATE INDEX "wms_stock_count_line_count_id_idx" ON "wms_stock_count_line"("count_id");

-- CreateIndex
CREATE UNIQUE INDEX "mes_work_order_no_key" ON "mes_work_order"("no");

-- CreateIndex
CREATE INDEX "mes_work_order_material_id_idx" ON "mes_work_order"("material_id");

-- CreateIndex
CREATE INDEX "mes_work_order_so_id_idx" ON "mes_work_order"("so_id");

-- CreateIndex
CREATE INDEX "mes_work_order_status_idx" ON "mes_work_order"("status");

-- CreateIndex
CREATE INDEX "mes_work_order_lot_no_idx" ON "mes_work_order"("lot_no");

-- CreateIndex
CREATE INDEX "mes_wo_material_wo_id_idx" ON "mes_wo_material"("wo_id");

-- CreateIndex
CREATE INDEX "mes_wo_operation_wo_id_idx" ON "mes_wo_operation"("wo_id");

-- CreateIndex
CREATE UNIQUE INDEX "mes_serial_sn_key" ON "mes_serial"("sn");

-- CreateIndex
CREATE INDEX "mes_serial_wo_id_idx" ON "mes_serial"("wo_id");

-- CreateIndex
CREATE INDEX "mes_serial_status_idx" ON "mes_serial"("status");

-- CreateIndex
CREATE INDEX "mes_serial_lot_no_idx" ON "mes_serial"("lot_no");

-- CreateIndex
CREATE INDEX "mes_op_record_ts_idx" ON "mes_op_record"("ts");

-- CreateIndex
CREATE INDEX "mes_op_record_wo_id_idx" ON "mes_op_record"("wo_id");

-- CreateIndex
CREATE INDEX "mes_op_record_sn_id_idx" ON "mes_op_record"("sn_id");

-- CreateIndex
CREATE INDEX "mes_test_value_record_id_idx" ON "mes_test_value"("record_id");

-- CreateIndex
CREATE INDEX "mes_key_part_sn_id_idx" ON "mes_key_part"("sn_id");

-- CreateIndex
CREATE INDEX "mes_key_part_lot_no_idx" ON "mes_key_part"("lot_no");

-- CreateIndex
CREATE UNIQUE INDEX "qms_inspection_no_key" ON "qms_inspection"("no");

-- CreateIndex
CREATE INDEX "qms_inspection_status_idx" ON "qms_inspection"("status");

-- CreateIndex
CREATE INDEX "qms_inspection_material_id_lot_no_idx" ON "qms_inspection"("material_id", "lot_no");

-- CreateIndex
CREATE INDEX "qms_inspection_item_inspection_id_idx" ON "qms_inspection_item"("inspection_id");

-- CreateIndex
CREATE UNIQUE INDEX "qms_ncr_no_key" ON "qms_ncr"("no");

-- CreateIndex
CREATE INDEX "qms_ncr_sn_idx" ON "qms_ncr"("sn");

-- CreateIndex
CREATE INDEX "qms_ncr_wo_id_idx" ON "qms_ncr"("wo_id");

-- CreateIndex
CREATE INDEX "qms_ncr_status_idx" ON "qms_ncr"("status");

-- CreateIndex
CREATE UNIQUE INDEX "qms_capa_no_key" ON "qms_capa"("no");

-- AddForeignKey
ALTER TABLE "md_material" ADD CONSTRAINT "md_material_default_supplier_id_fkey" FOREIGN KEY ("default_supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "md_material" ADD CONSTRAINT "md_material_owner_customer_id_fkey" FOREIGN KEY ("owner_customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "md_material" ADD CONSTRAINT "md_material_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_bom" ADD CONSTRAINT "eng_bom_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_bom_line" ADD CONSTRAINT "eng_bom_line_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "eng_bom"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_bom_line" ADD CONSTRAINT "eng_bom_line_component_id_fkey" FOREIGN KEY ("component_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_routing" ADD CONSTRAINT "eng_routing_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_routing_op" ADD CONSTRAINT "eng_routing_op_routing_id_fkey" FOREIGN KEY ("routing_id") REFERENCES "eng_routing"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_routing_op" ADD CONSTRAINT "eng_routing_op_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "md_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_routing_op" ADD CONSTRAINT "eng_routing_op_key_part_material_id_fkey" FOREIGN KEY ("key_part_material_id") REFERENCES "md_material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "eng_routing_param" ADD CONSTRAINT "eng_routing_param_operation_id_fkey" FOREIGN KEY ("operation_id") REFERENCES "eng_routing_op"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "md_equipment" ADD CONSTRAINT "md_equipment_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "md_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "md_calibration" ADD CONSTRAINT "md_calibration_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "md_equipment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "md_location" ADD CONSTRAINT "md_location_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "md_warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_sales_order" ADD CONSTRAINT "erp_sales_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_sales_order_line" ADD CONSTRAINT "erp_sales_order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "erp_sales_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_sales_order_line" ADD CONSTRAINT "erp_sales_order_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_purchase_order" ADD CONSTRAINT "erp_purchase_order_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_purchase_order_line" ADD CONSTRAINT "erp_purchase_order_line_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "erp_purchase_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_purchase_order_line" ADD CONSTRAINT "erp_purchase_order_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_mrp_suggestion" ADD CONSTRAINT "erp_mrp_suggestion_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "erp_mrp_run"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_mrp_suggestion" ADD CONSTRAINT "erp_mrp_suggestion_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_mrp_suggestion" ADD CONSTRAINT "erp_mrp_suggestion_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "erp_mrp_suggestion" ADD CONSTRAINT "erp_mrp_suggestion_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_doc" ADD CONSTRAINT "fin_doc_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_doc" ADD CONSTRAINT "fin_doc_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "fin_payment" ADD CONSTRAINT "fin_payment_doc_id_fkey" FOREIGN KEY ("doc_id") REFERENCES "fin_doc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock" ADD CONSTRAINT "wms_stock_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock" ADD CONSTRAINT "wms_stock_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock" ADD CONSTRAINT "wms_stock_owner_customer_id_fkey" FOREIGN KEY ("owner_customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock" ADD CONSTRAINT "wms_stock_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_move" ADD CONSTRAINT "wms_stock_move_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_move" ADD CONSTRAINT "wms_stock_move_from_location_id_fkey" FOREIGN KEY ("from_location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_move" ADD CONSTRAINT "wms_stock_move_to_location_id_fkey" FOREIGN KEY ("to_location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt" ADD CONSTRAINT "wms_receipt_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt" ADD CONSTRAINT "wms_receipt_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt" ADD CONSTRAINT "wms_receipt_po_id_fkey" FOREIGN KEY ("po_id") REFERENCES "erp_purchase_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt" ADD CONSTRAINT "wms_receipt_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt_line" ADD CONSTRAINT "wms_receipt_line_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "wms_receipt"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt_line" ADD CONSTRAINT "wms_receipt_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt_line" ADD CONSTRAINT "wms_receipt_line_po_line_id_fkey" FOREIGN KEY ("po_line_id") REFERENCES "erp_purchase_order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_receipt_line" ADD CONSTRAINT "wms_receipt_line_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_issue" ADD CONSTRAINT "wms_issue_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_issue_line" ADD CONSTRAINT "wms_issue_line_issue_id_fkey" FOREIGN KEY ("issue_id") REFERENCES "wms_issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_issue_line" ADD CONSTRAINT "wms_issue_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_issue_line" ADD CONSTRAINT "wms_issue_line_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_shipment" ADD CONSTRAINT "wms_shipment_so_id_fkey" FOREIGN KEY ("so_id") REFERENCES "erp_sales_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_shipment" ADD CONSTRAINT "wms_shipment_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_shipment_line" ADD CONSTRAINT "wms_shipment_line_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "wms_shipment"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_shipment_line" ADD CONSTRAINT "wms_shipment_line_so_line_id_fkey" FOREIGN KEY ("so_line_id") REFERENCES "erp_sales_order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_shipment_line" ADD CONSTRAINT "wms_shipment_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_shipment_line" ADD CONSTRAINT "wms_shipment_line_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_count" ADD CONSTRAINT "wms_stock_count_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "md_warehouse"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_count_line" ADD CONSTRAINT "wms_stock_count_line_count_id_fkey" FOREIGN KEY ("count_id") REFERENCES "wms_stock_count"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_count_line" ADD CONSTRAINT "wms_stock_count_line_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "wms_stock_count_line" ADD CONSTRAINT "wms_stock_count_line_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_work_order" ADD CONSTRAINT "mes_work_order_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_work_order" ADD CONSTRAINT "mes_work_order_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_work_order" ADD CONSTRAINT "mes_work_order_so_id_fkey" FOREIGN KEY ("so_id") REFERENCES "erp_sales_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_work_order" ADD CONSTRAINT "mes_work_order_so_line_id_fkey" FOREIGN KEY ("so_line_id") REFERENCES "erp_sales_order_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_work_order" ADD CONSTRAINT "mes_work_order_bom_id_fkey" FOREIGN KEY ("bom_id") REFERENCES "eng_bom"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_work_order" ADD CONSTRAINT "mes_work_order_routing_id_fkey" FOREIGN KEY ("routing_id") REFERENCES "eng_routing"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_wo_material" ADD CONSTRAINT "mes_wo_material_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_wo_material" ADD CONSTRAINT "mes_wo_material_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_wo_operation" ADD CONSTRAINT "mes_wo_operation_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_wo_operation" ADD CONSTRAINT "mes_wo_operation_work_center_id_fkey" FOREIGN KEY ("work_center_id") REFERENCES "md_work_center"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_serial" ADD CONSTRAINT "mes_serial_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_serial" ADD CONSTRAINT "mes_serial_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_serial" ADD CONSTRAINT "mes_serial_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "md_location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_serial" ADD CONSTRAINT "mes_serial_shipment_id_fkey" FOREIGN KEY ("shipment_id") REFERENCES "wms_shipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_serial" ADD CONSTRAINT "mes_serial_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_op_record" ADD CONSTRAINT "mes_op_record_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_op_record" ADD CONSTRAINT "mes_op_record_sn_id_fkey" FOREIGN KEY ("sn_id") REFERENCES "mes_serial"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_op_record" ADD CONSTRAINT "mes_op_record_equipment_id_fkey" FOREIGN KEY ("equipment_id") REFERENCES "md_equipment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_test_value" ADD CONSTRAINT "mes_test_value_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "mes_op_record"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_key_part" ADD CONSTRAINT "mes_key_part_sn_id_fkey" FOREIGN KEY ("sn_id") REFERENCES "mes_serial"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_key_part" ADD CONSTRAINT "mes_key_part_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mes_key_part" ADD CONSTRAINT "mes_key_part_record_id_fkey" FOREIGN KEY ("record_id") REFERENCES "mes_op_record"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_inspection" ADD CONSTRAINT "qms_inspection_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_inspection" ADD CONSTRAINT "qms_inspection_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_inspection" ADD CONSTRAINT "qms_inspection_receipt_id_fkey" FOREIGN KEY ("receipt_id") REFERENCES "wms_receipt"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_inspection_item" ADD CONSTRAINT "qms_inspection_item_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "qms_inspection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_ncr" ADD CONSTRAINT "qms_ncr_material_id_fkey" FOREIGN KEY ("material_id") REFERENCES "md_material"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_ncr" ADD CONSTRAINT "qms_ncr_wo_id_fkey" FOREIGN KEY ("wo_id") REFERENCES "mes_work_order"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_ncr" ADD CONSTRAINT "qms_ncr_inspection_id_fkey" FOREIGN KEY ("inspection_id") REFERENCES "qms_inspection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_ncr" ADD CONSTRAINT "qms_ncr_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "md_supplier"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_ncr" ADD CONSTRAINT "qms_ncr_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "md_customer"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "qms_ncr" ADD CONSTRAINT "qms_ncr_capa_id_fkey" FOREIGN KEY ("capa_id") REFERENCES "qms_capa"("id") ON DELETE SET NULL ON UPDATE CASCADE;
