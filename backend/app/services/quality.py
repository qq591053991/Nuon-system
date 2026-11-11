"""质量：来料检验（AQL 抽样 + 电子签名判定 → 库存状态自动转换）、NCR 评审处置。"""
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import now
from ..errors import BizError
from ..models import Inspection, InspectionItem, Material, Ncr, ReceiptLine, SerialNumber, User, WorkOrder
from ..security import esign, user_permissions
from . import inventory as inv
from .aql import sampling_plan
from .numbering import next_no

DEFAULT_IQC_ITEMS = {
    "LED": [("外观", "无破损、无氧化、编带完好"), ("规格标识核对", "型号/波长/BIN 与规格书一致"),
            ("峰值波长抽测", "符合规格书 ±5nm"), ("湿敏包装", "真空包装完好，湿度卡未变色")],
    "PSU": [("外观", "无破损、标签清晰"), ("输出电压", "额定值 ±5%"), ("安规认证核对", "IEC 60601-1 证书有效")],
    "PCB": [("外观", "无划伤、无起泡、阻焊完好"), ("尺寸", "符合图纸"), ("可焊性", "上锡良好")],
    "PACKAGING": [("外观/印刷", "颜色、文字与客户批准样一致"), ("尺寸", "符合图纸")],
    "DEFAULT": [("外观", "无破损、无污渍"), ("规格核对", "与采购规格一致"), ("尺寸", "符合图纸")],
}


def _items_for(m: Material) -> list[tuple[str, str]]:
    code = (m.code or "").upper()
    if code.startswith("LED") or (m.wavelength_nm and m.category == "RAW"):
        return DEFAULT_IQC_ITEMS["LED"]
    if code.startswith("PSU"):
        return DEFAULT_IQC_ITEMS["PSU"]
    if code.startswith("PCB"):
        return DEFAULT_IQC_ITEMS["PCB"]
    if m.category == "PACKAGING":
        return DEFAULT_IQC_ITEMS["PACKAGING"]
    return DEFAULT_IQC_ITEMS["DEFAULT"]


def create_iqc(db: Session, *, receipt, line: ReceiptLine, material: Material, username: str) -> Inspection:
    plan = sampling_plan(line.qty, material.aql or 1.0)
    insp = Inspection(
        no=next_no(db, "IQC"), insp_type="IQC", material_id=material.id, lot_no=line.lot_no,
        location_id=line.location_id, owner_customer_id=material.owner_customer_id, receipt_id=receipt.id,
        receipt_line_id=line.id, supplier_id=receipt.supplier_id, lot_qty=line.qty, aql=plan["aql"],
        code_letter=plan["code_letter"], sample_size=plan["sample_size"], accept_num=plan["accept_num"],
        reject_num=plan["reject_num"], status="PENDING", created_by=username,
    )
    for name, std in _items_for(material):
        insp.items.append(InspectionItem(name=name, standard=std, result="PASS"))
    db.add(insp)
    db.flush()
    line.inspection_id = insp.id
    return insp


def submit_inspection(db: Session, user: User, insp: Inspection, *, items: list[dict] | None, defect_qty: int,
                      concession: bool, remark: str | None, sig) -> Inspection:
    if insp.status != "PENDING":
        raise BizError("该检验单已判定")
    if defect_qty < 0:
        raise BizError("不良数不能为负")
    if items:
        by_id = {i.id: i for i in insp.items}
        for it in items:
            if it.get("id") in by_id:
                obj = by_id[it["id"]]
                obj.value = it.get("value")
                obj.result = it.get("result", obj.result)
            else:
                insp.items.append(InspectionItem(name=it["name"], standard=it.get("standard"), value=it.get("value"),
                                                 result=it.get("result", "PASS")))
    item_fail = any(i.result == "FAIL" for i in insp.items)
    accept = defect_qty <= (insp.accept_num or 0) and not item_fail
    if concession and accept:
        concession = False
    if concession and "qa" not in user_permissions(user):
        raise BizError("让步接收需由 QA 批准")
    status = "PASSED" if accept else ("CONCESSION" if concession else "REJECTED")
    meaning = {"PASSED": "IQC检验判定：合格", "REJECTED": "IQC检验判定：不合格", "CONCESSION": "IQC让步接收批准"}[status]
    esign(db, user, sig, meaning, "qms_inspection", insp.id, insp.no)
    insp.defect_qty = defect_qty
    insp.status = status
    insp.inspector = user.full_name
    insp.inspected_at = now()
    insp.result_remark = remark
    ref = inv.Ref("INSPECTION", insp.id, insp.no, user.username, meaning)
    kw = dict(material_id=insp.material_id, lot_no=insp.lot_no, from_status="QUARANTINE",
              owner_customer_id=insp.owner_customer_id, location_id=insp.location_id, ref=ref)
    if status in ("PASSED", "CONCESSION"):
        inv.change_lot_status(db, to_status="AVAILABLE", move_type="IQC_RELEASE", **kw)
    else:
        inv.change_lot_status(db, to_status="REJECTED", move_type="IQC_REJECT", **kw)
    if status != "PASSED":
        fails = "、".join(i.name for i in insp.items if i.result == "FAIL")
        ncr = Ncr(no=next_no(db, "NCR"), source="IQC", severity="MAJOR", material_id=insp.material_id,
                  lot_no=insp.lot_no, inspection_id=insp.id, supplier_id=insp.supplier_id, qty=insp.lot_qty,
                  description=f"来料检验 {insp.no}：抽样 {insp.sample_size}，不良 {defect_qty}（Ac={insp.accept_num}）"
                              + (f"；不合格项目：{fails}" if fails else "") + (f"；{remark}" if remark else ""),
                  status="OPEN", created_by=user.username)
        if status == "CONCESSION":
            ncr.status, ncr.disposition = "DISPOSITIONED", "USE_AS_IS"
            ncr.disposition_by, ncr.disposition_at = user.full_name, now()
            ncr.disposition_remark = remark or "让步接收"
        db.add(ncr)
    db.flush()
    return insp


