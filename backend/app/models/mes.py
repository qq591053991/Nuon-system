"""MES：生产工单、工序、序列号/UDI、过站报工、测试数据、关键件绑定（构成电子 DHR）。"""
from sqlalchemy.orm import relationship

from .base import *  # noqa: F401,F403
from .base import Base, IdMixin, Q, TimestampMixin
from .erp import _MaterialRef


class WorkOrder(_MaterialRef, IdMixin, TimestampMixin, Base):
    __tablename__ = "mes_work_order"
    no: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"), index=True)
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    so_id: Mapped[int | None] = mapped_column(ForeignKey("erp_sales_order.id"), index=True)
    so_line_id: Mapped[int | None] = mapped_column(ForeignKey("erp_sales_order_line.id"))
    bom_id: Mapped[int | None] = mapped_column(ForeignKey("eng_bom.id"))
    routing_id: Mapped[int | None] = mapped_column(ForeignKey("eng_routing.id"))
    planned_qty: Mapped[float] = mapped_column(Q)
    completed_qty: Mapped[float] = mapped_column(Q, default=0)
    scrap_qty: Mapped[float] = mapped_column(Q, default=0)
    received_qty: Mapped[float] = mapped_column(Q, default=0)  # 已完工入库
    lot_no: Mapped[str | None] = mapped_column(String(64), index=True)  # 生产批号
    planned_start: Mapped[date | None] = mapped_column(Date)
    planned_end: Mapped[date | None] = mapped_column(Date)
    actual_start: Mapped[datetime | None] = mapped_column(DateTime)
    actual_end: Mapped[datetime | None] = mapped_column(DateTime)
    # PLANNED/RELEASED/IN_PROGRESS/COMPLETED/CLOSED/CANCELLED
    status: Mapped[str] = mapped_column(String(16), default="PLANNED", index=True)
    dhr_status: Mapped[str] = mapped_column(String(16), default="OPEN")  # OPEN/RELEASED/REJECTED
    released_by: Mapped[str | None] = mapped_column(String(64))
    priority: Mapped[int] = mapped_column(Integer, default=3)
    source: Mapped[str | None] = mapped_column(String(64))
    remark: Mapped[str | None] = mapped_column(Text)

    material = relationship("Material", lazy="joined")
    customer = relationship("Customer", lazy="joined")
    sales_order = relationship("SalesOrder", lazy="joined")
    bom = relationship("Bom", lazy="joined")
    routing = relationship("Routing", lazy="joined")
    materials = relationship("WorkOrderMaterial", cascade="all, delete-orphan", order_by="WorkOrderMaterial.id", lazy="selectin")
    operations = relationship("WorkOrderOperation", cascade="all, delete-orphan", order_by="WorkOrderOperation.seq", lazy="selectin")

    @property
    def customer_name(self):
        return self.customer.name if self.customer else None

    @property
    def so_no(self):
        return self.sales_order.no if self.sales_order else None

    @property
    def bom_version(self):
        return self.bom.version if self.bom else None

    @property
    def routing_version(self):
        return self.routing.version if self.routing else None

    @property
    def serial_control(self):
        return bool(self.material and self.material.serial_control)

    @property
    def progress(self):
        if not self.planned_qty:
            return 0
        return round(min(1.0, (self.completed_qty or 0) / self.planned_qty) * 100, 1)


