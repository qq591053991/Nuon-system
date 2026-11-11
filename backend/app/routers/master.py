"""主数据与工程数据路由。"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import now
from ..crud import crud_router, paginate
from ..db import get_db
from ..errors import BizError, NotFound
from ..models import (
    Bom, BomLine, CalibrationRecord, Customer, Equipment, Location, Material, Routing, RoutingOperation,
    RoutingParam, Supplier, User, Warehouse, WorkCenter,
)
from ..security import SignatureIn, esign, get_current_user, require
from ..serial import ser, ser_list
from ..services.udi import is_valid_gtin

router = APIRouter()


def _validate_material(db: Session, m: Material):
    if m.gtin and not is_valid_gtin(m.gtin):
        raise BizError("UDI-DI（GTIN）校验位错误，请检查")
    if m.category == "FINISHED" and m.owner_customer_id:
        raise BizError("成品不能设置为客供料")
    if m.serial_control and m.category not in ("FINISHED", "SEMI"):
        raise BizError("只有成品/半成品可以启用序列号管理")


def _validate_equipment(db: Session, e: Equipment):
    if e.calibration_required and e.last_calibration_date and e.calibration_cycle_days and not e.next_calibration_date:
        e.next_calibration_date = e.last_calibration_date + timedelta(days=e.calibration_cycle_days)


for r in (
    crud_router(Customer, prefix="/api/customers", tag="主数据-客户", perm="master", label="客户",
                search=("code", "name", "short_name"), filters=("is_active",)),
    crud_router(Supplier, prefix="/api/suppliers", tag="主数据-供应商", perm="master", label="供应商",
                search=("code", "name", "short_name", "category"), filters=("status", "is_active")),
    crud_router(Material, prefix="/api/materials", tag="主数据-物料", perm="master", label="物料",
                search=("code", "name", "spec"), filters=("category", "is_active", "owner_customer_id", "customer_id",
                                                          "serial_control"), validate=_validate_material,
                order=Material.code),
    crud_router(WorkCenter, prefix="/api/work-centers", tag="主数据-工作中心", perm="master", label="工作中心"),
    crud_router(Equipment, prefix="/api/equipment", tag="主数据-设备", perm="master", label="设备",
                search=("code", "name", "model"), filters=("status", "work_center_id", "equipment_type"),
                validate=_validate_equipment, order=Equipment.code),
    crud_router(Warehouse, prefix="/api/warehouses", tag="主数据-仓库", perm="master", label="仓库",
                filters=("warehouse_type", "is_active"), order=Warehouse.code),
    crud_router(Location, prefix="/api/locations", tag="主数据-库位", perm="master", label="库位",
                filters=("warehouse_id", "location_type", "is_active"), order=Location.code),
):
    router.include_router(r)


# ---------------- 设备校准 ----------------
class CalibrationIn(BaseModel):
    calibration_date: date
    result: str = "PASS"
    certificate_no: str | None = None
    agency: str | None = None
    next_due_date: date | None = None
    remark: str | None = None


@router.get("/api/equipment/{eid}/calibrations", tags=["主数据-设备"], summary="校准记录")
def list_calibrations(eid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    rows = db.scalars(select(CalibrationRecord).where(CalibrationRecord.equipment_id == eid)
                      .order_by(CalibrationRecord.calibration_date.desc()))
    return ser_list(rows)


@router.post("/api/equipment/{eid}/calibrations", tags=["主数据-设备"], summary="登记校准结果")
def add_calibration(eid: int, body: CalibrationIn, db: Session = Depends(get_db), user: User = Depends(require("master", "qa"))):
    eq = db.get(Equipment, eid)
    if not eq:
        raise NotFound("设备")
    nxt = body.next_due_date
    if not nxt and eq.calibration_cycle_days:
        nxt = body.calibration_date + timedelta(days=eq.calibration_cycle_days)
    rec = CalibrationRecord(equipment_id=eid, **body.model_dump(exclude={"next_due_date"}), next_due_date=nxt,
                            created_by=user.username)
    db.add(rec)
    eq.last_calibration_date = body.calibration_date
    if body.result == "PASS":
        eq.next_calibration_date = nxt
        if eq.status == "DISABLED":
            eq.status = "NORMAL"
    else:
        eq.status = "DISABLED"
    db.commit()
    return ser(rec)


# ---------------- BOM ----------------
class BomLineIn(BaseModel):
    component_id: int
    qty_per: float = Field(gt=0)
    scrap_rate: float = 0
    designator: str | None = None
    remark: str | None = None


class BomIn(BaseModel):
    material_id: int
    version: str = "A0"
    ecn_no: str | None = None
    effective_date: date | None = None
    remark: str | None = None
    lines: list[BomLineIn] = []


def _bom_lines(bom: Bom, lines: list[BomLineIn]):
    seen = set()
    bom.lines.clear()
    for i, ln in enumerate(lines, start=1):
        if ln.component_id == bom.material_id:
            raise BizError("BOM 组件不能是父项自身")
        if ln.component_id in seen:
            raise BizError("同一组件在 BOM 中重复出现，请合并")
        seen.add(ln.component_id)
        bom.lines.append(BomLine(line_no=i * 10, **ln.model_dump()))


@router.get("/api/boms", tags=["工程-BOM"], summary="BOM 列表")
def list_boms(q: str | None = None, material_id: int | None = None, status: str | None = None, page: int = 1,
              page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Bom).join(Material, Bom.material_id == Material.id).order_by(Bom.id.desc())
    if q:
        stmt = stmt.where(or_(Material.code.ilike(f"%{q}%"), Material.name.ilike(f"%{q}%"), Bom.ecn_no.ilike(f"%{q}%")))
    if material_id:
        stmt = stmt.where(Bom.material_id == material_id)
    if status:
        stmt = stmt.where(Bom.status == status)
    return paginate(db, stmt, page, page_size)


@router.get("/api/boms/{bid}", tags=["工程-BOM"], summary="BOM 详情")
def get_bom(bid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    b = db.get(Bom, bid)
    if not b:
        raise NotFound("BOM")
    return ser(b, ("lines",))


@router.post("/api/boms", tags=["工程-BOM"], summary="新建 BOM（草稿）")
def create_bom(body: BomIn, db: Session = Depends(get_db), user: User = Depends(require("engineering"))):
    if db.scalar(select(Bom).where(Bom.material_id == body.material_id, Bom.version == body.version)):
        raise BizError(f"该产品已存在版本 {body.version} 的 BOM")
    b = Bom(**body.model_dump(exclude={"lines"}), status="DRAFT", created_by=user.username)
    db.add(b)
    _bom_lines(b, body.lines)
    db.commit()
    return ser(b, ("lines",))


@router.put("/api/boms/{bid}", tags=["工程-BOM"], summary="修改 BOM（仅草稿）")
def update_bom(bid: int, body: BomIn, db: Session = Depends(get_db), _: User = Depends(require("engineering"))):
    b = db.get(Bom, bid)
    if not b:
        raise NotFound("BOM")
    if b.status != "DRAFT":
        raise BizError("已发布的 BOM 不能修改，请“升版”生成新版本（ECN 变更）")
    for k, v in body.model_dump(exclude={"lines", "material_id"}).items():
        setattr(b, k, v)
    _bom_lines(b, body.lines)
    db.commit()
    return ser(b, ("lines",))


@router.delete("/api/boms/{bid}", tags=["工程-BOM"], summary="删除 BOM 草稿")
def delete_bom(bid: int, db: Session = Depends(get_db), _: User = Depends(require("engineering"))):
    b = db.get(Bom, bid)
    if not b:
        raise NotFound("BOM")
    if b.status != "DRAFT":
        raise BizError("只能删除草稿")
    db.delete(b)
    db.commit()
    return {"ok": True}


def _check_cycle(db: Session, root_id: int, comp_ids: list[int], path=()):
    for cid in comp_ids:
        if cid == root_id or cid in path:
            raise BizError("BOM 存在循环引用")
        sub = db.scalars(select(Bom).where(Bom.material_id == cid, Bom.status == "RELEASED")).first()
        if sub:
            _check_cycle(db, root_id, [l.component_id for l in sub.lines], path + (cid,))


class ReleaseIn(BaseModel):
    signature: SignatureIn


@router.post("/api/boms/{bid}/release", tags=["工程-BOM"], summary="发布 BOM（电子签名）")
def release_bom(bid: int, body: ReleaseIn, db: Session = Depends(get_db), user: User = Depends(require("engineering"))):
    b = db.get(Bom, bid)
    if not b:
        raise NotFound("BOM")
    if b.status != "DRAFT":
        raise BizError("只有草稿可以发布")
    if not b.lines:
        raise BizError("BOM 没有组件")
    _check_cycle(db, b.material_id, [l.component_id for l in b.lines])
    esign(db, user, body.signature, "BOM发布批准", "eng_bom", b.id, f"{b.material_code} {b.version}")
    for old in db.scalars(select(Bom).where(Bom.material_id == b.material_id, Bom.status == "RELEASED")):
        old.status = "OBSOLETE"
    b.status, b.released_by, b.released_at = "RELEASED", user.full_name, now()
    b.effective_date = b.effective_date or now().date()
    db.commit()
    return ser(b, ("lines",))


class NewVersionIn(BaseModel):
    version: str
    ecn_no: str | None = None


@router.post("/api/boms/{bid}/new-version", tags=["工程-BOM"], summary="升版（复制为新草稿）")
def bom_new_version(bid: int, body: NewVersionIn, db: Session = Depends(get_db), user: User = Depends(require("engineering"))):
    b = db.get(Bom, bid)
    if not b:
        raise NotFound("BOM")
    if db.scalar(select(Bom).where(Bom.material_id == b.material_id, Bom.version == body.version)):
        raise BizError("版本号已存在")
    nb = Bom(material_id=b.material_id, version=body.version, ecn_no=body.ecn_no, status="DRAFT", remark=b.remark,
             created_by=user.username)
    for ln in b.lines:
        nb.lines.append(BomLine(line_no=ln.line_no, component_id=ln.component_id, qty_per=ln.qty_per,
                                scrap_rate=ln.scrap_rate, designator=ln.designator, remark=ln.remark))
    db.add(nb)
    db.commit()
    return ser(nb, ("lines",))


@router.get("/api/boms/{bid}/tree", tags=["工程-BOM"], summary="多级 BOM 展开")
def bom_tree(bid: int, qty: float = 1, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    b = db.get(Bom, bid)
    if not b:
        raise NotFound("BOM")

    def expand(bom: Bom, mult: float, level: int, path: tuple) -> list[dict]:
        out = []
        for ln in bom.lines:
            need = mult * ln.qty_per * (1 + (ln.scrap_rate or 0))
            node = {"key": f"{'-'.join(map(str, path))}-{ln.id}", "level": level, "component_id": ln.component_id,
                    "code": ln.component_code, "name": ln.component_name, "spec": ln.component_spec,
                    "uom": ln.component_uom, "qty_per": ln.qty_per, "total_qty": round(need, 4),
                    "designator": ln.designator, "customer_supplied": ln.customer_supplied}
            sub = db.scalars(select(Bom).where(Bom.material_id == ln.component_id, Bom.status == "RELEASED")).first()
            if sub and ln.component_id not in path:
                node["children"] = expand(sub, need, level + 1, path + (ln.component_id,))
            out.append(node)
        return out

    return {"bom": ser(b), "tree": expand(b, qty, 1, (b.material_id,))}


# ---------------- 工艺路线 ----------------
class ParamIn(BaseModel):
    code: str
    name: str
    unit: str | None = None
    lower: float | None = None
    upper: float | None = None
    target: float | None = None


class OperationIn(BaseModel):
    seq: int
    code: str
    name: str
    op_type: str = "ASSEMBLY"
    work_center_id: int | None = None
    std_minutes: float = 0
    requires_equipment: bool = False
    key_part_material_id: int | None = None
    sop_no: str | None = None
    instructions: str | None = None
    params: list[ParamIn] = []


class RoutingIn(BaseModel):
    material_id: int
    version: str = "A0"
    name: str | None = None
    remark: str | None = None
    operations: list[OperationIn] = []


def _routing_ops(r: Routing, ops: list[OperationIn]):
    seqs = [o.seq for o in ops]
    if len(seqs) != len(set(seqs)):
        raise BizError("工序号重复")
    r.operations.clear()
    for o in sorted(ops, key=lambda x: x.seq):
        for p in o.params:
            if p.lower is not None and p.upper is not None and p.lower > p.upper:
                raise BizError(f"工序 {o.name} 测试项 {p.name} 下限大于上限")
        op = RoutingOperation(**o.model_dump(exclude={"params"}))
        op.params = [RoutingParam(**p.model_dump()) for p in o.params]
        r.operations.append(op)


@router.get("/api/routings", tags=["工程-工艺路线"], summary="工艺路线列表")
def list_routings(q: str | None = None, material_id: int | None = None, status: str | None = None, page: int = 1,
                  page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Routing).join(Material, Routing.material_id == Material.id).order_by(Routing.id.desc())
    if q:
        stmt = stmt.where(or_(Material.code.ilike(f"%{q}%"), Material.name.ilike(f"%{q}%"), Routing.name.ilike(f"%{q}%")))
    if material_id:
        stmt = stmt.where(Routing.material_id == material_id)
    if status:
        stmt = stmt.where(Routing.status == status)
    return paginate(db, stmt, page, page_size)


@router.get("/api/routings/{rid}", tags=["工程-工艺路线"], summary="工艺路线详情")
def get_routing(rid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    r = db.get(Routing, rid)
    if not r:
        raise NotFound("工艺路线")
    return ser(r, ("operations.params",))


@router.post("/api/routings", tags=["工程-工艺路线"], summary="新建工艺路线（草稿）")
def create_routing(body: RoutingIn, db: Session = Depends(get_db), user: User = Depends(require("engineering"))):
    if db.scalar(select(Routing).where(Routing.material_id == body.material_id, Routing.version == body.version)):
        raise BizError(f"该产品已存在版本 {body.version} 的工艺路线")
    r = Routing(**body.model_dump(exclude={"operations"}), status="DRAFT", created_by=user.username)
    db.add(r)
    _routing_ops(r, body.operations)
    db.commit()
    return ser(r, ("operations.params",))


@router.put("/api/routings/{rid}", tags=["工程-工艺路线"], summary="修改工艺路线（仅草稿）")
def update_routing(rid: int, body: RoutingIn, db: Session = Depends(get_db), _: User = Depends(require("engineering"))):
    r = db.get(Routing, rid)
    if not r:
        raise NotFound("工艺路线")
    if r.status != "DRAFT":
        raise BizError("已发布的工艺路线不能修改，请升版")
    for k, v in body.model_dump(exclude={"operations", "material_id"}).items():
        setattr(r, k, v)
    _routing_ops(r, body.operations)
    db.commit()
    return ser(r, ("operations.params",))


@router.post("/api/routings/{rid}/release", tags=["工程-工艺路线"], summary="发布工艺路线（电子签名）")
def release_routing(rid: int, body: ReleaseIn, db: Session = Depends(get_db), user: User = Depends(require("engineering"))):
    r = db.get(Routing, rid)
    if not r:
        raise NotFound("工艺路线")
    if r.status != "DRAFT":
        raise BizError("只有草稿可以发布")
    if not r.operations:
        raise BizError("工艺路线没有工序")
    esign(db, user, body.signature, "工艺路线发布批准", "eng_routing", r.id, f"{r.material_code} {r.version}")
    for old in db.scalars(select(Routing).where(Routing.material_id == r.material_id, Routing.status == "RELEASED")):
        old.status = "OBSOLETE"
    r.status, r.released_by, r.released_at = "RELEASED", user.full_name, now()
    db.commit()
    return ser(r, ("operations.params",))


@router.post("/api/routings/{rid}/new-version", tags=["工程-工艺路线"], summary="工艺路线升版")
def routing_new_version(rid: int, body: NewVersionIn, db: Session = Depends(get_db), user: User = Depends(require("engineering"))):
    r = db.get(Routing, rid)
    if not r:
        raise NotFound("工艺路线")
    if db.scalar(select(Routing).where(Routing.material_id == r.material_id, Routing.version == body.version)):
        raise BizError("版本号已存在")
    nr = Routing(material_id=r.material_id, version=body.version, name=r.name, status="DRAFT", created_by=user.username)
    for o in r.operations:
        op = RoutingOperation(seq=o.seq, code=o.code, name=o.name, op_type=o.op_type, work_center_id=o.work_center_id,
                              std_minutes=o.std_minutes, requires_equipment=o.requires_equipment,
                              key_part_material_id=o.key_part_material_id, sop_no=o.sop_no, instructions=o.instructions)
        op.params = [RoutingParam(code=p.code, name=p.name, unit=p.unit, lower=p.lower, upper=p.upper, target=p.target)
                     for p in o.params]
        nr.operations.append(op)
    db.add(nr)
    db.commit()
    return ser(nr, ("operations.params",))


@router.delete("/api/routings/{rid}", tags=["工程-工艺路线"], summary="删除工艺路线草稿")
def delete_routing(rid: int, db: Session = Depends(get_db), _: User = Depends(require("engineering"))):
    r = db.get(Routing, rid)
    if not r:
        raise NotFound("工艺路线")
    if r.status != "DRAFT":
        raise BizError("只能删除草稿")
    db.delete(r)
    db.commit()
    return {"ok": True}
