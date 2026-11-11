"""生产执行核心：工单下达（BOM/工艺快照、批号、序列号+UDI）、工位报工（防跳站、设备校准校验、
测试数据自动判定、不合格自动开 NCR）、完工入库、DHR 汇编与产品放行。"""
import json
import math
from datetime import timedelta

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..config import now, today
from ..errors import BizError, NotFound
from ..models import (
    Bom, Equipment, ESignature, Inspection, KeyPartBinding, Material, MaterialIssue, MaterialIssueLine, Ncr,
    OperationRecord, Receipt, ReceiptLine, Routing, SerialNumber, TestValue, User, WorkOrder,
    WorkOrderMaterial, WorkOrderOperation,
)
from . import inventory as inv
from .numbering import next_no, next_seq
from .udi import build_udi

DISCRETE_UOM = {"PCS", "PC", "EA", "SET", "个", "台", "只", "套", "片", "件", "张", "根", "块", "颗", "盒", "本"}
OP_TYPE_TEXT = {
    "SMT": "SMT贴片", "ASSEMBLY": "组装", "TEST_OPTICAL": "光学性能测试", "AGING": "老化",
    "TEST_SAFETY": "安规测试", "INSPECTION": "检验", "PACKING": "包装", "OTHER": "其他",
}


def released_bom(db: Session, material_id: int) -> Bom | None:
    return db.scalars(select(Bom).where(Bom.material_id == material_id, Bom.status == "RELEASED")
                      .order_by(Bom.id.desc())).first()


def released_routing(db: Session, material_id: int) -> Routing | None:
    return db.scalars(select(Routing).where(Routing.material_id == material_id, Routing.status == "RELEASED")
                      .order_by(Routing.id.desc())).first()


def _round_req(qty: float, uom: str) -> float:
    if (uom or "").upper() in DISCRETE_UOM or uom in DISCRETE_UOM:
        return float(math.ceil(qty - 1e-9))
    return round(qty, 4)


def release_work_order(db: Session, wo: WorkOrder, user: User) -> WorkOrder:
    if wo.status != "PLANNED":
        raise BizError("只有“计划”状态的工单才能下达")
    product: Material = wo.material
    bom = db.get(Bom, wo.bom_id) if wo.bom_id else released_bom(db, product.id)
    if not bom or bom.status != "RELEASED":
        raise BizError(f"产品 {product.code} 没有已发布的 BOM，不能下达（GMP：只能使用受控版本）")
    routing = db.get(Routing, wo.routing_id) if wo.routing_id else released_routing(db, product.id)
    if not routing or routing.status != "RELEASED":
        raise BizError(f"产品 {product.code} 没有已发布的工艺路线，不能下达")
    if not routing.operations:
        raise BizError("工艺路线没有工序")
    if product.serial_control and abs(wo.planned_qty - round(wo.planned_qty)) > 1e-9:
        raise BizError("序列号管理的产品，工单数量必须为整数")
    if product.customer_id and wo.customer_id and product.customer_id != wo.customer_id:
        raise BizError("工单客户与产品所属客户不一致")
    wo.bom_id, wo.routing_id = bom.id, routing.id
    wo.customer_id = wo.customer_id or product.customer_id

    # 1) 用料需求快照
    wo.materials.clear()
    for ln in bom.lines:
        req = wo.planned_qty * ln.qty_per * (1 + (ln.scrap_rate or 0))
        wo.materials.append(WorkOrderMaterial(material_id=ln.component_id, qty_per=ln.qty_per,
                                              required_qty=_round_req(req, ln.component.uom), issued_qty=0))
    # 2) 工序快照（含测试规格）
    wo.operations.clear()
    for op in routing.operations:
        params = [dict(code=p.code, name=p.name, unit=p.unit, lower=p.lower, upper=p.upper, target=p.target)
                  for p in op.params]
        wo.operations.append(WorkOrderOperation(
            seq=op.seq, code=op.code, name=op.name, op_type=op.op_type, work_center_id=op.work_center_id,
            requires_equipment=op.requires_equipment, key_part_material_id=op.key_part_material_id,
            sop_no=op.sop_no, instructions=op.instructions, params_json=json.dumps(params, ensure_ascii=False),
        ))
    # 3) 生产批号
    wo.lot_no = wo.lot_no or next_no(db, "B")
    # 4) 序列号 + UDI
    if product.serial_control:
        mfg = today()
        exp = mfg + timedelta(days=product.shelf_life_days) if product.shelf_life_days else None
        prefix = (product.sn_prefix or product.code.replace("-", "")[:6]).upper()
        key = f"SN-{prefix}{mfg.strftime('%y%m%d')}"
        for _ in range(int(round(wo.planned_qty))):
            sn = f"{prefix}{mfg.strftime('%y%m%d')}{next_seq(db, key):04d}"
            db.add(SerialNumber(sn=sn, wo_id=wo.id, material_id=product.id, lot_no=wo.lot_no, status="CREATED",
                                udi=build_udi(product.gtin, mfg_date=mfg, expiry_date=exp, lot=wo.lot_no, serial=sn),
                                created_by=user.username))
    wo.status = "RELEASED"
    wo.released_by = user.username
    db.flush()
    return wo


