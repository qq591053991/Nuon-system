"""仓储业务：采购收货/客供料收货（自动生成 IQC）、生产领料（FEFO + 客供料隔离）、发货（仅已放行产品）、
调拨、盘点。并自动生成应付/应收。"""
import json
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import now, today
from ..errors import BizError, NotFound
from ..models import (
    FinanceDoc, Location, Material, MaterialIssue, MaterialIssueLine, PurchaseOrder, PurchaseOrderLine, Receipt,
    ReceiptLine, SalesOrder, SalesOrderLine, SerialNumber, Shipment, ShipmentLine, Stock, StockCount,
    StockCountLine, User, WorkOrder,
)
from . import inventory as inv
from .numbering import next_no
from .quality import create_iqc


def _lot_for(db: Session, material: Material, lot_no: str | None) -> str:
    if lot_no:
        return lot_no.strip()
    return next_no(db, "L") if material.lot_control else ""


def receive(db: Session, user: User, *, receipt_type: str, lines: list[dict], supplier_id: int | None = None,
            customer_id: int | None = None, po: PurchaseOrder | None = None, delivery_note: str | None = None,
            remark: str | None = None) -> Receipt:
    """收货。需检验物料 → 待检(QUARANTINE) 并自动生成 IQC 检验单；免检物料 → 合格(AVAILABLE)。"""
    if not lines:
        raise BizError("请至少录入一行收货明细")
    if receipt_type == "CUSTOMER_SUPPLIED" and not customer_id:
        raise BizError("客供料收货必须指定客户（货主）")
    rc = Receipt(no=next_no(db, "RK"), receipt_type=receipt_type, supplier_id=supplier_id, customer_id=customer_id,
                 po_id=po.id if po else None, receipt_date=today(), status="CONFIRMED", delivery_note=delivery_note,
                 remark=remark, created_by=user.username)
    db.add(rc)
    db.flush()
    move_type = {"PURCHASE": "PO_RECEIPT", "CUSTOMER_SUPPLIED": "CS_RECEIPT", "OPENING": "OPENING"}.get(receipt_type, "OTHER_RECEIPT")
    ref = inv.Ref("RECEIPT", rc.id, rc.no, user.username, remark)
    ap_amount = 0.0
    for i, ln in enumerate(lines, start=1):
        m = db.get(Material, ln["material_id"])
        if not m:
            raise NotFound("物料")
        qty = float(ln.get("qty") or 0)
        if qty <= 0:
            raise BizError(f"{m.code} 收货数量必须大于 0")
        owner = None
        if m.owner_customer_id:
            if receipt_type not in ("CUSTOMER_SUPPLIED", "OPENING", "OTHER"):
                raise BizError(f"{m.code} 是客供料，请使用“客供料收货”")
            if customer_id and m.owner_customer_id != customer_id:
                raise BizError(f"{m.code} 的货主不是该客户")
            owner = m.owner_customer_id
        elif receipt_type == "CUSTOMER_SUPPLIED":
            raise BizError(f"{m.code} 不是该客户的客供料（请在物料主数据中设置货主）")
        po_line = None
        if po:
            po_line = db.get(PurchaseOrderLine, ln.get("po_line_id"))
            if not po_line or po_line.order_id != po.id:
                raise BizError("采购订单行不匹配")
            if po_line.material_id != m.id:
                raise BizError("收货物料与订单行物料不一致")
            remain = round(po_line.qty - (po_line.received_qty or 0), 4)
            if qty > remain * 1.05 + 1e-9:  # 允许 5% 超收
                raise BizError(f"{m.code} 超收：订单剩余 {remain:g}，本次 {qty:g}（允许超收 5%）")
            po_line.received_qty = round((po_line.received_qty or 0) + qty, 4)
            ap_amount += qty * (po_line.unit_price or 0)
        loc_id = ln.get("location_id")
        if not loc_id or not db.get(Location, loc_id):
            raise BizError(f"{m.code} 请选择收货库位")
        status = "QUARANTINE" if (m.iqc_required and receipt_type != "OPENING") else "AVAILABLE"
        lot = _lot_for(db, m, ln.get("lot_no"))
        mfg = ln.get("mfg_date")
        exp = ln.get("expiry_date") or (mfg + timedelta(days=m.shelf_life_days) if (mfg and m.shelf_life_days) else None)
        rl = ReceiptLine(line_no=i, material_id=m.id, po_line_id=po_line.id if po_line else None, qty=qty, lot_no=lot,
                         supplier_lot=ln.get("supplier_lot"), location_id=loc_id, status=status, mfg_date=mfg,
                         expiry_date=exp)
        rc.lines.append(rl)
        db.flush()
        inv.add_stock(db, material_id=m.id, location_id=loc_id, lot_no=lot, status=status, qty=qty,
                      move_type=move_type, ref=ref, owner_customer_id=owner, mfg_date=mfg, expiry_date=exp,
                      supplier_id=supplier_id, supplier_lot=ln.get("supplier_lot"))
        if status == "QUARANTINE":
            create_iqc(db, receipt=rc, line=rl, material=m, username=user.username)
    if po:
        lines_all = po.lines
        if all((l.received_qty or 0) + 1e-9 >= l.qty for l in lines_all):
            po.status = "RECEIVED"
        else:
            po.status = "PARTIAL_RECEIVED"
        if ap_amount > 0:
            sup = po.supplier
            db.add(FinanceDoc(no=next_no(db, "AP"), doc_type="AP", supplier_id=po.supplier_id, ref_type="RECEIPT",
                              ref_no=rc.no, doc_date=today(), currency=po.currency,
                              due_date=today() + timedelta(days=sup.payment_terms_days if sup else 30),
                              amount=round(ap_amount, 2), status="OPEN", remark=f"采购订单 {po.no} 入库",
                              created_by=user.username))
    db.flush()
    return rc


