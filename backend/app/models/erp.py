"""ERP：销售、采购、MRP、应收应付。"""
from sqlalchemy.orm import relationship

from .base import *  # noqa: F401,F403
from .base import Base, IdMixin, Q, TimestampMixin


class _MaterialRef:
    @property
    def material_code(self):
        return self.material.code if self.material else None

    @property
    def material_name(self):
        return self.material.name if self.material else None

    @property
    def material_spec(self):
        return self.material.spec if self.material else None

    @property
    def uom(self):
        return self.material.uom if self.material else None


class SalesOrder(IdMixin, TimestampMixin, Base):
    __tablename__ = "erp_sales_order"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    customer_id: Mapped[int] = mapped_column(ForeignKey("md_customer.id"), index=True)
    order_date: Mapped[date] = mapped_column(Date)
    delivery_date: Mapped[date | None] = mapped_column(Date)
    customer_po: Mapped[str | None] = mapped_column(String(64))
    # DRAFT/CONFIRMED/IN_PRODUCTION/PARTIAL_SHIPPED/SHIPPED/CLOSED/CANCELLED
    status: Mapped[str] = mapped_column(String(20), default="DRAFT")
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    total_amount: Mapped[float] = mapped_column(Q, default=0)
    ship_to: Mapped[str | None] = mapped_column(String(256))
    remark: Mapped[str | None] = mapped_column(Text)

    customer = relationship("Customer", lazy="joined")
    lines = relationship("SalesOrderLine", cascade="all, delete-orphan", order_by="SalesOrderLine.line_no", lazy="selectin")

    @property
    def customer_name(self):
        return self.customer.name if self.customer else None