class WorkOrderMaterial(_MaterialRef, IdMixin, Base):
    __tablename__ = "mes_wo_material"
    wo_id: Mapped[int] = mapped_column(ForeignKey("mes_work_order.id", ondelete="CASCADE"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    qty_per: Mapped[float] = mapped_column(Q, default=1)
    required_qty: Mapped[float] = mapped_column(Q, default=0)
    issued_qty: Mapped[float] = mapped_column(Q, default=0)

    material = relationship("Material", lazy="joined")

    @property
    def customer_supplied(self):
        return bool(self.material and self.material.owner_customer_id)


class WorkOrderOperation(IdMixin, Base):
    """工单工序（下达时从工艺路线快照，之后工艺变更不影响已下达工单）。"""

    __tablename__ = "mes_wo_operation"
    wo_id: Mapped[int] = mapped_column(ForeignKey("mes_work_order.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(64))
    op_type: Mapped[str] = mapped_column(String(16))
    work_center_id: Mapped[int | None] = mapped_column(ForeignKey("md_work_center.id"))
    requires_equipment: Mapped[bool] = mapped_column(Boolean, default=False)
    key_part_material_id: Mapped[int | None] = mapped_column(ForeignKey("md_material.id"))
    sop_no: Mapped[str | None] = mapped_column(String(64))
    instructions: Mapped[str | None] = mapped_column(Text)
    params_json: Mapped[str | None] = mapped_column(Text)
    good_qty: Mapped[float] = mapped_column(Q, default=0)
    ng_qty: Mapped[float] = mapped_column(Q, default=0)

    work_center = relationship("WorkCenter", lazy="joined")

    @property
    def work_center_name(self):
        return self.work_center.name if self.work_center else None

    @property
    def params(self) -> list[dict]:
        import json

        return json.loads(self.params_json) if self.params_json else []


class SerialNumber(_MaterialRef, IdMixin, TimestampMixin, Base):
    """产品序列号。status: CREATED/IN_PROCESS/NG/COMPLETED/IN_STOCK/SHIPPED/SCRAPPED"""

    __tablename__ = "mes_serial"
    sn: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    wo_id: Mapped[int] = mapped_column(ForeignKey("mes_work_order.id"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    lot_no: Mapped[str | None] = mapped_column(String(64), index=True)
    udi: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="CREATED", index=True)
    last_seq: Mapped[int] = mapped_column(Integer, default=0)  # 已通过的最后工序号
    ng_seq: Mapped[int | None] = mapped_column(Integer)
    location_id: Mapped[int | None] = mapped_column(ForeignKey("md_location.id"))
    shipment_id: Mapped[int | None] = mapped_column(ForeignKey("wms_shipment.id"))
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime)
    shipped_at: Mapped[datetime | None] = mapped_column(DateTime)

    material = relationship("Material", lazy="joined")
    work_order = relationship("WorkOrder", lazy="joined")

    @property
    def wo_no(self):
        return self.work_order.no if self.work_order else None


class OperationRecord(IdMixin, Base):
    """过站/报工记录：谁、何时、在哪台设备上完成了哪道工序，结果如何。"""

    __tablename__ = "mes_op_record"
    ts: Mapped[datetime] = mapped_column(DateTime, index=True)
    wo_id: Mapped[int] = mapped_column(ForeignKey("mes_work_order.id"), index=True)
    sn_id: Mapped[int | None] = mapped_column(ForeignKey("mes_serial.id"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    op_code: Mapped[str] = mapped_column(String(32))
    op_name: Mapped[str] = mapped_column(String(64))
    result: Mapped[str] = mapped_column(String(8))  # PASS/FAIL
    qty: Mapped[float] = mapped_column(Q, default=1)
    operator: Mapped[str] = mapped_column(String(64))
    operator_name: Mapped[str | None] = mapped_column(String(64))
    equipment_id: Mapped[int | None] = mapped_column(ForeignKey("md_equipment.id"))
    is_rework: Mapped[bool] = mapped_column(Boolean, default=False)
    remark: Mapped[str | None] = mapped_column(String(256))

    serial = relationship("SerialNumber", lazy="joined")
    equipment = relationship("Equipment", lazy="joined")
    values = relationship("TestValue", cascade="all, delete-orphan", lazy="selectin", order_by="TestValue.id")

    @property
    def sn(self):
        return self.serial.sn if self.serial else None

    @property
    def equipment_code(self):
        return self.equipment.code if self.equipment else None


class TestValue(IdMixin, Base):
    __tablename__ = "mes_test_value"
    record_id: Mapped[int] = mapped_column(ForeignKey("mes_op_record.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(64))
    unit: Mapped[str | None] = mapped_column(String(16))
    value: Mapped[float | None] = mapped_column(Q)
    lower: Mapped[float | None] = mapped_column(Q)
    upper: Mapped[float | None] = mapped_column(Q)
    result: Mapped[str] = mapped_column(String(8))


class KeyPartBinding(_MaterialRef, IdMixin, Base):
    """关键件绑定（如医用电源适配器序列号、LED灯板批次）→ 单台追溯。"""

    __tablename__ = "mes_key_part"
    ts: Mapped[datetime] = mapped_column(DateTime)
    sn_id: Mapped[int] = mapped_column(ForeignKey("mes_serial.id"), index=True)
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    lot_no: Mapped[str | None] = mapped_column(String(64), index=True)
    part_sn: Mapped[str | None] = mapped_column(String(64), index=True)
    record_id: Mapped[int | None] = mapped_column(ForeignKey("mes_op_record.id"))
    operator: Mapped[str | None] = mapped_column(String(64))

    material = relationship("Material", lazy="joined")
