"""主数据与工程数据：客户、供应商、物料、BOM、工艺路线、工作中心、设备、仓库库位。"""
from sqlalchemy.orm import relationship

from .base import *  # noqa: F401,F403
from .base import Base, IdMixin, Q, TimestampMixin


class Customer(IdMixin, TimestampMixin, Base):
    """客户 = 品牌方 / 医疗器械注册人（MAH）。代工模式下产品注册证属于客户。"""

    __tablename__ = "md_customer"
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    short_name: Mapped[str | None] = mapped_column(String(64))
    country: Mapped[str | None] = mapped_column(String(32))
    contact: Mapped[str | None] = mapped_column(String(64))
    phone: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(128))
    address: Mapped[str | None] = mapped_column(String(256))
    mah_name: Mapped[str | None] = mapped_column(String(128))  # 注册人/备案人名称
    tax_no: Mapped[str | None] = mapped_column(String(64))
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30)
    quality_agreement_no: Mapped[str | None] = mapped_column(String(64))  # 质量协议编号
    quality_agreement_expiry: Mapped[date | None] = mapped_column(Date)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    remark: Mapped[str | None] = mapped_column(Text)


class Supplier(IdMixin, TimestampMixin, Base):
    """供应商 / 合格供方名录。只有“合格”且资质未过期的供应商才能审批采购订单。"""

    __tablename__ = "md_supplier"
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    short_name: Mapped[str | None] = mapped_column(String(64))
    category: Mapped[str | None] = mapped_column(String(64))  # LED芯片/PCB/电源/结构件/包材...
    contact: Mapped[str | None] = mapped_column(String(64))
    phone: Mapped[str | None] = mapped_column(String(32))
    email: Mapped[str | None] = mapped_column(String(128))
    address: Mapped[str | None] = mapped_column(String(256))
    status: Mapped[str] = mapped_column(String(16), default="PENDING")  # QUALIFIED/PENDING/SUSPENDED/DISQUALIFIED
    qualification_expiry: Mapped[date | None] = mapped_column(Date)
    iso13485: Mapped[bool] = mapped_column(Boolean, default=False)
    currency: Mapped[str] = mapped_column(String(8), default="CNY")
    payment_terms_days: Mapped[int] = mapped_column(Integer, default=30)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    remark: Mapped[str | None] = mapped_column(Text)


class Material(IdMixin, TimestampMixin, Base):
    """物料主数据（原材料/半成品/成品/包材统一编码）。"""

    __tablename__ = "md_material"
    code: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(128))
    spec: Mapped[str | None] = mapped_column(String(256))
    category: Mapped[str] = mapped_column(String(16), default="RAW")  # RAW/SEMI/FINISHED/PACKAGING/CONSUMABLE
    uom: Mapped[str] = mapped_column(String(16), default="PCS")
    lot_control: Mapped[bool] = mapped_column(Boolean, default=True)
    serial_control: Mapped[bool] = mapped_column(Boolean, default=False)
    shelf_life_days: Mapped[int | None] = mapped_column(Integer)
    safety_stock: Mapped[float] = mapped_column(Q, default=0)
    lead_time_days: Mapped[int] = mapped_column(Integer, default=7)
    min_order_qty: Mapped[float] = mapped_column(Q, default=0)
    std_cost: Mapped[float] = mapped_column(Q, default=0)
    default_supplier_id: Mapped[int | None] = mapped_column(ForeignKey("md_supplier.id"))
    owner_customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))  # 非空 = 客供料
    customer_id: Mapped[int | None] = mapped_column(ForeignKey("md_customer.id"))  # 成品所属品牌客户
    iqc_required: Mapped[bool] = mapped_column(Boolean, default=True)
    aql: Mapped[float] = mapped_column(Q, default=1.0)
    # 光疗/电子物料特性
    wavelength_nm: Mapped[str | None] = mapped_column(String(64))  # 如 630/660/850
    msl_level: Mapped[str | None] = mapped_column(String(8))  # 湿敏等级
    esd_sensitive: Mapped[bool] = mapped_column(Boolean, default=False)
    # 成品注册/UDI 信息
    model: Mapped[str | None] = mapped_column(String(64))
    registration_no: Mapped[str | None] = mapped_column(String(64))  # 注册证/备案号
    device_class: Mapped[str | None] = mapped_column(String(8))  # I/II/III
    gtin: Mapped[str | None] = mapped_column(String(14))  # UDI-DI (GS1 GTIN-14)
    sn_prefix: Mapped[str | None] = mapped_column(String(16))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    remark: Mapped[str | None] = mapped_column(Text)

    default_supplier = relationship("Supplier", lazy="joined")
    owner_customer = relationship("Customer", foreign_keys=[owner_customer_id], lazy="joined")
    customer = relationship("Customer", foreign_keys=[customer_id], lazy="joined")

    @property
    def default_supplier_name(self):
        return self.default_supplier.name if self.default_supplier else None

    @property
    def owner_customer_name(self):
        return self.owner_customer.name if self.owner_customer else None

    @property
    def customer_name(self):
        return self.customer.name if self.customer else None


