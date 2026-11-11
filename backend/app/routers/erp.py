"""ERP 路由：销售订单、采购订单、MRP、应收应付。"""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import now, today
from ..crud import paginate
from ..db import get_db
from ..errors import BizError, NotFound
from ..models import (
    Customer, FinanceDoc, Material, MrpRun, MrpSuggestion, Payment, PurchaseOrder, PurchaseOrderLine, SalesOrder,
    SalesOrderLine, Supplier, User, WorkOrder,
)
from ..security import get_current_user, require
from ..serial import ser
from ..services import mrp as mrp_svc
from ..services import wms as wms_svc
from ..services.numbering import next_no
from ..services.production import released_bom

router = APIRouter()


# ============ 销售订单 ============
class SoLineIn(BaseModel):
    material_id: int
    qty: float = Field(gt=0)
    unit_price: float = 0
    delivery_date: date | None = None
    remark: str | None = None


class SoIn(BaseModel):
    customer_id: int
    order_date: date | None = None
    delivery_date: date | None = None
    customer_po: str | None = None
    currency: str = "CNY"
    ship_to: str | None = None
    remark: str | None = None
    lines: list[SoLineIn]


def _so_lines(db: Session, so: SalesOrder, lines: list[SoLineIn]):
    if not lines:
        raise BizError("请至少录入一行订单明细")
    so.lines.clear()
    total = 0.0
    for i, ln in enumerate(lines, start=1):
        m = db.get(Material, ln.material_id)
        if not m:
            raise NotFound("物料")
        if m.category not in ("FINISHED", "SEMI"):
            raise BizError(f"{m.code} 不是成品/半成品，不能销售")
        if m.customer_id and m.customer_id != so.customer_id:
            raise BizError(f"{m.code} 是其他品牌客户的产品（代工产品只能卖给注册人/品牌方）")
        amt = round(ln.qty * ln.unit_price, 2)
        total += amt
        so.lines.append(SalesOrderLine(line_no=i, amount=amt, **ln.model_dump()))
    so.total_amount = round(total, 2)


