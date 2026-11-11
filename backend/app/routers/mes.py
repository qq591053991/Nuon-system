"""MES 路由：生产工单、工位终端（扫码过站）、完工入库、DHR 与产品放行。"""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..crud import paginate
from ..db import get_db
from ..errors import BizError, NotFound
from ..models import Material, OperationRecord, SerialNumber, User, WorkOrder
from ..security import SignatureIn, get_current_user, require
from ..serial import ser, ser_list
from ..services import production as svc
from ..services.numbering import next_no

router = APIRouter(tags=["生产MES"])
WO_CHILDREN = ("materials", "operations")


def _wo(db: Session, wid: int) -> WorkOrder:
    wo = db.get(WorkOrder, wid)
    if not wo:
        raise NotFound("生产工单")
    return wo


def _wo_out(wo: WorkOrder) -> dict:
    d = ser(wo, WO_CHILDREN)
    for od, o in zip(d["operations"], wo.operations):
        od["params"] = o.params
    return d


@router.get("/api/work-orders", summary="生产工单列表")
def list_wo(q: str | None = None, status: str | None = None, material_id: int | None = None,
            customer_id: int | None = None, dhr_status: str | None = None, page: int = 1, page_size: int = 20,
            db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(WorkOrder).join(Material, WorkOrder.material_id == Material.id).order_by(WorkOrder.id.desc())
    if q:
        stmt = stmt.where(or_(WorkOrder.no.ilike(f"%{q}%"), WorkOrder.lot_no.ilike(f"%{q}%"),
                              Material.code.ilike(f"%{q}%"), Material.name.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(WorkOrder.status.in_(status.split(",")))
    if material_id:
        stmt = stmt.where(WorkOrder.material_id == material_id)
    if customer_id:
        stmt = stmt.where(WorkOrder.customer_id == customer_id)
    if dhr_status:
        stmt = stmt.where(WorkOrder.dhr_status == dhr_status)
    return paginate(db, stmt, page, page_size)


@router.get("/api/work-orders/{wid}", summary="生产工单详情（用料、工序进度）")
def get_wo(wid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return _wo_out(_wo(db, wid))


class WoIn(BaseModel):
    material_id: int
    planned_qty: float = Field(gt=0)
    customer_id: int | None = None
    so_id: int | None = None
    so_line_id: int | None = None
    bom_id: int | None = None
    routing_id: int | None = None
    planned_start: date | None = None
    planned_end: date | None = None
    priority: int = 3
    remark: str | None = None


@router.post("/api/work-orders", summary="新建生产工单")
def create_wo(body: WoIn, db: Session = Depends(get_db), user: User = Depends(require("plan"))):
    m = db.get(Material, body.material_id)
    if not m or m.category not in ("FINISHED", "SEMI"):
        raise BizError("请选择成品或半成品")
    wo = WorkOrder(no=next_no(db, "WO"), status="PLANNED", created_by=user.username, **body.model_dump())
    wo.customer_id = wo.customer_id or m.customer_id
    db.add(wo)
    db.commit()
    return _wo_out(wo)


@router.put("/api/work-orders/{wid}", summary="修改生产工单（仅计划状态）")
def update_wo(wid: int, body: WoIn, db: Session = Depends(get_db), _: User = Depends(require("plan"))):
    wo = _wo(db, wid)
    if wo.status != "PLANNED":
        raise BizError("工单已下达，不能修改")
    for k, v in body.model_dump(exclude_unset=True).items():
        setattr(wo, k, v)
    db.commit()
    return _wo_out(wo)


@router.post("/api/work-orders/{wid}/release", summary="下达工单（快照 BOM/工艺，生成批号、序列号与 UDI）")
def release_wo(wid: int, db: Session = Depends(get_db), user: User = Depends(require("plan"))):
    wo = svc.release_work_order(db, _wo(db, wid), user)
    db.commit()
    return _wo_out(wo)


@router.post("/api/work-orders/{wid}/cancel", summary="取消工单")
def cancel_wo(wid: int, db: Session = Depends(get_db), _: User = Depends(require("plan"))):
    wo = _wo(db, wid)
    if wo.status not in ("PLANNED", "RELEASED"):
        raise BizError("已开工的工单不能取消")
    if any((m.issued_qty or 0) > 0 for m in wo.materials):
        raise BizError("工单已领料，请先退料")
    wo.status = "CANCELLED"
    for s in db.scalars(select(SerialNumber).where(SerialNumber.wo_id == wid)):
        s.status = "SCRAPPED"
    db.commit()
    return _wo_out(wo)


@router.get("/api/work-orders/{wid}/serials", summary="工单序列号/UDI 清单")
def wo_serials(wid: int, status: str | None = None, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(SerialNumber).where(SerialNumber.wo_id == wid).order_by(SerialNumber.sn)
    if status:
        stmt = stmt.where(SerialNumber.status == status)
    return ser_list(db.scalars(stmt))


@router.get("/api/work-orders/{wid}/records", summary="工单报工记录（含测试数据）")
def wo_records(wid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    recs = db.scalars(select(OperationRecord).where(OperationRecord.wo_id == wid).order_by(OperationRecord.id.desc()))
    return ser_list(recs, ("values",))


# ---------- 工位终端 ----------
@router.get("/api/mes/scan/{sn}", summary="工位扫码：返回产品信息、下一道工序、测试规格、历史")
def scan(sn: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return svc.scan_serial(db, sn)


class KeyPartIn(BaseModel):
    lot_no: str | None = None
    part_sn: str | None = None


class ReportIn(BaseModel):
    sn: str
    seq: int | None = None  # 工位所在工序，用于防跳站校验
    result: str | None = None  # 可选：人工判 FAIL（如外观不良）
    values: dict[str, float | None] = {}
    equipment_id: int | None = None
    remark: str | None = None
    key_parts: list[KeyPartIn] = []


@router.post("/api/mes/report", summary="序列号过站报工（测试数据自动判定，不合格自动开 NCR）")
def report(body: ReportIn, db: Session = Depends(get_db), user: User = Depends(require("mes"))):
    res = svc.report_serial(db, user, sn_text=body.sn, seq=body.seq, result=body.result, values=body.values,
                            equipment_id=body.equipment_id, remark=body.remark,
                            key_parts=[k.model_dump() for k in body.key_parts])
    db.commit()
    return res


class BatchReportIn(BaseModel):
    seq: int
    good_qty: float = 0
    ng_qty: float = 0
    values: dict[str, float | None] = {}
    equipment_id: int | None = None
    remark: str | None = None


@router.post("/api/work-orders/{wid}/report-batch", summary="批量报工（非序列号产品）")
def report_batch(wid: int, body: BatchReportIn, db: Session = Depends(get_db), user: User = Depends(require("mes"))):
    res = svc.report_batch(db, user, wo=_wo(db, wid), seq=body.seq, good_qty=body.good_qty, ng_qty=body.ng_qty,
                           values=body.values, equipment_id=body.equipment_id, remark=body.remark)
    db.commit()
    return res


class FgReceiptIn(BaseModel):
    location_id: int
    qty: float | None = None


@router.post("/api/work-orders/{wid}/fg-receipt", summary="完工入库（成品待放行）")
def fg_receipt(wid: int, body: FgReceiptIn, db: Session = Depends(get_db), user: User = Depends(require("wms", "plan"))):
    rc = svc.fg_receipt(db, user, _wo(db, wid), body.location_id, body.qty)
    db.commit()
    return ser(rc, ("lines",))


@router.get("/api/work-orders/{wid}/dhr", summary="电子 DHR（器械生产记录）")
def dhr(wid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return svc.build_dhr(db, _wo(db, wid))


class DhrReleaseIn(BaseModel):
    approve: bool = True
    reason: str | None = None
    signature: SignatureIn


@router.post("/api/work-orders/{wid}/dhr/release", summary="DHR 审核与产品放行（QA 电子签名）")
def dhr_release(wid: int, body: DhrReleaseIn, db: Session = Depends(get_db), user: User = Depends(require("qa"))):
    if body.signature and body.reason and not body.signature.reason:
        body.signature.reason = body.reason
    wo = svc.release_dhr(db, user, _wo(db, wid), body.approve, body.signature, body.reason)
    db.commit()
    return _wo_out(wo)