# ---------------- 生产领料 ----------------

def _pending_issue_qty(db: Session, wo_id: int, material_id: int) -> float:
    rows = db.scalars(select(MaterialIssueLine).join(MaterialIssue).where(
        MaterialIssue.wo_id == wo_id, MaterialIssue.status == "DRAFT", MaterialIssueLine.material_id == material_id))
    return round(sum(r.qty for r in rows), 4)


def create_issue(db: Session, user: User, wo: WorkOrder, lines: list[dict] | None = None) -> tuple[MaterialIssue, list[dict]]:
    if wo.status not in ("RELEASED", "IN_PROGRESS"):
        raise BizError("工单未下达或已完工，不能领料")
    issue = MaterialIssue(no=next_no(db, "LL"), wo_id=wo.id, status="DRAFT", created_by=user.username)
    shortages = []
    wo_mats = {m.material_id: m for m in wo.materials}
    if lines:  # 手工指定批次
        for ln in lines:
            m = wo_mats.get(ln["material_id"])
            if not m:
                raise BizError("非本工单 BOM 物料，不能领用")
            st = db.get(Stock, ln["stock_id"]) if ln.get("stock_id") else None
            if not st or st.material_id != m.material_id:
                raise BizError("请选择有效的库存批次")
            _check_stock_usable(st, wo)
            issue.lines.append(MaterialIssueLine(material_id=st.material_id, lot_no=st.lot_no, location_id=st.location_id,
                                                 owner_customer_id=st.owner_customer_id, qty=float(ln["qty"]),
                                                 expiry_date=st.expiry_date))
    else:  # 系统按 FEFO 自动分配
        for m in wo.materials:
            need = round(m.required_qty - (m.issued_qty or 0) - _pending_issue_qty(db, wo.id, m.material_id), 4)
            if need <= 1e-9:
                continue
            mat = m.material
            if mat.owner_customer_id and mat.owner_customer_id != wo.customer_id:
                raise BizError(f"{mat.code} 为其他客户的客供料，不能用于本工单")
            alloc, short = inv.allocate(db, m.material_id, need)
            for st, q in alloc:
                issue.lines.append(MaterialIssueLine(material_id=st.material_id, lot_no=st.lot_no, location_id=st.location_id,
                                                     owner_customer_id=st.owner_customer_id, qty=q, expiry_date=st.expiry_date))
            if short > 1e-9:
                shortages.append({"material_id": m.material_id, "material_code": mat.code, "material_name": mat.name,
                                  "required": need, "shortage": short, "customer_supplied": bool(mat.owner_customer_id)})
    if not issue.lines:
        raise BizError("没有可领用的合格库存" + ("（缺料：" + "、".join(s["material_code"] for s in shortages) + "）" if shortages else "，物料已领齐"))
    db.add(issue)
    db.flush()
    return issue, shortages


def _check_stock_usable(st: Stock, wo: WorkOrder):
    if st.status != "AVAILABLE":
        raise BizError(f"批次 {st.lot_no} 质量状态为【{inv.STATUS_TEXT.get(st.status, st.status)}】，不能领用")
    if st.owner_customer_id and st.owner_customer_id != wo.customer_id:
        raise BizError(f"批次 {st.lot_no} 为其他客户的客供料，不能用于本工单")
    if st.expiry_date and st.expiry_date < today():
        raise BizError(f"批次 {st.lot_no} 已过期（{st.expiry_date}），禁止使用")