def _wo_ops(wo: WorkOrder) -> list[WorkOrderOperation]:
    return sorted(wo.operations, key=lambda o: o.seq)


def next_operation(wo: WorkOrder, sn: SerialNumber) -> WorkOrderOperation | None:
    for op in _wo_ops(wo):
        if op.seq > (sn.last_seq or 0):
            return op
    return None


def _check_equipment(db: Session, op: WorkOrderOperation, equipment_id: int | None) -> Equipment | None:
    if not equipment_id:
        if op.requires_equipment:
            raise BizError(f"工序【{op.name}】必须选择/扫描所用设备仪器")
        return None
    eq = db.get(Equipment, equipment_id)
    if not eq:
        raise NotFound("设备")
    if eq.status != "NORMAL":
        raise BizError(f"设备 {eq.code} 当前状态为【{eq.status}】，不可用于生产")
    if eq.calibration_required and (not eq.next_calibration_date or eq.next_calibration_date < today()):
        raise BizError(f"设备 {eq.code} {eq.name} 校准已过期（有效期至 {eq.next_calibration_date}），禁止使用，请联系计量管理员")
    return eq


def _judge(params: list[dict], values: dict[str, float | None]) -> list[dict]:
    out = []
    for p in params:
        v = values.get(p["code"])
        if v is None:
            raise BizError(f"请录入测试项【{p['name']}】的测量值")
        ok = (p.get("lower") is None or v >= p["lower"] - 1e-9) and (p.get("upper") is None or v <= p["upper"] + 1e-9)
        out.append({**p, "value": v, "result": "PASS" if ok else "FAIL"})
    return out


def _spec_text(p: dict) -> str:
    lo, up = p.get("lower"), p.get("upper")
    unit = p.get("unit") or ""
    if lo is not None and up is not None:
        return f"{lo:g}~{up:g}{unit}"
    if lo is not None:
        return f"≥{lo:g}{unit}"
    if up is not None:
        return f"≤{up:g}{unit}"
    return "-"


def _start_wo(wo: WorkOrder):
    if wo.status == "RELEASED":
        wo.status = "IN_PROGRESS"
        wo.actual_start = now()


def _maybe_complete_wo(wo: WorkOrder):
    if (wo.completed_qty or 0) + (wo.scrap_qty or 0) >= wo.planned_qty - 1e-9 and wo.status in ("RELEASED", "IN_PROGRESS"):
        wo.status = "COMPLETED"
        wo.actual_end = now()


def get_sn(db: Session, sn_text: str) -> SerialNumber:
    sn = db.scalar(select(SerialNumber).where(SerialNumber.sn == (sn_text or "").strip()))
    if not sn:
        raise BizError(f"序列号 {sn_text} 不存在")
    return sn