@router.get("/api/sales-orders", tags=["销售"], summary="销售订单列表")
def list_so(q: str | None = None, status: str | None = None, customer_id: int | None = None, page: int = 1,
            page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(SalesOrder).join(Customer).order_by(SalesOrder.id.desc())
    if q:
        stmt = stmt.where(or_(SalesOrder.no.ilike(f"%{q}%"), SalesOrder.customer_po.ilike(f"%{q}%"),
                              Customer.name.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(SalesOrder.status.in_(status.split(",")))
    if customer_id:
        stmt = stmt.where(SalesOrder.customer_id == customer_id)
    return paginate(db, stmt, page, page_size, ("lines",))


@router.get("/api/sales-orders/{oid}", tags=["销售"], summary="销售订单详情（含关联工单/发货）")
def get_so(oid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    so = db.get(SalesOrder, oid)
    if not so:
        raise NotFound("销售订单")
    from ..models import Shipment
    d = ser(so, ("lines",))
    d["work_orders"] = [ser(w) for w in db.scalars(select(WorkOrder).where(WorkOrder.so_id == oid))]
    d["shipments"] = [ser(s) for s in db.scalars(select(Shipment).where(Shipment.so_id == oid))]
    return d


@router.post("/api/sales-orders", tags=["销售"], summary="新建销售订单")
def create_so(body: SoIn, db: Session = Depends(get_db), user: User = Depends(require("sales"))):
    so = SalesOrder(no=next_no(db, "SO"), status="DRAFT", created_by=user.username,
                    **body.model_dump(exclude={"lines", "order_date"}), order_date=body.order_date or today())
    db.add(so)
    _so_lines(db, so, body.lines)
    db.commit()
    return ser(so, ("lines",))


@router.put("/api/sales-orders/{oid}", tags=["销售"], summary="修改销售订单（仅草稿）")
def update_so(oid: int, body: SoIn, db: Session = Depends(get_db), _: User = Depends(require("sales"))):
    so = db.get(SalesOrder, oid)
    if not so:
        raise NotFound("销售订单")
    if so.status != "DRAFT":
        raise BizError("只有草稿状态可以修改")
    for k, v in body.model_dump(exclude={"lines"}).items():
        if v is not None:
            setattr(so, k, v)
    _so_lines(db, so, body.lines)
    db.commit()
    return ser(so, ("lines",))


def _so_transition(db: Session, oid: int, allowed: tuple, to: str, msg: str):
    so = db.get(SalesOrder, oid)
    if not so:
        raise NotFound("销售订单")
    if so.status not in allowed:
        raise BizError(msg)
    so.status = to
    db.commit()
    return ser(so, ("lines",))


@router.post("/api/sales-orders/{oid}/confirm", tags=["销售"], summary="确认订单")
def confirm_so(oid: int, db: Session = Depends(get_db), _: User = Depends(require("sales"))):
    return _so_transition(db, oid, ("DRAFT",), "CONFIRMED", "只有草稿可以确认")


@router.post("/api/sales-orders/{oid}/cancel", tags=["销售"], summary="取消订单")
def cancel_so(oid: int, db: Session = Depends(get_db), _: User = Depends(require("sales"))):
    so = db.get(SalesOrder, oid)
    if so and db.scalar(select(WorkOrder).where(WorkOrder.so_id == oid, WorkOrder.status != "CANCELLED")):
        raise BizError("订单已有生产工单，请先取消工单")
    return _so_transition(db, oid, ("DRAFT", "CONFIRMED"), "CANCELLED", "当前状态不能取消")


@router.post("/api/sales-orders/{oid}/close", tags=["销售"], summary="关闭订单（短交结案）")
def close_so(oid: int, db: Session = Depends(get_db), _: User = Depends(require("sales"))):
    return _so_transition(db, oid, ("CONFIRMED", "IN_PRODUCTION", "PARTIAL_SHIPPED", "SHIPPED"), "CLOSED", "当前状态不能关闭")


@router.post("/api/sales-orders/{oid}/create-work-orders", tags=["销售"], summary="一键生成生产工单")
def so_to_wo(oid: int, db: Session = Depends(get_db), user: User = Depends(require("plan"))):
    so = db.get(SalesOrder, oid)
    if not so:
        raise NotFound("销售订单")
    if so.status not in ("CONFIRMED", "IN_PRODUCTION", "PARTIAL_SHIPPED"):
        raise BizError("订单未确认")
    created, skipped = [], []
    for ln in so.lines:
        existing = sum(w.planned_qty for w in db.scalars(select(WorkOrder).where(
            WorkOrder.so_line_id == ln.id, WorkOrder.status != "CANCELLED")))
        qty = round(ln.qty - existing, 4)
        if qty <= 0:
            continue
        if not released_bom(db, ln.material_id):
            skipped.append(f"{ln.material_code}：无已发布 BOM")
            continue
        wo = WorkOrder(no=next_no(db, "WO"), material_id=ln.material_id, customer_id=so.customer_id, so_id=so.id,
                       so_line_id=ln.id, planned_qty=qty, planned_start=today(),
                       planned_end=ln.delivery_date or so.delivery_date, status="PLANNED", source=so.no,
                       created_by=user.username)
        db.add(wo)
        db.flush()
        created.append(wo.no)
    if created:
        so.status = "IN_PRODUCTION"
    db.commit()
    return {"work_orders": created, "skipped": skipped}


# ============ 采购订单 ============
class PoLineIn(BaseModel):
    material_id: int
    qty: float = Field(gt=0)
    unit_price: float = 0
    expected_date: date | None = None
    remark: str | None = None


class PoIn(BaseModel):
    supplier_id: int
    order_date: date | None = None
    expected_date: date | None = None
    currency: str = "CNY"
    remark: str | None = None
    lines: list[PoLineIn]


def _po_lines(db: Session, po: PurchaseOrder, lines: list[PoLineIn]):
    if not lines:
        raise BizError("请至少录入一行采购明细")
    po.lines.clear()
    total = 0.0
    for i, ln in enumerate(lines, start=1):
        m = db.get(Material, ln.material_id)
        if not m:
            raise NotFound("物料")
        if m.owner_customer_id:
            raise BizError(f"{m.code} 是客供料，不能采购")
        amt = round(ln.qty * ln.unit_price, 2)
        total += amt
        po.lines.append(PurchaseOrderLine(line_no=i, amount=amt, **ln.model_dump()))
    po.total_amount = round(total, 2)


@router.get("/api/purchase-orders", tags=["采购"], summary="采购订单列表")
def list_po(q: str | None = None, status: str | None = None, supplier_id: int | None = None, page: int = 1,
            page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(PurchaseOrder).join(Supplier).order_by(PurchaseOrder.id.desc())
    if q:
        stmt = stmt.where(or_(PurchaseOrder.no.ilike(f"%{q}%"), Supplier.name.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(PurchaseOrder.status.in_(status.split(",")))
    if supplier_id:
        stmt = stmt.where(PurchaseOrder.supplier_id == supplier_id)
    return paginate(db, stmt, page, page_size, ("lines",))


@router.get("/api/purchase-orders/{oid}", tags=["采购"], summary="采购订单详情（含收货记录）")
def get_po(oid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    po = db.get(PurchaseOrder, oid)
    if not po:
        raise NotFound("采购订单")
    from ..models import Receipt
    d = ser(po, ("lines",))
    d["receipts"] = [ser(r, ("lines",)) for r in db.scalars(select(Receipt).where(Receipt.po_id == oid))]
    return d


@router.post("/api/purchase-orders", tags=["采购"], summary="新建采购订单")
def create_po(body: PoIn, db: Session = Depends(get_db), user: User = Depends(require("purchase"))):
    po = PurchaseOrder(no=next_no(db, "PO"), status="DRAFT", created_by=user.username,
                       **body.model_dump(exclude={"lines", "order_date"}), order_date=body.order_date or today())
    db.add(po)
    _po_lines(db, po, body.lines)
    db.commit()
    return ser(po, ("lines",))


@router.put("/api/purchase-orders/{oid}", tags=["采购"], summary="修改采购订单（仅草稿）")
def update_po(oid: int, body: PoIn, db: Session = Depends(get_db), _: User = Depends(require("purchase"))):
    po = db.get(PurchaseOrder, oid)
    if not po:
        raise NotFound("采购订单")
    if po.status != "DRAFT":
        raise BizError("只有草稿状态可以修改")
    for k, v in body.model_dump(exclude={"lines"}).items():
        if v is not None:
            setattr(po, k, v)
    _po_lines(db, po, body.lines)
    db.commit()
    return ser(po, ("lines",))


@router.post("/api/purchase-orders/{oid}/approve", tags=["采购"], summary="审批采购订单（校验合格供方）")
def approve_po(oid: int, db: Session = Depends(get_db), user: User = Depends(require("purchase"))):
    po = db.get(PurchaseOrder, oid)
    if not po:
        raise NotFound("采购订单")
    if po.status != "DRAFT":
        raise BizError("只有草稿可以审批")
    sup = po.supplier
    if sup.status != "QUALIFIED":
        raise BizError(f"供应商【{sup.name}】不在合格供方名录内（当前：{sup.status}），不能下单（GMP 采购控制）")
    if sup.qualification_expiry and sup.qualification_expiry < today():
        raise BizError(f"供应商【{sup.name}】资质已于 {sup.qualification_expiry} 过期，请先完成供应商再评价")
    po.status, po.approved_by, po.approved_at = "APPROVED", user.full_name, now()
    db.commit()
    return ser(po, ("lines",))


@router.post("/api/purchase-orders/{oid}/cancel", tags=["采购"], summary="取消采购订单")
def cancel_po(oid: int, db: Session = Depends(get_db), _: User = Depends(require("purchase"))):
    po = db.get(PurchaseOrder, oid)
    if not po:
        raise NotFound("采购订单")
    if po.status not in ("DRAFT", "APPROVED") or any((l.received_qty or 0) > 0 for l in po.lines):
        raise BizError("已收货的订单不能取消，请使用“关闭”")
    po.status = "CANCELLED"
    db.commit()
    return ser(po, ("lines",))


@router.post("/api/purchase-orders/{oid}/close", tags=["采购"], summary="关闭采购订单（不再收货）")
def close_po(oid: int, db: Session = Depends(get_db), _: User = Depends(require("purchase"))):
    po = db.get(PurchaseOrder, oid)
    if not po:
        raise NotFound("采购订单")
    if po.status not in ("APPROVED", "PARTIAL_RECEIVED", "RECEIVED"):
        raise BizError("当前状态不能关闭")
    po.status = "CLOSED"
    db.commit()
    return ser(po, ("lines",))


class ReceiveLineIn(BaseModel):
    po_line_id: int
    qty: float = Field(gt=0)
    location_id: int
    lot_no: str | None = None
    supplier_lot: str | None = None
    mfg_date: date | None = None
    expiry_date: date | None = None


class ReceiveIn(BaseModel):
    delivery_note: str | None = None
    remark: str | None = None
    lines: list[ReceiveLineIn]


@router.post("/api/purchase-orders/{oid}/receive", tags=["采购"], summary="采购收货（自动生成 IQC 检验单与应付）")
def receive_po(oid: int, body: ReceiveIn, db: Session = Depends(get_db), user: User = Depends(require("wms", "purchase"))):
    po = db.get(PurchaseOrder, oid)
    if not po:
        raise NotFound("采购订单")
    if po.status not in ("APPROVED", "PARTIAL_RECEIVED"):
        raise BizError("采购订单未审批或已完结，不能收货")
    lines = []
    for ln in body.lines:
        pl = db.get(PurchaseOrderLine, ln.po_line_id)
        if not pl:
            raise NotFound("采购订单行")
        lines.append({**ln.model_dump(), "material_id": pl.material_id})
    rc = wms_svc.receive(db, user, receipt_type="PURCHASE", lines=lines, supplier_id=po.supplier_id, po=po,
                         delivery_note=body.delivery_note, remark=body.remark)
    db.commit()
    return ser(rc, ("lines",))


# ============ MRP ============
@router.post("/api/mrp/run", tags=["计划-MRP"], summary="运行 MRP")
def run_mrp(db: Session = Depends(get_db), user: User = Depends(require("plan"))):
    run = mrp_svc.run_mrp(db, user)
    db.commit()
    return ser(run, ("suggestions",))


@router.get("/api/mrp/runs", tags=["计划-MRP"], summary="MRP 运算记录")
def list_runs(page: int = 1, page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return paginate(db, select(MrpRun).order_by(MrpRun.id.desc()), page, page_size)


@router.get("/api/mrp/runs/{rid}", tags=["计划-MRP"], summary="MRP 结果明细")
def get_run(rid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    run = db.get(MrpRun, rid)
    if not run:
        raise NotFound("MRP 运算")
    return ser(run, ("suggestions",))


class ConvertIn(BaseModel):
    suggestion_ids: list[int]


@router.post("/api/mrp/convert", tags=["计划-MRP"], summary="MRP 建议一键转采购订单/生产工单")
def convert(body: ConvertIn, db: Session = Depends(get_db), user: User = Depends(require("plan", "purchase"))):
    res = mrp_svc.convert_suggestions(db, user, body.suggestion_ids)
    db.commit()
    return res


@router.post("/api/mrp/suggestions/{sid}/ignore", tags=["计划-MRP"], summary="忽略建议")
def ignore_suggestion(sid: int, db: Session = Depends(get_db), _: User = Depends(require("plan", "purchase"))):
    s = db.get(MrpSuggestion, sid)
    if not s:
        raise NotFound("建议")
    s.status = "IGNORED"
    db.commit()
    return ser(s)


# ============ 应收应付 ============
@router.get("/api/finance/docs", tags=["财务"], summary="应收/应付单据")
def list_fin(doc_type: str | None = None, status: str | None = None, q: str | None = None, page: int = 1,
             page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(FinanceDoc).order_by(FinanceDoc.id.desc())
    if doc_type:
        stmt = stmt.where(FinanceDoc.doc_type == doc_type)
    if status:
        stmt = stmt.where(FinanceDoc.status.in_(status.split(",")))
    if q:
        stmt = stmt.where(or_(FinanceDoc.no.ilike(f"%{q}%"), FinanceDoc.ref_no.ilike(f"%{q}%")))
    return paginate(db, stmt, page, page_size, ("payments",))


class PaymentIn(BaseModel):
    pay_date: date | None = None
    amount: float = Field(gt=0)
    method: str | None = "银行转账"
    reference: str | None = None
    remark: str | None = None


@router.post("/api/finance/docs/{did}/payments", tags=["财务"], summary="登记收款/付款")
def add_payment(did: int, body: PaymentIn, db: Session = Depends(get_db), user: User = Depends(require("finance"))):
    d = db.get(FinanceDoc, did)
    if not d:
        raise NotFound("单据")
    if body.amount > d.balance + 0.005:
        raise BizError(f"金额超过未结余额 {d.balance:.2f}")
    d.payments.append(Payment(pay_date=body.pay_date or today(), amount=body.amount, method=body.method,
                              reference=body.reference, remark=body.remark, created_by=user.username))
    d.paid_amount = round((d.paid_amount or 0) + body.amount, 2)
    d.status = "PAID" if d.paid_amount + 0.005 >= d.amount else "PARTIAL"
    db.commit()
    return ser(d, ("payments",))


@router.get("/api/finance/summary", tags=["财务"], summary="应收应付账龄汇总")
def fin_summary(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    buckets = {"AR": {}, "AP": {}}
    t = today()
    for d in db.scalars(select(FinanceDoc).where(FinanceDoc.status != "PAID")):
        overdue = (t - d.due_date).days if d.due_date else 0
        b = "未到期" if overdue <= 0 else ("1-30天" if overdue <= 30 else ("31-90天" if overdue <= 90 else "90天以上"))
        row = buckets[d.doc_type].setdefault(d.partner_name or "-", {"partner": d.partner_name, "未到期": 0, "1-30天": 0,
                                                                    "31-90天": 0, "90天以上": 0, "total": 0})
        row[b] = round(row[b] + d.balance, 2)
        row["total"] = round(row["total"] + d.balance, 2)
    return {k: list(v.values()) for k, v in buckets.items()}