def confirm_issue(db: Session, user: User, issue: MaterialIssue) -> MaterialIssue:
    if issue.status != "DRAFT":
        raise BizError("领料单已过账或已取消")
    wo = issue.work_order
    if wo.status not in ("RELEASED", "IN_PROGRESS"):
        raise BizError("工单状态不允许领料")
    wo_mats = {m.material_id: m for m in wo.materials}
    ref = inv.Ref("ISSUE", issue.id, issue.no, user.username, f"工单 {wo.no} 领料")
    for ln in issue.lines:
        if ln.material_id not in wo_mats:
            raise BizError("非本工单 BOM 物料，不能领用")
        if ln.owner_customer_id and ln.owner_customer_id != wo.customer_id:
            raise BizError("客供料只能用于该客户工单")
        if ln.expiry_date and ln.expiry_date < today():
            raise BizError(f"批次 {ln.lot_no} 已过期，禁止使用")
        inv.remove_stock(db, material_id=ln.material_id, location_id=ln.location_id, lot_no=ln.lot_no,
                         status="AVAILABLE", qty=ln.qty, owner_customer_id=ln.owner_customer_id,
                         move_type="WO_ISSUE", ref=ref)
        wm = wo_mats[ln.material_id]
        wm.issued_qty = round((wm.issued_qty or 0) + ln.qty, 4)
    issue.status = "CONFIRMED"
    issue.confirmed_by = user.full_name
    issue.confirmed_at = now()
    db.flush()
    return issue


# ---------------- 发货 ----------------

def available_serials(db: Session, material_id: int, limit: int = 500) -> list[SerialNumber]:
    q = (select(SerialNumber).join(WorkOrder, SerialNumber.wo_id == WorkOrder.id)
         .where(SerialNumber.material_id == material_id, SerialNumber.status == "IN_STOCK",
                WorkOrder.dhr_status == "RELEASED")
         .order_by(SerialNumber.completed_at, SerialNumber.sn).limit(limit))
    return list(db.scalars(q))


def create_shipment(db: Session, user: User, so: SalesOrder, lines: list[dict], carrier=None, tracking_no=None,
                    ship_to=None, remark=None) -> Shipment:
    if so.status not in ("CONFIRMED", "IN_PRODUCTION", "PARTIAL_SHIPPED"):
        raise BizError("销售订单未确认或已完结，不能发货")
    sh = Shipment(no=next_no(db, "FH"), so_id=so.id, customer_id=so.customer_id, status="DRAFT", carrier=carrier,
                  tracking_no=tracking_no, ship_to=ship_to or so.ship_to, remark=remark, created_by=user.username)
    for ln in lines:
        sol = db.get(SalesOrderLine, ln["so_line_id"])
        if not sol or sol.order_id != so.id:
            raise BizError("订单行不匹配")
        qty = float(ln.get("qty") or 0)
        serials = [s.strip() for s in (ln.get("serials") or []) if s and s.strip()]
        m = sol.material
        if m.serial_control:
            if not serials:
                serials = [s.sn for s in available_serials(db, m.id, int(qty))]
            if qty and len(serials) != int(qty):
                raise BizError(f"{m.code} 发货数量 {qty:g} 与扫描序列号数量 {len(serials)} 不一致（可发已放行库存不足？）")
            qty = len(serials)
        if qty <= 0:
            continue
        remain = round(sol.qty - (sol.shipped_qty or 0), 4)
        if qty > remain + 1e-9:
            raise BizError(f"{m.code} 发货数量超出订单未发数量 {remain:g}")
        if m.serial_control:
            groups: dict[tuple, list[str]] = {}
            for s in serials:
                sn = db.scalar(select(SerialNumber).where(SerialNumber.sn == s))
                if not sn or sn.material_id != m.id:
                    raise BizError(f"序列号 {s} 不存在或不是物料 {m.code}")
                if sn.status != "IN_STOCK":
                    raise BizError(f"序列号 {s} 状态为【{sn.status}】，不可发货")
                if sn.work_order.dhr_status != "RELEASED":
                    raise BizError(f"序列号 {s} 所在批次 {sn.lot_no} 尚未完成 DHR 审核放行，禁止发货")
                groups.setdefault((sn.lot_no or "", sn.location_id), []).append(s)
            for (lot, loc), sns in groups.items():
                sh.lines.append(ShipmentLine(so_line_id=sol.id, material_id=m.id, lot_no=lot, location_id=loc,
                                             qty=len(sns), serials=json.dumps(sns)))
        else:
            alloc, short = inv.allocate(db, m.id, qty)
            if short > 1e-9:
                raise BizError(f"{m.code} 合格可发库存不足，缺 {short:g}")
            for st, q in alloc:
                sh.lines.append(ShipmentLine(so_line_id=sol.id, material_id=m.id, lot_no=st.lot_no,
                                             location_id=st.location_id, qty=q))
    if not sh.lines:
        raise BizError("请录入发货明细")
    db.add(sh)
    db.flush()
    return sh


