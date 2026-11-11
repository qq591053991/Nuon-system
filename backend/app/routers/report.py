"""驾驶舱、我的待办、追溯、全局搜索。"""
from collections import defaultdict
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import today
from ..db import get_db
from ..models import (
    Bom, Capa, Equipment, Inspection, Material, MaterialIssue, Ncr, OperationRecord, PurchaseOrder, Routing,
    SalesOrder, SerialNumber, Shipment, Stock, Supplier, User, WorkOrder,
)
from ..security import get_current_user, user_permissions
from ..services import trace as trace_svc

router = APIRouter(tags=["驾驶舱/追溯"])


def _count(db: Session, stmt) -> int:
    return db.scalar(select(func.count()).select_from(stmt.subquery())) or 0


@router.get("/api/dashboard", summary="经营驾驶舱")
def dashboard(db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    t = today()
    open_so = list(db.scalars(select(SalesOrder).where(SalesOrder.status.in_(("CONFIRMED", "IN_PRODUCTION", "PARTIAL_SHIPPED")))))
    overdue_so = [s for s in open_so if s.delivery_date and s.delivery_date < t]
    wo_status = dict(db.execute(select(WorkOrder.status, func.count()).group_by(WorkOrder.status)).all())
    wip_qty = db.scalar(select(func.sum(WorkOrder.planned_qty - WorkOrder.completed_qty - WorkOrder.scrap_qty))
                        .where(WorkOrder.status.in_(("RELEASED", "IN_PROGRESS")))) or 0

    # 近 14 天产出（序列号完工 + 批量末道工序合格）
    start = t - timedelta(days=13)
    output = defaultdict(float)
    for ts in db.scalars(select(SerialNumber.completed_at).where(SerialNumber.completed_at >= datetime.combine(start, datetime.min.time()))):
        output[ts.date().isoformat()] += 1
    days = [(start + timedelta(days=i)).isoformat() for i in range(14)]

    # 一次直通率（按工序，近 30 天，按序列号首次测试结果）
    since = datetime.combine(t - timedelta(days=30), datetime.min.time())
    first: dict[tuple, str] = {}
    names: dict[str, str] = {}
    for r in db.scalars(select(OperationRecord).where(OperationRecord.ts >= since, OperationRecord.sn_id.is_not(None))
                        .order_by(OperationRecord.id)):
        first.setdefault((r.op_name, r.sn_id), r.result)
        names[r.op_name] = r.op_name
    fpy = []
    for op in names:
        res = [v for (o, _), v in first.items() if o == op]
        fpy.append({"op_name": op, "tested": len(res), "fpy": round(sum(1 for v in res if v == "PASS") / len(res) * 100, 1)})
    overall_fpy = None
    if first:
        sns = {sn for (_, sn) in first}
        passed_all = sum(1 for sn in sns if all(v == "PASS" for (o, s), v in first.items() if s == sn))
        overall_fpy = round(passed_all / len(sns) * 100, 1)

    iqc_done = list(db.scalars(select(Inspection.status).where(Inspection.inspected_at >= since)))
    iqc_rate = round(sum(1 for s in iqc_done if s == "PASSED") / len(iqc_done) * 100, 1) if iqc_done else None
    ncr_src = dict(db.execute(select(Ncr.source, func.count()).where(Ncr.created_at >= since).group_by(Ncr.source)).all())

    stock_value = 0.0
    for qty, cost in db.execute(select(Stock.qty, Material.std_cost).join(Material)):
        stock_value += (qty or 0) * (cost or 0)
    avail = dict(db.execute(select(Stock.material_id, func.sum(Stock.qty)).where(Stock.status == "AVAILABLE")
                            .group_by(Stock.material_id)).all())
    below = [m for m in db.scalars(select(Material).where(Material.safety_stock > 0, Material.is_active.is_(True)))
             if (avail.get(m.id) or 0) < m.safety_stock]
    expiring = _count(db, select(Stock.id).where(Stock.qty > 0, Stock.expiry_date.is_not(None),
                                                 Stock.expiry_date <= t + timedelta(days=30)))
    cal_due = list(db.scalars(select(Equipment).where(Equipment.calibration_required.is_(True),
                                                      Equipment.next_calibration_date <= t + timedelta(days=30))
                              .order_by(Equipment.next_calibration_date)))
    sup_exp = list(db.scalars(select(Supplier).where(Supplier.status == "QUALIFIED", Supplier.qualification_expiry.is_not(None),
                                                     Supplier.qualification_expiry <= t + timedelta(days=60))))
    return {
        "kpi": {
            "open_so": len(open_so), "open_so_amount": round(sum(s.total_amount or 0 for s in open_so), 2),
            "overdue_so": len(overdue_so), "wip_wo": wo_status.get("RELEASED", 0) + wo_status.get("IN_PROGRESS", 0),
            "wip_qty": round(wip_qty, 2), "today_output": output.get(t.isoformat(), 0), "fpy": overall_fpy,
            "pending_iqc": _count(db, select(Inspection.id).where(Inspection.status == "PENDING")),
            "iqc_pass_rate": iqc_rate,
            "open_ncr": _count(db, select(Ncr.id).where(Ncr.status == "OPEN")),
            "open_capa": _count(db, select(Capa.id).where(Capa.status != "CLOSED")),
            "pending_release": _count(db, select(WorkOrder.id).where(WorkOrder.status == "COMPLETED", WorkOrder.dhr_status == "OPEN")),
            "stock_value": round(stock_value, 2), "below_safety": len(below), "expiring_lots": expiring,
            "calibration_due": len(cal_due),
        },
        "wo_status": wo_status,
        "output_trend": [{"date": d, "qty": output.get(d, 0)} for d in days],
        "fpy_by_op": fpy,
        "ncr_by_source": [{"source": k, "count": v} for k, v in ncr_src.items()],
        "alerts": (
            [{"level": "error" if (e.next_calibration_date and e.next_calibration_date < t) else "warning",
              "text": f"设备 {e.code} {e.name} 校准{'已过期' if e.next_calibration_date < t else '即将到期'}（{e.next_calibration_date}）"}
             for e in cal_due]
            + [{"level": "warning", "text": f"供应商 {s.name} 资质将于 {s.qualification_expiry} 到期"} for s in sup_exp]
            + [{"level": "warning", "text": f"物料 {m.code} {m.name} 低于安全库存（{avail.get(m.id) or 0:g}/{m.safety_stock:g}）"} for m in below[:10]]
            + [{"level": "error", "text": f"销售订单 {s.no}（{s.customer_name}）已逾期，交期 {s.delivery_date}"} for s in overdue_so[:10]]
        ),
    }


@router.get("/api/todos", summary="我的待办（按角色）")
def todos(db: Session = Depends(get_db), user: User = Depends(get_current_user)):
    p = user_permissions(user)
    items = []

    def add(perm, key, title, stmt, path):
        if perm in p:
            n = _count(db, stmt)
            if n:
                items.append({"key": key, "title": title, "count": n, "path": path})

    add("qc", "iqc", "待检验的来料（IQC）", select(Inspection.id).where(Inspection.status == "PENDING"), "/quality/inspections")
    add("qa", "ncr", "待评审处置的不合格品（NCR）", select(Ncr.id).where(Ncr.status == "OPEN"), "/quality/ncrs")
    add("qa", "dhr", "待审核放行的生产批（DHR）",
        select(WorkOrder.id).where(WorkOrder.status == "COMPLETED", WorkOrder.dhr_status == "OPEN"), "/quality/release")
    add("qa", "capa", "进行中的 CAPA", select(Capa.id).where(Capa.status != "CLOSED"), "/quality/capas")
    add("plan", "so_no_wo", "已确认待排产的销售订单", select(SalesOrder.id).where(SalesOrder.status == "CONFIRMED"), "/sales/orders")
    add("plan", "wo_planned", "待下达的生产工单", select(WorkOrder.id).where(WorkOrder.status == "PLANNED"), "/mes/work-orders")
    add("purchase", "po_draft", "待审批的采购订单", select(PurchaseOrder.id).where(PurchaseOrder.status == "DRAFT"), "/purchase/orders")
    add("wms", "po_receive", "待收货的采购订单",
        select(PurchaseOrder.id).where(PurchaseOrder.status.in_(("APPROVED", "PARTIAL_RECEIVED"))), "/purchase/orders")
    add("wms", "issue", "待过账的领料单", select(MaterialIssue.id).where(MaterialIssue.status == "DRAFT"), "/wms/issues")
    add("wms", "ship", "待过账的发货单", select(Shipment.id).where(Shipment.status == "DRAFT"), "/wms/shipments")
    add("wms", "fg", "待完工入库的工单",
        select(WorkOrder.id).where(WorkOrder.status.in_(("IN_PROGRESS", "COMPLETED")), WorkOrder.completed_qty > WorkOrder.received_qty),
        "/mes/work-orders")
    add("engineering", "bom", "待发布的 BOM 草稿", select(Bom.id).where(Bom.status == "DRAFT"), "/engineering/boms")
    add("engineering", "routing", "待发布的工艺路线草稿", select(Routing.id).where(Routing.status == "DRAFT"), "/engineering/routings")
    add("master", "calib", "校准过期的设备",
        select(Equipment.id).where(Equipment.calibration_required.is_(True), Equipment.next_calibration_date < today()),
        "/master/equipment")
    add("sales", "so_draft", "待确认的销售订单", select(SalesOrder.id).where(SalesOrder.status == "DRAFT"), "/sales/orders")
    return items


@router.get("/api/trace/serial/{sn}", summary="反向追溯：序列号 → 物料批次/工序/测试/发货")
def trace_serial(sn: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return trace_svc.trace_serial(db, sn)


@router.get("/api/trace/lot", summary="正向追溯：物料批次 → 工单 → 序列号 → 客户（召回范围）")
def trace_lot(material_code: str, lot_no: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return trace_svc.trace_lot(db, material_code, lot_no)


@router.get("/api/search", summary="全局搜索")
def search(q: str, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    return trace_svc.global_search(db, q)
