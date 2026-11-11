"""WMS：库存（按物料+库位+批次+质量状态+货主）、库存流水、入库、领料、发货、盘点。"""
from sqlalchemy.orm import relationship

from .base import *  # noqa: F401,F403
from .base import Base, IdMixin, Q, TimestampMixin
from .erp import _MaterialRef


class _LocationRef:
    @property
    def location_code(self):
        return self.location.code if self.location else None


class Stock(_MaterialRef, _LocationRef, IdMixin, Base):
    """库存余额。status: QUARANTINE(待检/待放行) / AVAILABLE(合格) / REJECTED(不合格) / HOLD(冻结)。"""

    __tablename__ = "wms_stock"
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"), index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("md_location.id"), index=True)
    lot_no: Mapped[str] = mapped_column(String(64), default="", index=True)
    status: Mapped[str] = mapped_column(String(16), default="AVAILABLE", index=True)
    owner_customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))  # 客供料货主
    qty: Mapped[float] = mapped_column(Q, default=0)
    mfg_date: Mapped[date | None] = mapped_column(Date)
    expiry_date: Mapped[date | None] = mapped_column(Date)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    supplier_lot: Mapped[str | None] = mapped_column(String(64))
    received_at: Mapped[datetime | None] = mapped_column(DateTime)

    material = relationship("Material", lazy="joined")
    location = relationship("Location", lazy="joined")
    owner_customer = relationship("Customer", lazy="joined")
    supplier = relationship("Supplier", lazy="joined")

    @property
    def warehouse_name(self):
        return self.location.warehouse.name if self.location and self.location.warehouse else None

    @property
    def owner_customer_name(self):
        return self.owner_customer.name if self.owner_customer else None

    @property
    def supplier_name(self):
        return self.supplier.name if self.supplier else None

    @property
    def unit_cost(self):
        return self.material.std_cost if self.material else 0

    @property
    def amount(self):
        return round((self.qty or 0) * (self.unit_cost or 0), 2)


