"""WMS 路由：库存查询、库存流水、收货、调拨、领料、发货、盘点。"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import func, or_, select
from sqlalchemy.orm import Session

from ..config import today
from ..crud import paginate
from ..db import get_db
from ..errors import BizError, NotFound
from ..models import (
    Location, Material, MaterialIssue, Receipt, SalesOrder, SerialNumber, Shipment, Stock, StockCount, StockMove,
    User, WorkOrder,
)
from ..security import get_current_user, require
from ..serial import ser, ser_list
from ..services import wms as svc

router = APIRouter(tags=["仓储WMS"])


@router.get("/api/stock", summary="库存明细（按物料/库位/批次/质量状态/货主）")
def list_stock(q: str | None = None, material_id: int | None = None, warehouse_id: int | None = None,
               location_id: int | None = None, status: str | None = None, lot_no: str | None = None,
               owner_customer_id: int | None = None, expiring_days: int | None = None, page: int = 1,
               page_size: int = 50, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Stock).join(Material, Stock.material_id == Material.id).join(Location, Stock.location_id == Location.id)
    stmt = stmt.where(Stock.qty > 0).order_by(Material.code, Stock.expiry_date, Stock.id)
    if q:
        stmt = stmt.where(or_(Material.code.ilike(f"%{q}%"), Material.name.ilike(f"%{q}%"), Stock.lot_no.ilike(f"%{q}%")))
    if material_id:
        stmt = stmt.where(Stock.material_id == material_id)
    if warehouse_id:
        stmt = stmt.where(Location.warehouse_id == warehouse_id)
    if location_id:
        stmt = stmt.where(Stock.location_id == location_id)
    if status:
        stmt = stmt.where(Stock.status.in_(status.split(",")))
    if lot_no:
        stmt = stmt.where(Stock.lot_no == lot_no)
    if owner_customer_id:
        stmt = stmt.where(Stock.owner_customer_id == owner_customer_id)
    if expiring_days is not None:
        stmt = stmt.where(Stock.expiry_date.is_not(None), Stock.expiry_date <= today() + timedelta(days=expiring_days))
    return paginate(db, stmt, page, page_size)


@router.get("/api/stock/summary", summary="库存汇总（按物料，分质量状态）")
def stock_summary(q: str | None = None, category: str | None = None, below_safety: bool = False,
                  db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Stock.material_id, Stock.status, func.sum(Stock.qty)).where(Stock.qty > 0).group_by(Stock.material_id, Stock.status)
    agg: dict[int, dict] = {}
    for mid, st, qty in db.execute(stmt):
        agg.setdefault(mid, {})[st] = round(qty or 0, 4)
    mstmt = select(Material).where(Material.is_active.is_(True)).order_by(Material.code)
    if q:
        mstmt = mstmt.where(or_(Material.code.ilike(f"%{q}%"), Material.name.ilike(f"%{q}%")))
    if category:
        mstmt = mstmt.where(Material.category == category)
    out = []
    for m in db.scalars(mstmt):
        a = agg.get(m.id, {})
        avail = a.get("AVAILABLE", 0)
        row = {"material_id": m.id, "material_code": m.code, "material_name": m.name, "spec": m.spec, "uom": m.uom,
               "category": m.category, "available": avail, "quarantine": a.get("QUARANTINE", 0),
               "rejected": a.get("REJECTED", 0), "hold": a.get("HOLD", 0), "safety_stock": m.safety_stock,
               "below_safety": avail < (m.safety_stock or 0), "customer_supplied": bool(m.owner_customer_id),
               "amount": round(sum(a.values()) * (m.std_cost or 0), 2)}
        if below_safety and not row["below_safety"]:
            continue
        if not a and not below_safety and not q:
            continue
        out.append(row)
    return out


@router.get("/api/stock-moves", summary="库存流水")
def list_moves(q: str | None = None, material_id: int | None = None, move_type: str | None = None,
               lot_no: str | None = None, ref_no: str | None = None, date_from: date | None = None,
               date_to: date | None = None, page: int = 1, page_size: int = 50, db: Session = Depends(get_db),
               _: User = Depends(get_current_user)):
    stmt = select(StockMove).join(Material).order_by(StockMove.id.desc())
    if q:
        stmt = stmt.where(or_(Material.code.ilike(f"%{q}%"), StockMove.lot_no.ilike(f"%{q}%"), StockMove.ref_no.ilike(f"%{q}%")))
    if material_id:
        stmt = stmt.where(StockMove.material_id == material_id)
    if move_type:
        stmt = stmt.where(StockMove.move_type == move_type)
    if lot_no:
        stmt = stmt.where(StockMove.lot_no == lot_no)
    if ref_no:
        stmt = stmt.where(StockMove.ref_no == ref_no)
    if date_from:
        stmt = stmt.where(StockMove.ts >= date_from)
    if date_to:
        stmt = stmt.where(StockMove.ts < date_to + timedelta(days=1))
    return paginate(db, stmt, page, page_size)


# ---------- 收货 ----------
@router.get("/api/receipts", summary="入库单列表")
def list_receipts(q: str | None = None, receipt_type: str | None = None, page: int = 1, page_size: int = 20,
                  db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Receipt).order_by(Receipt.id.desc())
    if q:
        stmt = stmt.where(or_(Receipt.no.ilike(f"%{q}%"), Receipt.delivery_note.ilike(f"%{q}%")))
    if receipt_type:
        stmt = stmt.where(Receipt.receipt_type == receipt_type)
    return paginate(db, stmt, page, page_size, ("lines",))


@router.get("/api/receipts/{rid}", summary="入库单详情")
def get_receipt(rid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    r = db.get(Receipt, rid)
    if not r:
        raise NotFound("入库单")
    return ser(r, ("lines",))


class ReceiptLineIn(BaseModel):
    material_id: int
    qty: float = Field(gt=0)
    location_id: int
    lot_no: str | None = None
    supplier_lot: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None


class ReceiptIn(BaseModel):
    receipt_type: str = "CUSTOMER_SUPPLIED"  # CUSTOMER_SUPPLIED / OTHER / OPENING
    customer_id: int | None = None
    supplier_id: int | None = None
    delivery_note: str | None = None
    remark: str | None = None
    lines: list[ReceiptLineIn]


@router.post("/api/receipts", summary="其他收货：客供料收货 / 期初库存 / 其他入库")
def create_receipt(body: ReceiptIn, db: Session = Depends(get_db), user: User = Depends(require("wms"))):
    if body.receipt_type not in ("CUSTOMER_SUPPLIED", "OTHER", "OPENING"):
        raise BizError("采购收货请从采购订单发起；完工入库请从生产工单发起")
    rc = svc.receive(db, user, receipt_type=body.receipt_type, lines=[l.model_dump() for l in body.lines],
                     supplier_id=body.supplier_id, customer_id=body.customer_id, delivery_note=body.delivery_note,
                     remark=body.remark)
    db.commit()
    return ser(rc, ("lines",))


# ---------- 调拨 ----------
class TransferIn(BaseModel):
    stock_id: int
    qty: float = Field(gt=0)
    to_location_id: int
    remark: str | None = None


@router.post("/api/stock/transfer", summary="库位调拨/上架")
def transfer(body: TransferIn, db: Session = Depends(get_db), user: User = Depends(require("wms"))):
    st = svc.transfer(db, user, body.stock_id, body.qty, body.to_location_id, body.remark)
    db.commit()
    return ser(st)


# ---------- 领料 ----------
@router.get("/api/issues", summary="领料单列表")
def list_issues(q: str | None = None, status: str | None = None, wo_id: int | None = None, page: int = 1,
                page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(MaterialIssue).order_by(MaterialIssue.id.desc())
    if q:
        stmt = stmt.join(WorkOrder).where(or_(MaterialIssue.no.ilike(f"%{q}%"), WorkOrder.no.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(MaterialIssue.status == status)
    if wo_id:
        stmt = stmt.where(MaterialIssue.wo_id == wo_id)
    return paginate(db, stmt, page, page_size, ("lines",))


@router.get("/api/issues/{iid}", summary="领料单详情")
def get_issue(iid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    i = db.get(MaterialIssue, iid)
    if not i:
        raise NotFound("领料单")
    return ser(i, ("lines",))


class IssueLineIn(BaseModel):
    material_id: int
    stock_id: int
    qty: float = Field(gt=0)


class IssueIn(BaseModel):
    lines: list[IssueLineIn] | None = None  # 为空 = 系统按 FEFO 自动分配


@router.post("/api/work-orders/{wid}/issues", summary="生成领料单（FEFO 自动推荐批次）")
def create_issue(wid: int, body: IssueIn | None = None, db: Session = Depends(get_db),
                 user: User = Depends(require("wms", "plan"))):
    wo = db.get(WorkOrder, wid)
    if not wo:
        raise NotFound("工单")
    issue, shortages = svc.create_issue(db, user, wo, [l.model_dump() for l in body.lines] if body and body.lines else None)
    db.commit()
    return {**ser(issue, ("lines",)), "shortages": shortages}


@router.post("/api/issues/{iid}/confirm", summary="领料过账（扣减库存，记录批次追溯）")
def confirm_issue(iid: int, db: Session = Depends(get_db), user: User = Depends(require("wms"))):
    i = db.get(MaterialIssue, iid)
    if not i:
        raise NotFound("领料单")
    svc.confirm_issue(db, user, i)
    db.commit()
    return ser(i, ("lines",))


@router.post("/api/issues/{iid}/cancel", summary="取消领料单")
def cancel_issue(iid: int, db: Session = Depends(get_db), _: User = Depends(require("wms", "plan"))):
    i = db.get(MaterialIssue, iid)
    if not i:
        raise NotFound("领料单")
    if i.status != "DRAFT":
        raise BizError("只能取消未过账的领料单")
    i.status = "CANCELLED"
    db.commit()
    return ser(i, ("lines",))


# ---------- 发货 ----------
@router.get("/api/shipments", summary="发货单列表")
def list_shipments(q: str | None = None, status: str | None = None, so_id: int | None = None, page: int = 1,
                   page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Shipment).order_by(Shipment.id.desc())
    if q:
        stmt = stmt.where(or_(Shipment.no.ilike(f"%{q}%"), Shipment.tracking_no.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(Shipment.status == status)
    if so_id:
        stmt = stmt.where(Shipment.so_id == so_id)
    return paginate(db, stmt, page, page_size, ("lines",))


@router.get("/api/shipments/{sid}", summary="发货单详情")
def get_shipment(sid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    s = db.get(Shipment, sid)
    if not s:
        raise NotFound("发货单")
    d = ser(s, ("lines",))
    for ln, obj in zip(d["lines"], s.lines):
        ln["serial_list"] = obj.serial_list
    return d


class ShipLineIn(BaseModel):
    so_line_id: int
    qty: float = 0
    serials: list[str] | None = None


class ShipmentIn(BaseModel):
    so_id: int
    carrier: str | None = None
    tracking_no: str | None = None
    ship_to: str | None = None
    remark: str | None = None
    lines: list[ShipLineIn]


@router.post("/api/shipments", summary="创建发货单（仅允许已放行产品，序列号逐台校验）")
def create_shipment(body: ShipmentIn, db: Session = Depends(get_db), user: User = Depends(require("wms", "sales"))):
    so = db.get(SalesOrder, body.so_id)
    if not so:
        raise NotFound("销售订单")
    sh = svc.create_shipment(db, user, so, [l.model_dump() for l in body.lines], body.carrier, body.tracking_no,
                             body.ship_to, body.remark)
    db.commit()
    return get_shipment(sh.id, db, user)


@router.post("/api/shipments/{sid}/confirm", summary="发货过账（扣库存、序列号出库、生成应收）")
def confirm_shipment(sid: int, db: Session = Depends(get_db), user: User = Depends(require("wms"))):
    s = db.get(Shipment, sid)
    if not s:
        raise NotFound("发货单")
    svc.confirm_shipment(db, user, s)
    db.commit()
    return get_shipment(sid, db, user)


@router.post("/api/shipments/{sid}/cancel", summary="取消发货单")
def cancel_shipment(sid: int, db: Session = Depends(get_db), _: User = Depends(require("wms", "sales"))):
    s = db.get(Shipment, sid)
    if not s:
        raise NotFound("发货单")
    if s.status != "DRAFT":
        raise BizError("已发货不能取消")
    s.status = "CANCELLED"
    db.commit()
    return ser(s, ("lines",))


@router.get("/api/serials/available", summary="可发货序列号（已入库且已放行，按完工先后）")
def serials_available(material_id: int, limit: int = 500, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return [{"sn": s.sn, "lot_no": s.lot_no, "wo_no": s.wo_no, "completed_at": s.completed_at}
            for s in svc.available_serials(db, material_id, limit)]


# ---------- 盘点 ----------
@router.get("/api/stock-counts", summary="盘点单列表")
def list_counts(page: int = 1, page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return paginate(db, select(StockCount).order_by(StockCount.id.desc()), page, page_size)


@router.get("/api/stock-counts/{cid}", summary="盘点单详情")
def get_count(cid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    c = db.get(StockCount, cid)
    if not c:
        raise NotFound("盘点单")
    return ser(c, ("lines",))


class CountIn(BaseModel):
    warehouse_id: int
    remark: str | None = None


@router.post("/api/stock-counts", summary="创建盘点单（按仓库生成账面快照）")
def create_count(body: CountIn, db: Session = Depends(get_db), user: User = Depends(require("wms"))):
    c = svc.create_count(db, user, body.warehouse_id, body.remark)
    db.commit()
    return ser(c, ("lines",))


class CountLineIn(BaseModel):
    id: int
    counted_qty: float = Field(ge=0)


@router.put("/api/stock-counts/{cid}/lines", summary="录入实盘数量")
def update_count_lines(cid: int, body: list[CountLineIn], db: Session = Depends(get_db), _: User = Depends(require("wms"))):
    c = db.get(StockCount, cid)
    if not c:
        raise NotFound("盘点单")
    if c.status != "OPEN":
        raise BizError("盘点单已过账")
    by_id = {l.id: l for l in c.lines}
    for ln in body:
        if ln.id in by_id:
            by_id[ln.id].counted_qty = ln.counted_qty
    db.commit()
    return ser(c, ("lines",))


@router.post("/api/stock-counts/{cid}/post", summary="盘点过账（生成差异调整）")
def post_count(cid: int, db: Session = Depends(get_db), user: User = Depends(require("wms"))):
    c = db.get(StockCount, cid)
    if not c:
        raise NotFound("盘点单")
    svc.post_count(db, user, c)
    db.commit()
    return ser(c, ("lines",))