class Bom(IdMixin, TimestampMixin, Base):
    """物料清单（受控文件：草稿可编辑，发布需电子签名，发布后只能升版）。"""

    __tablename__ = "eng_bom"
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"), index=True)
    version: Mapped[str] = mapped_column(String(16), default="A0")
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")  # DRAFT/RELEASED/OBSOLETE
    ecn_no: Mapped[str | None] = mapped_column(String(64))
    effective_date: Mapped[date | None] = mapped_column(Date)
    released_by: Mapped[str | None] = mapped_column(String(64))
    released_at: Mapped[datetime | None] = mapped_column(DateTime)
    remark: Mapped[str | None] = mapped_column(Text)

    material = relationship("Material", lazy="joined")
    lines = relationship("BomLine", cascade="all, delete-orphan", order_by="BomLine.line_no", lazy="selectin")

    @property
    def material_code(self):
        return self.material.code if self.material else None

    @property
    def material_name(self):
        return self.material.name if self.material else None


class BomLine(IdMixin, Base):
    __tablename__ = "eng_bom_line"
    bom_id: Mapped[int] = mapped_column(ForeignKey("eng_bom.id", ondelete="CASCADE"), index=True)
    line_no: Mapped[int] = mapped_column(Integer, default=10)
    component_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"))
    qty_per: Mapped[float] = mapped_column(Q, default=1)
    scrap_rate: Mapped[float] = mapped_column(Q, default=0)  # 损耗率，如 0.02
    designator: Mapped[str | None] = mapped_column(String(256))  # 位号
    remark: Mapped[str | None] = mapped_column(String(256))

    component = relationship("Material", lazy="joined")

    @property
    def component_code(self):
        return self.component.code if self.component else None

    @property
    def component_name(self):
        return self.component.name if self.component else None

    @property
    def component_spec(self):
        return self.component.spec if self.component else None

    @property
    def component_uom(self):
        return self.component.uom if self.component else None

    @property
    def customer_supplied(self):
        return bool(self.component and self.component.owner_customer_id)


class WorkCenter(IdMixin, TimestampMixin, Base):
    __tablename__ = "md_work_center"
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(String(256))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Routing(IdMixin, TimestampMixin, Base):
    """工艺路线：工序 + 每道工序的测试参数及规格上下限（如峰值波长、辐照度、漏电流）。"""

    __tablename__ = "eng_routing"
    material_id: Mapped[int] = mapped_column(ForeignKey("md_material.id"), index=True)
    version: Mapped[str] = mapped_column(String(16), default="A0")
    name: Mapped[str | None] = mapped_column(String(128))
    status: Mapped[str] = mapped_column(String(16), default="DRAFT")
    released_by: Mapped[str | None] = mapped_column(String(64))
    released_at: Mapped[datetime | None] = mapped_column(DateTime)
    remark: Mapped[str | None] = mapped_column(Text)

    material = relationship("Material", lazy="joined")
    operations = relationship(
        "RoutingOperation", cascade="all, delete-orphan", order_by="RoutingOperation.seq", lazy="selectin"
    )

    @property
    def material_code(self):
        return self.material.code if self.material else None

    @property
    def material_name(self):
        return self.material.name if self.material else None


