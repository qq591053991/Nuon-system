"""MRP 物料需求计划：
  独立需求 = 已确认销售订单未发数量；
  成品净需求 = 毛需求 − 成品库存(合格+待放行) − 在制工单未完工数量；
  组件毛需求 = 父项净需求 × 单位用量 ×(1+损耗) + 在制工单未领料数量；
  组件净需求 = 毛需求 + 安全库存 − 库存(合格+待检) − 采购在途；
按低阶码逐层展开。自制件建议“生产”，外购件建议“采购”，客供料建议“通知客户供料”。"""
import math
from collections import defaultdict
from datetime import date, timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import now, today
from ..errors import BizError
from ..models import (
    Bom, Material, MrpRun, MrpSuggestion, PurchaseOrder, PurchaseOrderLine, SalesOrder, User, WorkOrder,
)
from . import inventory as inv
from .numbering import next_no
from .production import released_bom


def _low_level_codes(db: Session) -> tuple[dict[int, int], dict[int, Bom]]:
    boms = {b.material_id: b for b in db.scalars(select(Bom).where(Bom.status == "RELEASED").order_by(Bom.id))}
    llc: dict[int, int] = defaultdict(int)

    def walk(mid: int, level: int, path: tuple):
        if mid in path:
            raise BizError("BOM 存在循环引用")
        llc[mid] = max(llc[mid], level)
        b = boms.get(mid)
        if b:
            for ln in b.lines:
                walk(ln.component_id, level + 1, path + (mid,))

    for mid in list(boms):
        walk(mid, 0, ())
    return llc, boms


def run_mrp(db: Session, user: User) -> MrpRun:
    llc, boms = _low_level_codes(db)
    gross: dict[int, float] = defaultdict(float)
    need_date: dict[int, date] = {}

    def add_gross(mid: int, qty: float, d: date | None):
        if qty <= 1e-9:
            return
        gross[mid] += qty
        if d and (mid not in need_date or d < need_date[mid]):
            need_date[mid] = d

    # 1) 独立需求：销售订单
    sos = db.scalars(select(SalesOrder).where(SalesOrder.status.in_(("CONFIRMED", "IN_PRODUCTION", "PARTIAL_SHIPPED"))))
    for so in sos:
        for ln in so.lines:
            add_gross(ln.material_id, round(ln.qty - (ln.shipped_qty or 0), 4), ln.delivery_date or so.delivery_date)
    # 2) 在制工单：未完工数量作为成品供给；未领料数量作为组件毛需求
    wip_supply: dict[int, float] = defaultdict(float)
    open_wos = db.scalars(select(WorkOrder).where(WorkOrder.status.in_(("PLANNED", "RELEASED", "IN_PROGRESS"))))
    for wo in open_wos:
        wip_supply[wo.material_id] += max(wo.planned_qty - (wo.completed_qty or 0) - (wo.scrap_qty or 0), 0)
        if wo.status == "PLANNED" or not wo.materials:
            b = boms.get(wo.material_id)
            if b:
                for ln in b.lines:
                    add_gross(ln.component_id, wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate or 0)), wo.planned_start)
        else:
            for m in wo.materials:
                add_gross(m.material_id, max(m.required_qty - (m.issued_qty or 0), 0), wo.planned_start)
    # 3) 采购在途
    on_order: dict[int, float] = defaultdict(float)
    pos = db.scalars(select(PurchaseOrderLine).join(PurchaseOrder)
                     .where(PurchaseOrder.status.in_(("DRAFT", "APPROVED", "PARTIAL_RECEIVED"))))
    for pl in pos:
        on_order[pl.material_id] += max(pl.qty - (pl.received_qty or 0), 0)

    run = MrpRun(no=next_no(db, "MRP"), run_at=now(), run_by=user.full_name, created_by=user.username)
    db.add(run)
    max_level = max(llc.values(), default=0)
    all_mids = set(gross) | set(llc)
    for level in range(0, max_level + 1):
        for mid in sorted(m for m in all_mids if llc.get(m, 0) == level):
            g = round(gross.get(mid, 0), 4)
            m = db.get(Material, mid)
            if not m:
                continue
            stock = inv.on_hand(db, mid)
            supply = stock + on_order[mid] + wip_supply[mid]
            ss = m.safety_stock or 0
            net = round(g + ss - supply, 4)
            if g <= 1e-9 and net <= 1e-9:
                continue
            b = boms.get(mid)
            if net > 1e-9:
                qty = net
                if (m.uom or "").upper() in ("PCS", "EA", "SET") or m.uom in ("个", "台", "只", "套", "片", "件"):
                    qty = float(math.ceil(net - 1e-9))
                if m.min_order_qty and qty < m.min_order_qty and not b:
                    qty = m.min_order_qty
                if b:
                    action = "PRODUCE"
                    for ln in b.lines:
                        add_gross(ln.component_id, net * ln.qty_per * (1 + (ln.scrap_rate or 0)), need_date.get(mid))
                        all_mids.add(ln.component_id)
                elif m.owner_customer_id:
                    action = "CUSTOMER_SUPPLY"
                else:
                    action = "PURCHASE"
                due = need_date.get(mid) or today()
                due = due - timedelta(days=m.lead_time_days or 0)
                run.suggestions.append(MrpSuggestion(
                    material_id=mid, level=level, action=action, gross_qty=g, on_hand_qty=stock,
                    on_order_qty=round(on_order[mid] + wip_supply[mid], 4), safety_stock=ss, net_qty=net,
                    suggested_qty=qty, due_date=max(due, today()),
                    supplier_id=m.default_supplier_id if action == "PURCHASE" else None,
                    customer_id=m.owner_customer_id if action == "CUSTOMER_SUPPLY" else (m.customer_id if action == "PRODUCE" else None),
                    remark="交期紧张：建议日期早于今天" if due < today() else None,
                ))
    cnt = defaultdict(int)
    for s in run.suggestions:
        cnt[s.action] += 1
    run.summary = f"生产建议 {cnt['PRODUCE']} 条，采购建议 {cnt['PURCHASE']} 条，客供料通知 {cnt['CUSTOMER_SUPPLY']} 条"
    db.flush()
    return run