class StockMove(_MaterialRef, IdMixin, Base):
    """库存流水（只增不改）。"""

    __tablename__ = "wms_stock_move"
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    # PO_RECEIPT/CS_RECEIPT/OTHER_RECEIPT/OPENING/IQC_RELEASE/IQC_REJECT/WO_ISSUE/WO_RETURN/FG_RECEIPT/
    # FG_RELEASE/SHIPMENT/TRANSFER/ADJUST/SCRAP/RETURN_SUPPLIER/STATUS_CHANGE
    move_type: Mapped[str] = mapped_column(String(20), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"), index=True)
    lot_no: Mapped[str] = mapped_column(String(64), default="", index=True)
    qty: Mapped[float] = mapped_column(Q)
    from_location_id: Mapped[int | None] = mapped_column(ForeignKey("md_location.id"))
    to_location_id: Mapped[int | None] = mapped_column(ForeignKey("md_location.id"))
    from_status: Mapped[str | None] = mapped_column(String(16))
    to_status: Mapped[str | None] = mapped_column(String(16))
    owner_customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    ref_type: Mapped[str | None] = mapped_column(String(32), index=True)
    ref_id: Mapped[int | None] = mapped_column(Integer, index=True)
    ref_no: Mapped[str | None] = mapped_column(String(32), index=True)
    username: Mapped[str | None] = mapped_column(String(64))
    remark: Mapped[str | None] = mapped_column(String(256))

    material = relationship("Material", lazy="joined")
    from_location = relationship("Location", foreign_keys=[from_location_id], lazy="joined")
    to_location = relationship("Location", foreign_keys=[to_location_id], lazy="joined")

    @property
    def from_location_code(self):
        return self.from_location.code if self.from_location else None

    @property
    def to_location_code(self):
        return self.to_location.code if self.to_location else None


class Receipt(IdMixin, TimestampMixin, Base):
    __tablename__ = "wms_receipt"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    receipt_type: Mapped[str] = mapped_column(String(20))  # PURCHASE/CUSTOMER_SUPPLIED/PRODUCTION/OPENING/OTHER
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    po_id: Mapped[int | None] = mapped_column(ForeignKey("erp_purchase_order.id"))
    wo_id: Mapped[int | None] = mapped_column(ForeignKey("mes_work_order.id"))
    status: Mapped[str] = mapped_column(String(16), default="CONFIRMED")
    receipt_date: Mapped[date] = mapped_column(Date)
    delivery_note: Mapped[str | None] = mapped_column(String(64))  # 送货单号
    remark: Mapped[str | None] = mapped_column(Text)

    supplier = relationship("Supplier", lazy="joined")
    customer = relationship("Customer", lazy="joined")
    purchase_order = relationship("PurchaseOrder", lazy="joined")
    work_order = relationship("WorkOrder", lazy="joined")
    lines = relationship("ReceiptLine", cascade="all, delete-orphan", order_by="ReceiptLine.line_no", lazy="selectin")

    @property
    def partner_name(self):
        if self.supplier:
            return self.supplier.name
        return self.customer.name if self.customer else None

    @property
    def po_no(self):
        return self.purchase_order.no if self.purchase_order else None

    @property
    def wo_no(self):
        return self.work_order.no if self.work_order else None


class ReceiptLine(_MaterialRef, _LocationRef, IdMixin, Base):
    __tablename__ = "wms_receipt_line"
    receipt_id: Mapped[int] = mapped_column(ForeignKey("wms_receipt.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer, default=1)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    po_line_id: Mapped[int | None] = mapped_column(ForeignKey("erp_purchase_order_line.id"))
    qty: Mapped[float] = mapped_column(Q)
    lot_no: Mapped[str] = mapped_column(String(64), default="")
    supplier_lot: Mapped[str | None] = mapped_column(String(64))
    location_id: Mapped[int] = mapped_column(ForeignKey("md_location.id"))
    status: Mapped[str] = mapped_column(String(16), default="QUARANTINE")
    mfg_date: Mapped[date | None] = mapped_column(Date)
    expiry_date: Mapped[date | None] = mapped_column(Date)
    inspection_id: Mapped[int | None] = mapped_column(Integer)

    material = relationship("Material", lazy="joined")
    location = relationship("Location", lazy="joined")


class MaterialIssue(IdMixin, TimestampMixin, Base):
    """生产领料单：系统按 FEFO/FIFO 自动推荐批次，只允许领用合格(AVAILABLE)库存，客供料只能用于对应客户工单。"""

    __tablename__ = "wms_issue"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    wo_id: Mapped[int] = mapped_column(ForeignKey("mes_work_order.id"), index=True)
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT/CONFIRMED/CANCELLED
    confirmed_by: Mapped[str | None] = mapped_column(String(64))
    confirmed_at: Mapped[datetime | None] = mapped_column(DateTime)
    remark: Mapped[str | None] = mapped_column(Text)

    work_order = relationship("WorkOrder", lazy="joined")
    lines = relationship("MaterialIssueLine", cascade="all, delete-orphan", order_by="MaterialIssueLine.id", lazy="selectin")

    @property
    def wo_no(self):
        return self.work_order.no if self.work_order else None


class MaterialIssueLine(_MaterialRef, _LocationRef, IdMixin, Base):
    __tablename__ = "wms_issue_line"
    issue_id: Mapped[int] = mapped_column(ForeignKey("wms_issue.id", ondelete="CASCADE"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"), index=True)
    lot_no: Mapped[str] = mapped_column(String(64), default="", index=True)
    location_id: Mapped[int] = mapped_column(ForeignKey("md_location.id"))
    owner_customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    qty: Mapped[float] = mapped_column(Q)
    expiry_date: Mapped[date | None] = mapped_column(Date)

    material = relationship("Material", lazy="joined")
    location = relationship("Location", lazy="joined")


class Shipment(IdMixin, TimestampMixin, Base):
    __tablename__ = "wms_shipment"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    so_id: Mapped[int | None] = mapped_column(ForeignKey("erp_sales_order.id"), index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("md_customer.id"))
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT/SHIPPED/CANCELLED
    ship_date: Mapped[date | None] = mapped_column(Date)
    carrier: Mapped[str | None] = mapped_column(String(64))
    tracking_no: Mapped[str | None] = mapped_column(String(64))
    ship_to: Mapped[str | None] = mapped_column(String(256))
    shipped_by: Mapped[str | None] = mapped_column(String(64))
    remark: Mapped[str | None] = mapped_column(Text)

    customer = relationship("Customer", lazy="joined")
    sales_order = relationship("SalesOrder", lazy="joined")
    lines = relationship("ShipmentLine", cascade="all, delete-orphan", order_by="ShipmentLine.id", lazy="selectin")

    @property
    def customer_name(self):
        return self.customer.name if self.customer else None

    @property
    def so_no(self):
        return self.sales_order.no if self.sales_order else None


class ShipmentLine(_MaterialRef, _LocationRef, IdMixin, Base):
    __tablename__ = "wms_shipment_line"
    shipment_id: Mapped[int] = mapped_column(ForeignKey("wms_shipment.id", ondelete="CASCADE"), index=True)
    so_line_id: Mapped[int | None] = mapped_column(ForeignKey("erp_sales_order_line.id"))
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    lot_no: Mapped[str] = mapped_column(String(64), default="")
    location_id: Mapped[int] = mapped_column(ForeignKey("md_location.id"))
    qty: Mapped[float] = mapped_column(Q)
    serials: Mapped[str | None] = mapped_column(Text)  # JSON 数组

    material = relationship("Material", lazy="joined")
    location = relationship("Location", lazy="joined")

    @property
    def serial_list(self) -> list[str]:
        import json

        return json.loads(self.serials) if self.serials else []


class StockCount(IdMixin, TimestampMixin, Base):
    __tablename__ = "wms_stock_count"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("md_warehouse.id"))
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN/POSTED/CANCELLED
    posted_by: Mapped[str | None] = mapped_column(String(64))
    posted_at: Mapped[datetime | None] = mapped_column(DateTime)
    remark: Mapped[str | None] = mapped_column(Text)

    warehouse = relationship("Warehouse", lazy="joined")
    lines = relationship("StockCountLine", cascade="all, delete-orphan", order_by="StockCountLine.id", lazy="selectin")

    @property
    def warehouse_name(self):
        return self.warehouse.name if self.warehouse else None


class StockCountLine(_MaterialRef, _LocationRef, IdMixin, Base):
    __tablename__ = "wms_stock_count_line"
    count_id: Mapped[int] = mapped_column(ForeignKey("wms_stock_count.id", ondelete="CASCADE"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    location_id: Mapped[int] = mapped_column(ForeignKey("md_location.id"))
    lot_no: Mapped[str] = mapped_column(String(64), default="")
    status: Mapped[str] = mapped_column(String(16), default="AVAILABLE")
    owner_customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    system_qty: Mapped[float] = mapped_column(Q, default=0)
    counted_qty: Mapped[float | None] = mapped_column(Q)

    material = relationship("Material", lazy="joined")
    location = relationship("Location", lazy="joined")

    @property
    def diff_qty(self):
        return None if self.counted_qty is None else round(self.counted_qty - self.system_qty, 4)