def _issued_lots(db: Session, wo_id: int, material_id: int) -> set[str]:
    rows = db.scalars(select(MaterialIssueLine.lot_no).join(MaterialIssue)
                      .where(MaterialIssue.wo_id == wo_id, MaterialIssue.status == "CONFIRMED",
                             MaterialIssueLine.material_id == material_id))
    return set(rows)


def report_serial(db: Session, user: User, *, sn_text: str, seq: int | None = None, result: str | None = None,
                  values: dict[str, float | None] | None = None, equipment_id: int | None = None,
                  remark: str | None = None, key_parts: list[dict] | None = None) -> dict:
    sn = get_sn(db, sn_text)
    wo: WorkOrder = sn.work_order
    if wo.status not in ("RELEASED", "IN_PROGRESS"):
        raise BizError(f"工单 {wo.no} 状态为【{wo.status}】，不能报工")
    if sn.status == "NG":
        raise BizError(f"{sn.sn} 存在未处置的不合格（NCR），请先由 QA 评审处置（返工/报废）")
    if sn.status in ("COMPLETED", "IN_STOCK", "SHIPPED"):
        raise BizError(f"{sn.sn} 已完成全部工序")
    if sn.status == "SCRAPPED":
        raise BizError(f"{sn.sn} 已报废")
    op = next_operation(wo, sn)
    if op is None:
        raise BizError("没有待执行的工序")
    if seq is not None and seq != op.seq:
        cur = next((o for o in wo.operations if o.seq == seq), None)
        raise BizError(f"防呆拦截：{sn.sn} 的下一道工序是【{op.seq} {op.name}】，当前工位【{cur.name if cur else seq}】不能报工（禁止跳站/重复过站）")
    eq = _check_equipment(db, op, equipment_id)
    judged = _judge(op.params, values or {}) if op.params else []
    final = "FAIL" if (result == "FAIL" or any(j["result"] == "FAIL" for j in judged)) else "PASS"

    # 关键件绑定校验
    bindings = []
    if op.key_part_material_id:
        kp = next((k for k in (key_parts or []) if k.get("lot_no") or k.get("part_sn")), None)
        if not kp:
            km = db.get(Material, op.key_part_material_id)
            raise BizError(f"工序【{op.name}】需扫描关键件【{km.code} {km.name}】的批号或序列号")
        lots = _issued_lots(db, wo.id, op.key_part_material_id)
        if kp.get("lot_no") and lots and kp["lot_no"] not in lots:
            raise BizError(f"关键件批号 {kp['lot_no']} 未领用到工单 {wo.no}（已领批次：{', '.join(sorted(lots))}）")
        bindings.append(dict(material_id=op.key_part_material_id, lot_no=kp.get("lot_no"), part_sn=kp.get("part_sn")))

    is_rework = sn.ng_seq == op.seq
    rec = OperationRecord(ts=now(), wo_id=wo.id, sn_id=sn.id, seq=op.seq, op_code=op.code, op_name=op.name,
                          result=final, qty=1, operator=user.username, operator_name=user.full_name,
                          equipment_id=eq.id if eq else None, is_rework=is_rework, remark=remark)
    for j in judged:
        rec.values.append(TestValue(code=j["code"], name=j["name"], unit=j.get("unit"), value=j["value"],
                                    lower=j.get("lower"), upper=j.get("upper"), result=j["result"]))
    db.add(rec)
    db.flush()
    for b in bindings:
        db.add(KeyPartBinding(ts=now(), sn_id=sn.id, record_id=rec.id, operator=user.username, **b))
    _start_wo(wo)
    ncr = None
    if final == "PASS":
        op.good_qty = (op.good_qty or 0) + 1
        sn.last_seq = op.seq
        sn.ng_seq = None
        sn.status = "IN_PROCESS"
        if next_operation(wo, sn) is None:
            sn.status = "COMPLETED"
            sn.completed_at = now()
            wo.completed_qty = (wo.completed_qty or 0) + 1
            _maybe_complete_wo(wo)
    else:
        op.ng_qty = (op.ng_qty or 0) + 1
        sn.status = "NG"
        sn.ng_seq = op.seq
        fails = [f"{j['name']}={j['value']:g}{j.get('unit') or ''}(规格 {_spec_text(j)})" for j in judged if j["result"] == "FAIL"]
        desc = f"工序【{op.seq} {op.name}】判定不合格。" + ("；".join(fails) if fails else "") + (f" 备注：{remark}" if remark else "")
        ncr = Ncr(no=next_no(db, "NCR"), source="PROCESS", severity="MAJOR", material_id=wo.material_id,
                  lot_no=wo.lot_no, sn=sn.sn, wo_id=wo.id, op_seq=op.seq, op_name=op.name, customer_id=wo.customer_id,
                  qty=1, description=desc, status="OPEN", created_by=user.username)
        db.add(ncr)
    db.flush()
    nxt = next_operation(wo, sn) if sn.status == "IN_PROCESS" else None
    return {"record_id": rec.id, "result": final, "sn": sn.sn, "sn_status": sn.status, "values": judged,
            "ncr_no": ncr.no if ncr else None, "next_operation": op_dict(nxt) if nxt else None,
            "wo_no": wo.no, "wo_completed_qty": wo.completed_qty, "wo_status": wo.status}