class SalesOrderLine(_MaterialRef, IdMixin, Base):
    __tablename__ = "erp_sales_order_line"
    order_id: Mapped[int] = mapped_column(ForeignKey("erp_sales_order.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer, default=1)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    qty: Mapped[float] = mapped_column(Q)
    unit_price: Mapped[float] = mapped_column(Q, default=0)
    amount: Mapped[float] = mapped_column(Q, default=0)
    shipped_qty: Mapped[float] = mapped_column(Q, default=0)
    delivery_date: Mapped[date | None] = mapped_column(Date)
    remark: Mapped[str | None] = mapped_column(String(256))

    material = relationship("Material", lazy="joined")


class PurchaseOrder(IdMixin, TimestampMixin, Base):
    __tablename__ = "erp_purchase_order"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    supplier_id: Mapped[int] = mapped_column(ForeignKey("md_supplier.id"), index=True)
    order_date: Mapped[date] = mapped_column(Date)
    expected_date: Mapped[date | None] = mapped_column(Date)
    # DRAFT/APPROVED/PARTIAL_RECEIVED/RECEIVED/CLOSED/CANCELLED
    status: Mapped[str] = mapped_column(String(20), default="DRAFT")
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    total_amount: Mapped[float] = mapped_column(Q, default=0)
    approved_by: Mapped[str | None] = mapped_column(String(64))
    approved_at: Mapped[datetime | None] = mapped_column(DateTime)
    source: Mapped[str | None] = mapped_column(String(64))  # 如 MRP 运算单号
    remark: Mapped[str | None] = mapped_column(Text)

    supplier = relationship("Supplier", lazy="joined")
    lines = relationship("PurchaseOrderLine", cascade="all, delete-orphan", order_by="PurchaseOrderLine.line_no", lazy="selectin")

    @property
    def supplier_name(self):
        return self.supplier.name if self.supplier else None


class PurchaseOrderLine(_MaterialRef, IdMixin, Base):
    __tablename__ = "erp_purchase_order_line"
    order_id: Mapped[int] = mapped_column(ForeignKey("erp_purchase_order.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer, default=1)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    qty: Mapped[float] = mapped_column(Q)
    unit_price: Mapped[float] = mapped_column(Q, default=0)
    amount: Mapped[float] = mapped_column(Q, default=0)
    received_qty: Mapped[float] = mapped_column(Q, default=0)
    expected_date: Mapped[date | None] = mapped_column(Date)
    remark: Mapped[str | None] = mapped_column(String(256))

    material = relationship("Material", lazy="joined")


class MrpRun(IdMixin, TimestampMixin, Base):
    __tablename__ = "erp_mrp_run"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    run_at: Mapped[datetime] = mapped_column(DateTime)
    run_by: Mapped[str | None] = mapped_column(String(64))
    summary: Mapped[str | None] = mapped_column(Text)
    suggestions = relationship("MrpSuggestion", cascade="all, delete-orphan", order_by="MrpSuggestion.level", lazy="selectin")


class MrpSuggestion(_MaterialRef, IdMixin, Base):
    __tablename__ = "erp_mrp_suggestion"
    run_id: Mapped[int] = mapped_column(ForeignKey("erp_mrp_run.id", ondelete="CASCADE"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    level: Mapped[int] = mapped_column(Integer, default=0)
    action: Mapped[str] = mapped_column(String(20))  # PURCHASE/PRODUCE/CUSTOMER_SUPPLY
    gross_qty: Mapped[float] = mapped_column(Q, default=0)
    on_hand_qty: Mapped[float] = mapped_column(Q, default=0)
    on_order_qty: Mapped[float] = mapped_column(Q, default=0)
    safety_stock: Mapped[float] = mapped_column(Q, default=0)
    net_qty: Mapped[float] = mapped_column(Q, default=0)
    suggested_qty: Mapped[float] = mapped_column(Q, default=0)
    due_date: Mapped[date | None] = mapped_column(Date)
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN/CONVERTED/IGNORED
    converted_doc_no: Mapped[str | None] = mapped_column(String(32))
    remark: Mapped[str | None] = mapped_column(String(256))

    material = relationship("Material", lazy="joined")
    supplier = relationship("Supplier", lazy="joined")
    customer = relationship("Customer", lazy="joined")

    @property
    def supplier_name(self):
        return self.supplier.name if self.supplier else None

    @property
    def customer_name(self):
        return self.customer.name if self.customer else None


class FinanceDoc(IdMixin, TimestampMixin, Base):
    """应收(AR)/应付(AP)单据：发货自动生成应收，采购入库自动生成应付。"""

    __tablename__ = "fin_doc"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    doc_type: Mapped[str] = mapped_column(String(4))  # AR/AP
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    ref_type: Mapped[str | None] = mapped_column(String(32))
    ref_no: Mapped[str | None] = mapped_column(String(32))
    doc_date: Mapped[date] = mapped_column(Date)
    due_date: Mapped[date | None] = mapped_column(Date)
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    amount: Mapped[float] = mapped_column(Q, default=0)
    paid_amount: Mapped[float] = mapped_column(Q, default=0)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN/PARTIAL/PAID
    remark: Mapped[str | None] = mapped_column(Text)

    customer = relationship("Customer", lazy="joined")
    supplier = relationship("Supplier", lazy="joined")
    payments = relationship("Payment", cascade="all, delete-orphan", lazy="selectin", order_by="Payment.id")

    @property
    def partner_name(self):
        if self.customer:
            return self.customer.name
        return self.supplier.name if self.supplier else None

    @property
    def balance(self):
        return round((self.amount or 0) - (self.paid_amount or 0), 4)


class Payment(IdMixin, TimestampMixin, Base):
    __tablename__ = "fin_payment"
    doc_id: Mapped[int] = mapped_column(ForeignKey("fin_doc.id", ondelete="CASCADE"), index=True)
    pay_date: Mapped[date] = mapped_column(Date)
    amount: Mapped[float] = mapped_column(Q)
    method: Mapped[str | None] = mapped_column(String(32))
    reference: Mapped[str | None] = mapped_column(String(64))
    remark: Mapped[str | None] = mapped_column(String(256))
