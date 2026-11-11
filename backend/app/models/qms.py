"""QMS：检验（IQC/FQC/OQC）、不合格品(NCR)、纠正预防措施(CAPA)。"""
from sqlalchemy.orm import relationship

from .base import *  # noqa: F401,F403
from .base import Base, IdMixin, Q, TimestampMixin
from .erp import _MaterialRef


class Inspection(_MaterialRef, IdMixin, TimestampMixin, Base):
    __tablename__ = "qms_inspection"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    insp_type: Mapped[str] = mapped_column(String(8), index=True)  # IQC/IPQC/FQC/OQC
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    lot_no: Mapped[str] = mapped_column(String(64), default="")
    location_id: Mapped[int | None] = mapped_column(ForeignKey("md_location.id"))
    owner_customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    receipt_id: Mapped[int | None] = mapped_column(ForeignKey("wms_receipt.id"))
    receipt_line_id: Mapped[int | None] = mapped_column(ForeignKey("wms_receipt_line.id"))
    wo_id: Mapped[int | None] = mapped_column(ForeignKey("mes_work_order.id"))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    lot_qty: Mapped[float] = mapped_column(Q, default=0)
    aql: Mapped[float | None] = mapped_column(Q)
    code_letter: Mapped[str | None] = mapped_column(String(2))
    sample_size: Mapped[int | None] = mapped_column(Integer)
    accept_num: Mapped[int | None] = mapped_column(Integer)
    reject_num: Mapped[int | None] = mapped_column(Integer)
    defect_qty: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", index=True)  # PENDING/PASSED/REJECTED/CONCESSION
    inspector: Mapped[str | None] = mapped_column(String(64))
    inspected_at: Mapped[datetime | None] = mapped_column(DateTime)
    result_remark: Mapped[str | None] = mapped_column(Text)

    material = relationship("Material", lazy="joined")
    supplier = relationship("Supplier", lazy="joined")
    items = relationship("InspectionItem", cascade="all, delete-orphan", lazy="selectin", order_by="InspectionItem.id")

    @property
    def supplier_name(self):
        return self.supplier.name if self.supplier else None


class InspectionItem(IdMixin, Base):
    __tablename__ = "qms_inspection_item"
    inspection_id: Mapped[int] = mapped_column(ForeignKey("qms_inspection.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(64))
    standard: Mapped[str | None] = mapped_column(String(256))
    value: Mapped[str | None] = mapped_column(String(128))
    result: Mapped[str] = mapped_column(String(8), default="PASS")


class Ncr(_MaterialRef, IdMixin, TimestampMixin, Base):
    __tablename__ = "qms_ncr"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    source: Mapped[str] = mapped_column(String(16))  # IQC/PROCESS/FQC/CUSTOMER/OTHER
    severity: Mapped[str] = mapped_column(String(16), default="MAJOR")  # MINOR/MAJOR/CRITICAL
    material_id: Mapped[int | None] = mapped_column(ForeignKey("md_material.id"))
    lot_no: Mapped[str | None] = mapped_column(String(64))
    sn: Mapped[str | None] = mapped_column(String(64), index=True)
    wo_id: Mapped[int | None] = mapped_column(ForeignKey("mes_work_order.id"), index=True)
    op_seq: Mapped[int | None] = mapped_column(Integer)  # 过程不合格发生的工序
    op_name: Mapped[str | None] = mapped_column(String(64))
    inspection_id: Mapped[int | None] = mapped_column(ForeignKey("qms_inspection.id"))
    supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    qty: Mapped[float] = mapped_column(Q, default=1)
    description: Mapped[str] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="OPEN", index=True)  # OPEN/DISPOSITIONED/CLOSED
    disposition: Mapped[str | None] = mapped_column(String(16))  # REWORK/SCRAP/USE_AS_IS/RETURN
    disposition_remark: Mapped[str | None] = mapped_column(Text)
    disposition_by: Mapped[str | None] = mapped_column(String(64))
    disposition_at: Mapped[datetime | None] = mapped_column(DateTime)
    capa_id: Mapped[int | None] = mapped_column(ForeignKey("qms_capa.id"))

    material = relationship("Material", lazy="joined")
    work_order = relationship("WorkOrder", lazy="joined")
    supplier = relationship("Supplier", lazy="joined")

    @property
    def wo_no(self):
        return self.work_order.no if self.work_order else None

    @property
    def supplier_name(self):
        return self.supplier.name if self.supplier else None


class Capa(IdMixin, TimestampMixin, Base):
    __tablename__ = "qms_capa"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(128))
    source: Mapped[str] = mapped_column(String(16), default="NCR")  # NCR/COMPLAINT/AUDIT/OTHER
    description: Mapped[str | None] = mapped_column(Text)
    root_cause: Mapped[str | None] = mapped_column(Text)
    correction: Mapped[str | None] = mapped_column(Text)
    corrective_action: Mapped[str | None] = mapped_column(Text)
    preventive_action: Mapped[str | None] = mapped_column(Text)
    owner: Mapped[str | None] = mapped_column(String(64))
    due_date: Mapped[date | None] = mapped_column(Date)
    status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN/IN_PROGRESS/VERIFYING/CLOSED
    effectiveness: Mapped[str | None] = mapped_column(Text)
    closed_by: Mapped[str | None] = mapped_column(String(64))
    closed_at: Mapped[datetime | None] = mapped_column(DateTime)