def report_batch(db: Session, user: User, *, wo: WorkOrder, seq: int, good_qty: float, ng_qty: float = 0,
                 values: dict[str, float | None] | None = None, equipment_id: int | None = None,
                 remark: str | None = None) -> dict:
    """非序列号产品按批量报工；本工序合格+不合格数量不得超过上道工序合格数量（防超报）。"""
    if wo.material.serial_control:
        raise BizError("序列号管理的产品请逐台扫码报工")
    if wo.status not in ("RELEASED", "IN_PROGRESS"):
        raise BizError(f"工单 {wo.no} 状态为【{wo.status}】，不能报工")
    if good_qty < 0 or ng_qty < 0 or good_qty + ng_qty <= 0:
        raise BizError("报工数量必须大于 0")
    ops = _wo_ops(wo)
    op = next((o for o in ops if o.seq == seq), None)
    if not op:
        raise BizError("工序不存在")
    idx = ops.index(op)
    upstream = wo.planned_qty if idx == 0 else ops[idx - 1].good_qty
    avail = round(upstream - (op.good_qty or 0) - (op.ng_qty or 0), 4)
    if good_qty + ng_qty > avail + 1e-9:
        raise BizError(f"报工数量超出：工序【{op.name}】可报数量 {avail:g}")
    eq = _check_equipment(db, op, equipment_id)
    judged = _judge(op.params, values or {}) if (op.params and good_qty > 0) else []
    if any(j["result"] == "FAIL" for j in judged):
        raise BizError("抽测数据超出规格，不能按合格报工，请将不合格数量报为 NG")
    _start_wo(wo)
    out = {}
    for res, q in (("PASS", good_qty), ("FAIL", ng_qty)):
        if q <= 0:
            continue
        rec = OperationRecord(ts=now(), wo_id=wo.id, seq=op.seq, op_code=op.code, op_name=op.name, result=res,
                              qty=q, operator=user.username, operator_name=user.full_name,
                              equipment_id=eq.id if eq else None, remark=remark)
        if res == "PASS":
            for j in judged:
                rec.values.append(TestValue(code=j["code"], name=j["name"], unit=j.get("unit"), value=j["value"],
                                            lower=j.get("lower"), upper=j.get("upper"), result=j["result"]))
        db.add(rec)
    op.good_qty = round((op.good_qty or 0) + good_qty, 4)
    op.ng_qty = round((op.ng_qty or 0) + ng_qty, 4)
    if ng_qty > 0:
        ncr = Ncr(no=next_no(db, "NCR"), source="PROCESS", material_id=wo.material_id, lot_no=wo.lot_no,
                  wo_id=wo.id, op_seq=op.seq, op_name=op.name, customer_id=wo.customer_id, qty=ng_qty,
                  description=f"工序【{op.seq} {op.name}】不合格 {ng_qty:g} {wo.material.uom}。{remark or ''}",
                  status="OPEN", created_by=user.username)
        db.add(ncr)
        out["ncr_no"] = ncr.no
    if idx == len(ops) - 1 and good_qty > 0:
        wo.completed_qty = round((wo.completed_qty or 0) + good_qty, 4)
        _maybe_complete_wo(wo)
    db.flush()
    out.update({"wo_no": wo.no, "op": op_dict(op), "wo_completed_qty": wo.completed_qty, "wo_status": wo.status})
    return out


