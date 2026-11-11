"""追溯：
  反向追溯（序列号 → 工单/批号 → 所用物料批次/供应商/IQC → 每道工序的操作人、设备、测试数据 → 发货）；
  正向追溯（物料批次 → 来料 → 领用到哪些工单 → 产出哪些序列号 → 发给了哪些客户），用于召回范围评估。"""
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..errors import BizError
from ..models import (
    Inspection, KeyPartBinding, Material, MaterialIssue, MaterialIssueLine, Ncr, OperationRecord, PurchaseOrder,
    Receipt, ReceiptLine, SalesOrder, SerialNumber, Shipment, Stock, WorkOrder,
)


def _wo_materials(db: Session, wo_id: int) -> list[dict]:
    rows: dict[tuple, dict] = {}
    q = select(MaterialIssueLine).join(MaterialIssue).where(MaterialIssue.wo_id == wo_id, MaterialIssue.status == "CONFIRMED")
    for ln in db.scalars(q):
        k = (ln.material_id, ln.lot_no)
        r = rows.setdefault(k, {"material_id": ln.material_id, "material_code": ln.material_code,
                                "material_name": ln.material_name, "lot_no": ln.lot_no, "qty": 0.0,
                                "customer_supplied": bool(ln.owner_customer_id)})
        r["qty"] = round(r["qty"] + ln.qty, 4)
    for r in rows.values():
        rl = db.scalars(select(ReceiptLine).where(ReceiptLine.material_id == r["material_id"],
                                                  ReceiptLine.lot_no == r["lot_no"])).first()
        if rl:
            rc = db.get(Receipt, rl.receipt_id)
            r.update(receipt_no=rc.no, receipt_date=rc.receipt_date, supplier_name=rc.partner_name,
                     supplier_lot=rl.supplier_lot)
        insp = db.scalars(select(Inspection).where(Inspection.material_id == r["material_id"],
                                                   Inspection.lot_no == r["lot_no"]).order_by(Inspection.id.desc())).first()
        if insp:
            r.update(iqc_no=insp.no, iqc_status=insp.status)
    return list(rows.values())


def trace_serial(db: Session, sn_text: str) -> dict:
    sn = db.scalar(select(SerialNumber).where(SerialNumber.sn == sn_text.strip()))
    if not sn:
        raise BizError(f"序列号 {sn_text} 不存在")
    wo = sn.work_order
    recs = db.scalars(select(OperationRecord).where(OperationRecord.sn_id == sn.id).order_by(OperationRecord.id))
    kps = db.scalars(select(KeyPartBinding).where(KeyPartBinding.sn_id == sn.id))
    sh = db.get(Shipment, sn.shipment_id) if sn.shipment_id else None
    ncrs = db.scalars(select(Ncr).where(Ncr.sn == sn.sn))
    return {
        "serial": {"sn": sn.sn, "udi": sn.udi, "status": sn.status, "lot_no": sn.lot_no, "completed_at": sn.completed_at,
                   "shipped_at": sn.shipped_at},
        "product": {"code": wo.material.code, "name": wo.material.name, "model": wo.material.model,
                    "registration_no": wo.material.registration_no},
        "work_order": {"id": wo.id, "no": wo.no, "lot_no": wo.lot_no, "customer_name": wo.customer_name,
                       "so_no": wo.so_no, "dhr_status": wo.dhr_status, "bom_version": wo.bom_version,
                       "routing_version": wo.routing_version},
        "materials": _wo_materials(db, wo.id),
        "key_parts": [{"material_code": k.material_code, "material_name": k.material_name, "lot_no": k.lot_no,
                       "part_sn": k.part_sn, "ts": k.ts} for k in kps],
        "records": [{"ts": r.ts, "seq": r.seq, "op_name": r.op_name, "result": r.result, "operator_name": r.operator_name,
                     "equipment_code": r.equipment_code, "is_rework": r.is_rework,
                     "values": [{"name": v.name, "value": v.value, "unit": v.unit, "lower": v.lower, "upper": v.upper,
                                 "result": v.result} for v in r.values]} for r in recs],
        "ncrs": [{"no": n.no, "description": n.description, "status": n.status, "disposition": n.disposition} for n in ncrs],
        "shipment": {"no": sh.no, "ship_date": sh.ship_date, "customer_name": sh.customer_name, "so_no": sh.so_no,
                     "carrier": sh.carrier, "tracking_no": sh.tracking_no} if sh else None,
    }