def confirm_shipment(db: Session, user: User, sh: Shipment) -> Shipment:
    if sh.status != "DRAFT":
        raise BizError("发货单已过账或已取消")
    so = sh.sales_order
    ref = inv.Ref("SHIPMENT", sh.id, sh.no, user.username, f"销售订单 {so.no if so else ''} 发货")
    ar_amount = 0.0
    for ln in sh.lines:
        sol = db.get(SalesOrderLine, ln.so_line_id) if ln.so_line_id else None
        if sol and ln.qty > round(sol.qty - (sol.shipped_qty or 0), 4) + 1e-9:
            raise BizError(f"{ln.material_code} 发货数量超出订单未发数量")
        inv.remove_stock(db, material_id=ln.material_id, location_id=ln.location_id, lot_no=ln.lot_no,
                         status="AVAILABLE", qty=ln.qty, move_type="SHIPMENT", ref=ref)
        for s in ln.serial_list:
            sn = db.scalar(select(SerialNumber).where(SerialNumber.sn == s))
            if sn.status != "IN_STOCK":
                raise BizError(f"序列号 {s} 状态已变更，不可发货")
            sn.status, sn.shipment_id, sn.customer_id, sn.shipped_at = "SHIPPED", sh.id, sh.customer_id, now()
            sn.location_id = None
        if sol:
            sol.shipped_qty = round((sol.shipped_qty or 0) + ln.qty, 4)
            ar_amount += ln.qty * (sol.unit_price or 0)
    sh.status, sh.ship_date, sh.shipped_by = "SHIPPED", today(), user.full_name
    if so:
        so.status = "SHIPPED" if all((l.shipped_qty or 0) + 1e-9 >= l.qty for l in so.lines) else "PARTIAL_SHIPPED"
        if ar_amount > 0:
            cust = so.customer
            db.add(FinanceDoc(no=next_no(db, "AR"), doc_type="AR", customer_id=so.customer_id, ref_type="SHIPMENT",
                              ref_no=sh.no, doc_date=today(), currency=so.currency,
                              due_date=today() + timedelta(days=cust.payment_terms_days if cust else 30),
                              amount=round(ar_amount, 2), status="OPEN", remark=f"销售订单 {so.no} 发货",
                              created_by=user.username))
    db.flush()
    return sh


# ---------------- 调拨 / 盘点 ----------------

def transfer(db: Session, user: User, stock_id: int, qty: float, to_location_id: int, remark: str | None = None):
    st = db.get(Stock, stock_id)
    if not st:
        raise NotFound("库存")
    if st.location_id == to_location_id:
        raise BizError("目标库位与原库位相同")
    to_loc = db.get(Location, to_location_id)
    if not to_loc:
        raise NotFound("目标库位")
    no = next_no(db, "DB")
    return inv.move_stock(db, material_id=st.material_id, lot_no=st.lot_no, qty=qty, from_location_id=st.location_id,
                          to_location_id=to_location_id, from_status=st.status, to_status=st.status,
                          move_type="TRANSFER", owner_customer_id=st.owner_customer_id,
                          ref=inv.Ref("TRANSFER", None, no, user.username, remark))


def create_count(db: Session, user: User, warehouse_id: int, remark: str | None = None) -> StockCount:
    sc = StockCount(no=next_no(db, "PD"), warehouse_id=warehouse_id, status="OPEN", remark=remark, created_by=user.username)
    q = select(Stock).join(Location).where(Location.warehouse_id == warehouse_id, Stock.qty > 0)
    for st in db.scalars(q):
        sc.lines.append(StockCountLine(material_id=st.material_id, location_id=st.location_id, lot_no=st.lot_no,
                                       status=st.status, owner_customer_id=st.owner_customer_id, system_qty=st.qty))
    db.add(sc)
    db.flush()
    return sc


def post_count(db: Session, user: User, sc: StockCount) -> StockCount:
    if sc.status != "OPEN":
        raise BizError("盘点单已过账")
    ref = inv.Ref("STOCK_COUNT", sc.id, sc.no, user.username, "盘点差异调整")
    for ln in sc.lines:
        if ln.counted_qty is None:
            raise BizError(f"{ln.material_code} 批次 {ln.lot_no or '-'} 未录入实盘数量")
    for ln in sc.lines:
        diff = round(ln.counted_qty - ln.system_qty, 4)
        if diff > 0:
            inv.add_stock(db, material_id=ln.material_id, location_id=ln.location_id, lot_no=ln.lot_no,
                          status=ln.status, qty=diff, owner_customer_id=ln.owner_customer_id, move_type="ADJUST", ref=ref)
        elif diff < 0:
            inv.remove_stock(db, material_id=ln.material_id, location_id=ln.location_id, lot_no=ln.lot_no,
                             status=ln.status, qty=-diff, owner_customer_id=ln.owner_customer_id, move_type="ADJUST",
                             ref=ref)
    sc.status, sc.posted_by, sc.posted_at = "POSTED", user.full_name, now()
    db.flush()
    return sc