def op_dict(op: WorkOrderOperation | None) -> dict | None:
    if not op:
        return None
    return {"id": op.id, "seq": op.seq, "code": op.code, "name": op.name, "op_type": op.op_type,
            "op_type_text": OP_TYPE_TEXT.get(op.op_type, op.op_type), "requires_equipment": op.requires_equipment,
            "key_part_material_id": op.key_part_material_id, "work_center_id": op.work_center_id,
            "work_center_name": op.work_center_name, "sop_no": op.sop_no, "instructions": op.instructions,
            "params": op.params, "good_qty": op.good_qty, "ng_qty": op.ng_qty}


def scan_serial(db: Session, sn_text: str) -> dict:
    sn = get_sn(db, sn_text)
    wo = sn.work_order
    nxt = next_operation(wo, sn) if sn.status in ("CREATED", "IN_PROCESS") else None
    recs = db.scalars(select(OperationRecord).where(OperationRecord.sn_id == sn.id).order_by(OperationRecord.id))
    open_ncr = db.scalar(select(Ncr).where(Ncr.sn == sn.sn, Ncr.status == "OPEN"))
    kp_material = db.get(Material, nxt.key_part_material_id) if nxt and nxt.key_part_material_id else None
    return {
        "sn": sn.sn, "udi": sn.udi, "status": sn.status, "lot_no": sn.lot_no, "last_seq": sn.last_seq,
        "wo": {"id": wo.id, "no": wo.no, "status": wo.status, "planned_qty": wo.planned_qty,
               "completed_qty": wo.completed_qty, "customer_name": wo.customer_name},
        "product": {"id": wo.material.id, "code": wo.material.code, "name": wo.material.name,
                    "model": wo.material.model, "spec": wo.material.spec},
        "operations": [{"seq": o.seq, "name": o.name, "done": o.seq <= (sn.last_seq or 0)} for o in _wo_ops(wo)],
        "next_operation": op_dict(nxt),
        "key_part_material": {"id": kp_material.id, "code": kp_material.code, "name": kp_material.name} if kp_material else None,
        "open_ncr": open_ncr.no if open_ncr else None,
        "history": [
            {"ts": r.ts, "seq": r.seq, "op_name": r.op_name, "result": r.result, "operator_name": r.operator_name,
             "equipment_code": r.equipment_code, "is_rework": r.is_rework,
             "values": [{"name": v.name, "value": v.value, "unit": v.unit, "result": v.result} for v in r.values]}
            for r in recs
        ],
    }


def fg_receipt(db: Session, user: User, wo: WorkOrder, location_id: int, qty: float | None = None) -> Receipt:
    """完工入库：成品进入成品仓，质量状态为“待放行”（QUARANTINE），DHR 审核放行后才可发货。"""
    if wo.status not in ("IN_PROGRESS", "COMPLETED"):
        raise BizError("工单未开工或已关闭，不能完工入库")
    status = "AVAILABLE" if wo.dhr_status == "RELEASED" else "QUARANTINE"
    rc = Receipt(no=next_no(db, "RK"), receipt_type="PRODUCTION", wo_id=wo.id, customer_id=None,
                 receipt_date=today(), status="CONFIRMED", created_by=user.username)
    db.add(rc)
    db.flush()
    ref = inv.Ref("RECEIPT", rc.id, rc.no, user.username, f"工单 {wo.no} 完工入库")
    exp = today() + timedelta(days=wo.material.shelf_life_days) if wo.material.shelf_life_days else None
    if wo.material.serial_control:
        sns = list(db.scalars(select(SerialNumber).where(SerialNumber.wo_id == wo.id,
                                                         SerialNumber.status == "COMPLETED")))
        if qty:
            sns = sns[: int(qty)]
        if not sns:
            raise BizError("没有可入库的完工产品（需完成全部工序）")
        n = len(sns)
        for s in sns:
            s.status = "IN_STOCK"
            s.location_id = location_id
    else:
        avail = round((wo.completed_qty or 0) - (wo.received_qty or 0), 4)
        n = qty if qty else avail
        if n <= 0 or n > avail + 1e-9:
            raise BizError(f"可入库数量为 {avail:g}")
    rc.lines.append(ReceiptLine(line_no=1, material_id=wo.material_id, qty=n, lot_no=wo.lot_no or "",
                                location_id=location_id, status=status, mfg_date=today(), expiry_date=exp))
    inv.add_stock(db, material_id=wo.material_id, location_id=location_id, lot_no=wo.lot_no or "", status=status,
                  qty=n, move_type="FG_RECEIPT", ref=ref, mfg_date=today(), expiry_date=exp)
    wo.received_qty = round((wo.received_qty or 0) + n, 4)
    db.flush()
    return rc