class RoutingOperation(IdMixin, Base):
    __tablename__ = "eng_routing_op"
    routing_id: Mapped[int] = mapped_column(ForeignKey("eng_routing.id", ondelete="CASCADE"), index=True)
    seq: Mapped[int] = mapped_column(Integer)
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(64))
    # ASSEMBLY/SMT/TEST_OPTICAL/AGING/TEST_SAFETY/INSPECTION/PACKING/OTHER
    op_type: Mapped[str] = mapped_column(String(16), default="ASSEMBLY")
    work_center_id: Mapped[int | None] = mapped_column(ForeignKey("md_work_center.id"))
    std_minutes: Mapped[float] = mapped_column(Q, default=0)
    requires_equipment: Mapped[bool] = mapped_column(Boolean, default=False)
    key_part_material_id: Mapped[int | None] = mapped_column(ForeignKey("md_material.id"))  # 本工序需绑定的关键件
    sop_no: Mapped[str | None] = mapped_column(String(64))
    instructions: Mapped[str | None] = mapped_column(Text)

    work_center = relationship("WorkCenter", lazy="joined")
    key_part_material = relationship("Material", lazy="joined")
    params = relationship("RoutingParam", cascade="all, delete-orphan", order_by="RoutingParam.id", lazy="selectin")

    @property
    def work_center_name(self):
        return self.work_center.name if self.work_center else None

    @property
    def key_part_material_code(self):
        return self.key_part_material.code if self.key_part_material else None


class RoutingParam(IdMixin, Base):
    __tablename__ = "eng_routing_param"
    operation_id: Mapped[int] = mapped_column(ForeignKey("eng_routing_op.id", ondelete="CASCADE"), index=True)
    code: Mapped[str] = mapped_column(String(32))
    name: Mapped[str] = mapped_column(String(64))
    unit: Mapped[str | None] = mapped_column(String(16))
    lower: Mapped[float | None] = mapped_column(Q)
    upper: Mapped[float | None] = mapped_column(Q)
    target: Mapped[float | None] = mapped_column(Q)


class Equipment(IdMixin, TimestampMixin, Base):
    """设备/仪器台账。需校准的仪器若校准过期，系统禁止其用于生产报工。"""

    __tablename__ = "md_equipment"
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    model: Mapped[str | None] = mapped_column(String(64))
    serial_no: Mapped[str | None] = mapped_column(String(64))
    equipment_type: Mapped[str] = mapped_column(String(16), default="PRODUCTION")  # PRODUCTION/TEST/AGING
    work_center_id: Mapped[int | None] = mapped_column(ForeignKey("md_work_center.id"))
    status: Mapped[str] = mapped_column(String(16), default="NORMAL")  # NORMAL/MAINTENANCE/DISABLED
    calibration_required: Mapped[bool] = mapped_column(Boolean, default=False)
    calibration_cycle_days: Mapped[int | None] = mapped_column(Integer)
    last_calibration_date: Mapped[date | None] = mapped_column(Date)
    next_calibration_date: Mapped[date | None] = mapped_column(Date)
    remark: Mapped[str | None] = mapped_column(Text)

    work_center = relationship("WorkCenter", lazy="joined")

    @property
    def work_center_name(self):
        return self.work_center.name if self.work_center else None


class CalibrationRecord(IdMixin, TimestampMixin, Base):
    __tablename__ = "md_calibration"
    equipment_id: Mapped[int] = mapped_column(ForeignKey("md_equipment.id"), index=True)
    calibration_date: Mapped[date] = mapped_column(Date)
    result: Mapped[str] = mapped_column(String(8), default="PASS")
    certificate_no: Mapped[str | None] = mapped_column(String(64))
    agency: Mapped[str | None] = mapped_column(String(128))
    next_due_date: Mapped[date | None] = mapped_column(Date)
    remark: Mapped[str | None] = mapped_column(String(256))


class Warehouse(IdMixin, TimestampMixin, Base):
    __tablename__ = "md_warehouse"
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(64))
    warehouse_type: Mapped[str] = mapped_column(String(16), default="RAW")  # RAW/FG/CUSTOMER/REJECT/WIP
    address: Mapped[str | None] = mapped_column(String(256))
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)


class Location(IdMixin, TimestampMixin, Base):
    __tablename__ = "md_location"
    warehouse_id: Mapped[int] = mapped_column(ForeignKey("md_warehouse.id"), index=True)
    code: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    name: Mapped[str | None] = mapped_column(String(64))
    location_type: Mapped[str] = mapped_column(String(16), default="STORAGE")  # STORAGE/DRY_CABINET/REJECT/STAGING
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    warehouse = relationship("Warehouse", lazy="joined")

    @property
    def warehouse_name(self):
        return self.warehouse.name if self.warehouse else None

    @property
    def warehouse_type(self):
        return self.warehouse.warehouse_type if self.warehouse else None