DISPOSITION_TEXT = {"REWORK": "返工/返修", "SCRAP": "报废", "USE_AS_IS": "让步接收", "RETURN": "退货"}


def disposition_ncr(db: Session, user: User, ncr: Ncr, disposition: str, remark: str | None, sig) -> Ncr:
    if ncr.status != "OPEN":
        raise BizError("该 NCR 已处置")
    if disposition not in DISPOSITION_TEXT:
        raise BizError("处置方式无效")
    ref = inv.Ref("NCR", ncr.id, ncr.no, user.username, f"NCR处置：{DISPOSITION_TEXT[disposition]}")
    if ncr.source == "PROCESS":
        if disposition not in ("REWORK", "SCRAP"):
            raise BizError("生产过程不合格品只能“返工”或“报废”，不允许让步放行（医疗器械安全要求）")
        wo: WorkOrder = db.get(WorkOrder, ncr.wo_id)
        if ncr.sn:
            sn = db.scalar(select(SerialNumber).where(SerialNumber.sn == ncr.sn))
            if disposition == "REWORK":
                sn.status = "IN_PROCESS"  # ng_seq 保留，重新过该工序时标记为返工
            else:
                sn.status = "SCRAPPED"
                wo.scrap_qty = (wo.scrap_qty or 0) + 1
        else:
            # 批量报工：返工 → 释放该工序的不良数量，可重新报工；报废 → 保持占用并计入工单报废数
            op = next((o for o in wo.operations if o.seq == ncr.op_seq), None)
            if disposition == "REWORK" and op is not None:
                op.ng_qty = round((op.ng_qty or 0) - ncr.qty, 4)
            if disposition == "SCRAP":
                wo.scrap_qty = round((wo.scrap_qty or 0) + ncr.qty, 4)
        if disposition == "SCRAP" and wo.status in ("RELEASED", "IN_PROGRESS") and \
                (wo.completed_qty or 0) + (wo.scrap_qty or 0) >= wo.planned_qty - 1e-9:
            wo.status, wo.actual_end = "COMPLETED", now()
    elif ncr.source == "IQC":
        insp = db.get(Inspection, ncr.inspection_id) if ncr.inspection_id else None
        kw = dict(material_id=ncr.material_id, lot_no=ncr.lot_no or "", from_status="REJECTED",
                  owner_customer_id=insp.owner_customer_id if insp else None,
                  location_id=insp.location_id if insp else None, ref=ref)
        if disposition == "USE_AS_IS":
            inv.change_lot_status(db, to_status="AVAILABLE", move_type="STATUS_CHANGE", **kw)
        elif disposition == "REWORK":  # 挑选/返工后重新检验
            inv.change_lot_status(db, to_status="QUARANTINE", move_type="STATUS_CHANGE", **kw)
            if insp:
                from ..models import Receipt
                rc = db.get(Receipt, insp.receipt_id) if insp.receipt_id else None
                line = db.get(ReceiptLine, insp.receipt_line_id) if insp.receipt_line_id else None
                if rc and line:
                    create_iqc(db, receipt=rc, line=line, material=insp.material, username=user.username)
        else:  # RETURN / SCRAP：从不合格库存中出库
            from ..models import Stock
            q = select(Stock).where(Stock.material_id == ncr.material_id, Stock.lot_no == (ncr.lot_no or ""),
                                    Stock.status == "REJECTED")
            for st in list(db.scalars(q)):
                inv.remove_stock(db, material_id=st.material_id, location_id=st.location_id, lot_no=st.lot_no,
                                 status="REJECTED", qty=st.qty, owner_customer_id=st.owner_customer_id,
                                 move_type="RETURN_SUPPLIER" if disposition == "RETURN" else "SCRAP", ref=ref)
    esign(db, user, sig, f"不合格品评审处置：{DISPOSITION_TEXT[disposition]}", "qms_ncr", ncr.id, ncr.no)
    ncr.status = "DISPOSITIONED"
    ncr.disposition = disposition
    ncr.disposition_remark = remark
    ncr.disposition_by = user.full_name
    ncr.disposition_at = now()
    db.flush()
    return ncr