def dhr_checks(db: Session, wo: WorkOrder) -> list[dict]:
    open_ncr = db.scalar(select(func.count()).select_from(Ncr).where(Ncr.wo_id == wo.id, Ncr.status == "OPEN")) or 0
    short = [m for m in wo.materials if (m.issued_qty or 0) + 1e-9 < (m.qty_per or 0) * (wo.completed_qty or 0)]
    checks = [
        {"item": "工单已完工（完工+报废=计划数）", "ok": wo.status in ("COMPLETED", "CLOSED"),
         "detail": f"完工 {wo.completed_qty:g} / 报废 {wo.scrap_qty:g} / 计划 {wo.planned_qty:g}"},
        {"item": "物料已按 BOM 足额领用（批次可追溯）", "ok": not short,
         "detail": "；".join(f"{m.material_code} 已领 {m.issued_qty:g} < 应耗 {m.qty_per * wo.completed_qty:g}" for m in short) or "全部满足"},
        {"item": "无未处置的不合格品（NCR）", "ok": open_ncr == 0, "detail": f"未处置 NCR {open_ncr} 条"},
        {"item": "完工产品已全部入库", "ok": (wo.received_qty or 0) + 1e-9 >= (wo.completed_qty or 0),
         "detail": f"已入库 {wo.received_qty:g} / 完工 {wo.completed_qty:g}"},
    ]
    return checks