def trace_lot(db: Session, material_code: str, lot_no: str) -> dict:
    m = db.scalar(select(Material).where(Material.code == material_code.strip()))
    if not m:
        raise BizError(f"物料 {material_code} 不存在")
    lot_no = lot_no.strip()
    receipts = []
    for rl in db.scalars(select(ReceiptLine).where(ReceiptLine.material_id == m.id, ReceiptLine.lot_no == lot_no)):
        rc = db.get(Receipt, rl.receipt_id)
        insp = db.get(Inspection, rl.inspection_id) if rl.inspection_id else None
        receipts.append({"receipt_no": rc.no, "receipt_type": rc.receipt_type, "receipt_date": rc.receipt_date,
                         "partner_name": rc.partner_name, "qty": rl.qty, "supplier_lot": rl.supplier_lot,
                         "iqc_no": insp.no if insp else None, "iqc_status": insp.status if insp else None})
    stock = [{"location_code": s.location_code, "status": s.status, "qty": s.qty}
             for s in db.scalars(select(Stock).where(Stock.material_id == m.id, Stock.lot_no == lot_no))]
    # 领用到哪些工单（含关键件绑定）
    wo_ids: dict[int, float] = {}
    q = select(MaterialIssueLine, MaterialIssue).join(MaterialIssue).where(
        MaterialIssueLine.material_id == m.id, MaterialIssueLine.lot_no == lot_no, MaterialIssue.status == "CONFIRMED")
    for ln, iss in db.execute(q):
        wo_ids[iss.wo_id] = round(wo_ids.get(iss.wo_id, 0) + ln.qty, 4)
    # 该批号本身就是成品生产批
    for wo in db.scalars(select(WorkOrder).where(WorkOrder.material_id == m.id, WorkOrder.lot_no == lot_no)):
        wo_ids.setdefault(wo.id, 0)
    work_orders, affected_serials, customers = [], [], {}
    for wid, qty in wo_ids.items():
        wo = db.get(WorkOrder, wid)
        sns = list(db.scalars(select(SerialNumber).where(SerialNumber.wo_id == wid).order_by(SerialNumber.sn)))
        kp_sns = {k.sn_id for k in db.scalars(select(KeyPartBinding).where(KeyPartBinding.material_id == m.id,
                                                                         KeyPartBinding.lot_no == lot_no))}
        shipped = [s for s in sns if s.status == "SHIPPED"]
        work_orders.append({"id": wo.id, "no": wo.no, "lot_no": wo.lot_no, "product_code": wo.material.code,
                            "product_name": wo.material.name, "issued_qty": qty, "status": wo.status,
                            "serial_count": len(sns), "shipped_count": len(shipped)})
        for s in sns:
            sh = db.get(Shipment, s.shipment_id) if s.shipment_id else None
            if sh:
                customers.setdefault(sh.customer_name, 0)
                customers[sh.customer_name] += 1
            affected_serials.append({"sn": s.sn, "wo_no": wo.no, "status": s.status, "key_part_bound": s.id in kp_sns,
                                     "shipment_no": sh.no if sh else None, "customer_name": sh.customer_name if sh else None,
                                     "ship_date": sh.ship_date if sh else None})
    return {
        "material": {"code": m.code, "name": m.name, "spec": m.spec}, "lot_no": lot_no, "receipts": receipts,
        "stock": stock, "work_orders": work_orders, "serials": affected_serials,
        "customers": [{"customer_name": k, "qty": v} for k, v in customers.items()],
        "summary": {"work_orders": len(work_orders), "serials": len(affected_serials),
                    "shipped": sum(1 for s in affected_serials if s["shipment_no"]), "customers": len(customers)},
    }


def global_search(db: Session, q: str, limit: int = 8) -> list[dict]:
    """全局搜索：单号、序列号、批号、物料编码/名称一框搞定。"""
    q = (q or "").strip()
    if not q:
        return []
    like = f"%{q}%"
    out: list[dict] = []
    for m in db.scalars(select(Material).where(or_(Material.code.ilike(like), Material.name.ilike(like))).limit(limit)):
        out.append({"type": "material", "type_text": "物料", "id": m.id, "title": f"{m.code} {m.name}", "sub": m.spec})
    for s in db.scalars(select(SerialNumber).where(SerialNumber.sn.ilike(like)).limit(limit)):
        out.append({"type": "serial", "type_text": "序列号", "id": s.id, "title": s.sn, "sub": f"{s.material_name} · {s.status}"})
    for w in db.scalars(select(WorkOrder).where(or_(WorkOrder.no.ilike(like), WorkOrder.lot_no.ilike(like))).limit(limit)):
        out.append({"type": "work_order", "type_text": "生产工单", "id": w.id, "title": w.no, "sub": f"{w.material_name} 批号 {w.lot_no or '-'}"})
    for o in db.scalars(select(SalesOrder).where(or_(SalesOrder.no.ilike(like), SalesOrder.customer_po.ilike(like))).limit(limit)):
        out.append({"type": "sales_order", "type_text": "销售订单", "id": o.id, "title": o.no, "sub": o.customer_name})
    for o in db.scalars(select(PurchaseOrder).where(PurchaseOrder.no.ilike(like)).limit(limit)):
        out.append({"type": "purchase_order", "type_text": "采购订单", "id": o.id, "title": o.no, "sub": o.supplier_name})
    for n in db.scalars(select(Ncr).where(Ncr.no.ilike(like)).limit(limit)):
        out.append({"type": "ncr", "type_text": "不合格品", "id": n.id, "title": n.no, "sub": (n.description or "")[:40]})
    for i in db.scalars(select(Inspection).where(Inspection.no.ilike(like)).limit(limit)):
        out.append({"type": "inspection", "type_text": "检验单", "id": i.id, "title": i.no, "sub": i.material_name})
    for sh in db.scalars(select(Shipment).where(Shipment.no.ilike(like)).limit(limit)):
        out.append({"type": "shipment", "type_text": "发货单", "id": sh.id, "title": sh.no, "sub": sh.customer_name})
    lots = db.execute(select(Stock.lot_no, Material.code, Material.name).join(Material)
                      .where(Stock.lot_no.ilike(like)).distinct().limit(limit))
    for lot, code, name in lots:
        out.append({"type": "lot", "type_text": "批次", "id": None, "title": lot, "sub": f"{code} {name}",
                    "material_code": code})
    return out