def convert_suggestions(db: Session, user: User, ids: list[int]) -> dict:
    sugs = list(db.scalars(select(MrpSuggestion).where(MrpSuggestion.id.in_(ids), MrpSuggestion.status == "OPEN")))
    created_pos, created_wos, skipped = [], [], []
    by_supplier: dict[int, list[MrpSuggestion]] = defaultdict(list)
    for s in sugs:
        if s.action == "PURCHASE":
            if not s.supplier_id:
                skipped.append(f"{s.material_code}：未设置默认供应商")
                continue
            by_supplier[s.supplier_id].append(s)
        elif s.action == "PRODUCE":
            m = s.material
            if not released_bom(db, m.id):
                skipped.append(f"{m.code}：无已发布 BOM")
                continue
            wo = WorkOrder(no=next_no(db, "WO"), material_id=m.id, customer_id=m.customer_id, planned_qty=s.suggested_qty,
                           planned_start=s.due_date, planned_end=s.due_date + timedelta(days=m.lead_time_days or 0),
                           status="PLANNED", source=f"MRP", created_by=user.username)
            db.add(wo)
            db.flush()
            s.status, s.converted_doc_no = "CONVERTED", wo.no
            created_wos.append(wo.no)
        else:
            skipped.append(f"{s.material_code}：客供料，请通知客户供料")
    for sup_id, items in by_supplier.items():
        po = PurchaseOrder(no=next_no(db, "PO"), supplier_id=sup_id, order_date=today(),
                           expected_date=min(i.due_date for i in items), status="DRAFT", source="MRP",
                           created_by=user.username)
        total = 0.0
        for n, s in enumerate(items, start=1):
            price = s.material.std_cost or 0
            po.lines.append(PurchaseOrderLine(line_no=n, material_id=s.material_id, qty=s.suggested_qty, unit_price=price,
                                              amount=round(price * s.suggested_qty, 2), expected_date=s.due_date))
            total += price * s.suggested_qty
        po.total_amount = round(total, 2)
        db.add(po)
        db.flush()
        for s in items:
            s.status, s.converted_doc_no = "CONVERTED", po.no
        created_pos.append(po.no)
    db.flush()
    return {"purchase_orders": created_pos, "work_orders": created_wos, "skipped": skipped}