def build_dhr(db: Session, wo: WorkOrder) -> dict:
    """电子器械生产记录（DHR）：一个工单（生产批）的完整生产/检验/放行记录。"""
    p = wo.material
    issues = db.scalars(select(MaterialIssueLine).join(MaterialIssue)
                        .where(MaterialIssue.wo_id == wo.id, MaterialIssue.status == "CONFIRMED"))
    mat_rows: dict[tuple, dict] = {}
    for ln in issues:
        k = (ln.material_id, ln.lot_no)
        row = mat_rows.setdefault(k, {"material_code": ln.material_code, "material_name": ln.material_name,
                                      "lot_no": ln.lot_no, "qty": 0.0, "customer_supplied": bool(ln.owner_customer_id)})
        row["qty"] = round(row["qty"] + ln.qty, 4)
        insp = db.scalars(select(Inspection).where(Inspection.material_id == ln.material_id,
                                                   Inspection.lot_no == ln.lot_no).order_by(Inspection.id.desc())).first()
        row["iqc_no"] = insp.no if insp else None
        row["iqc_status"] = insp.status if insp else None
        row["supplier_name"] = insp.supplier_name if insp else None
    sns = list(db.scalars(select(SerialNumber).where(SerialNumber.wo_id == wo.id).order_by(SerialNumber.sn)))
    records = list(db.scalars(select(OperationRecord).where(OperationRecord.wo_id == wo.id).order_by(OperationRecord.id)))
    eq_ids = {r.equipment_id for r in records if r.equipment_id}
    equipment = [db.get(Equipment, i) for i in eq_ids]
    ncrs = list(db.scalars(select(Ncr).where(Ncr.wo_id == wo.id).order_by(Ncr.id)))
    sigs = list(db.scalars(select(ESignature).where(ESignature.entity == "mes_work_order", ESignature.entity_id == wo.id)
                           .order_by(ESignature.id)))
    first_pass = {}
    for r in records:
        if r.sn_id is None:
            continue
        first_pass.setdefault((r.seq, r.sn_id), r.result)
    ops = []
    for o in _wo_ops(wo):
        tried = [v for (s, _), v in first_pass.items() if s == o.seq]
        fpy = round(sum(1 for v in tried if v == "PASS") / len(tried) * 100, 1) if tried else None
        ops.append({**op_dict(o), "first_pass_yield": fpy})
    return {
        "work_order": {"id": wo.id, "no": wo.no, "lot_no": wo.lot_no, "status": wo.status, "dhr_status": wo.dhr_status,
                       "planned_qty": wo.planned_qty, "completed_qty": wo.completed_qty, "scrap_qty": wo.scrap_qty,
                       "received_qty": wo.received_qty, "actual_start": wo.actual_start, "actual_end": wo.actual_end,
                       "so_no": wo.so_no, "customer_name": wo.customer_name, "bom_version": wo.bom_version,
                       "routing_version": wo.routing_version},
        "product": {"code": p.code, "name": p.name, "model": p.model, "spec": p.spec, "registration_no": p.registration_no,
                    "device_class": p.device_class, "gtin": p.gtin},
        "materials": list(mat_rows.values()),
        "operations": ops,
        "serials": [{"sn": s.sn, "udi": s.udi, "status": s.status} for s in sns],
        "records": [{"ts": r.ts, "sn": r.sn, "seq": r.seq, "op_name": r.op_name, "result": r.result, "qty": r.qty,
                     "operator_name": r.operator_name, "equipment_code": r.equipment_code, "is_rework": r.is_rework,
                     "values": [{"name": v.name, "value": v.value, "unit": v.unit, "lower": v.lower, "upper": v.upper,
                                 "result": v.result} for v in r.values]} for r in records],
        "equipment": [{"code": e.code, "name": e.name, "calibration_required": e.calibration_required,
                       "last_calibration_date": e.last_calibration_date, "next_calibration_date": e.next_calibration_date}
                      for e in equipment if e],
        "ncrs": [{"no": n.no, "sn": n.sn, "op_name": n.op_name, "description": n.description, "status": n.status,
                  "disposition": n.disposition} for n in ncrs],
        "signatures": [{"ts": s.ts, "full_name": s.full_name, "meaning": s.meaning, "reason": s.reason} for s in sigs],
        "checks": dhr_checks(db, wo),
    }


def release_dhr(db: Session, user: User, wo: WorkOrder, approve: bool, sig, reason: str | None = None):
    from ..security import esign

    if wo.dhr_status == "RELEASED":
        raise BizError("该批已放行")
    if approve:
        bad = [c["item"] for c in dhr_checks(db, wo) if not c["ok"]]
        if bad:
            raise BizError("DHR 审核未通过，不能放行：" + "；".join(bad))
    esign(db, user, sig, "产品放行（DHR审核批准）" if approve else "产品放行（DHR审核拒绝）", "mes_work_order", wo.id, wo.no)
    ref = inv.Ref("WORK_ORDER", wo.id, wo.no, user.username, reason)
    if approve:
        inv.change_lot_status(db, material_id=wo.material_id, lot_no=wo.lot_no or "", from_status="QUARANTINE",
                              to_status="AVAILABLE", move_type="FG_RELEASE", ref=ref)
        wo.dhr_status = "RELEASED"
        wo.status = "CLOSED"
    else:
        inv.change_lot_status(db, material_id=wo.material_id, lot_no=wo.lot_no or "", from_status="QUARANTINE",
                              to_status="HOLD", move_type="STATUS_CHANGE", ref=ref)
        wo.dhr_status = "REJECTED"
    db.flush()
    return wo
