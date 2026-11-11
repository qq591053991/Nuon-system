"""端到端：销售订单 → 工单下达 → 领料 → 工位过站（防呆/校准/测试判定/NCR）→ 完工入库 → DHR 放行 → 发货 → 应收 → 追溯。"""
from .conftest import SIG, find, ids

GOOD_VALUES = {
    20: {"WL_RED": 660, "WL_NIR": 850, "IRR": 50},
    30: {"AGE_H": 4, "IRR_DROP": 1.2},
    40: {"HIPOT": 1.1, "EARTH_LK": 120, "PAT_LK": 20},
}


def _report(api, sn, seq, ref, **kw):
    eq = {20: ref["eq"]["EQ-SPEC-01"], 30: ref["eq"]["EQ-AGING-01"], 40: ref["eq"]["EQ-SAFE-01"]}.get(seq)
    body = {"sn": sn, "seq": seq, "values": GOOD_VALUES.get(seq, {}), "equipment_id": eq}
    if seq == 60:
        body["key_parts"] = [{"lot_no": "HY2609A"}]
    body.update(kw)
    return api.as_("op1").post("/api/mes/report", body)


def test_full_production_flow(api):
    ref = ids(api)
    so = find(api, "/api/sales-orders", q="LUM-PO-26-118")
    assert so["status"] == "CONFIRMED"

    # 一键生成工单（计划员）
    res = api.as_("pmc").ok("post", f"/api/sales-orders/{so['id']}/create-work-orders")
    assert len(res["work_orders"]) == 1
    wo = find(api, "/api/work-orders", q=res["work_orders"][0])
    assert wo["planned_qty"] == 20
    # 改成 3 台便于测试
    api.as_("pmc").ok("put", f"/api/work-orders/{wo['id']}", {"material_id": wo["material_id"], "planned_qty": 3})

    # 操作员无权下达
    assert api.as_("op1").post(f"/api/work-orders/{wo['id']}/release").status_code == 403
    wo = api.as_("pmc").ok("post", f"/api/work-orders/{wo['id']}/release")
    assert wo["status"] == "RELEASED" and wo["lot_no"].startswith("B")
    assert {o["seq"] for o in wo["operations"]} == {10, 20, 30, 40, 50, 60}
    mats = {m["material_code"]: m for m in wo["materials"]}
    assert "LED-660-3030" not in mats and mats["SA-RL300-LB"]["required_qty"] == 3  # LED 在半成品灯板中
    assert mats["SCREW-M3X8"]["required_qty"] == 37  # 3×12×1.02 = 36.72 → 向上取整
    serials = api.ok("get", f"/api/work-orders/{wo['id']}/serials")
    assert len(serials) == 3 and serials[0]["udi"].startswith("(01)") and f"(10){wo['lot_no']}" in serials[0]["udi"]
    sns = [s["sn"] for s in serials]

    # 领料：FEFO 自动分配，客供料只从该客户货主库存出
    issue = api.as_("wh").ok("post", f"/api/work-orders/{wo['id']}/issues", {})
    assert not issue["shortages"]
    cs_lines = [l for l in issue["lines"] if l["material_code"] == "PKG-RL300-BOX"]
    assert cs_lines and cs_lines[0]["owner_customer_id"] == wo["customer_id"]
    api.as_("wh").ok("post", f"/api/issues/{issue['id']}/confirm")
    wo = api.ok("get", f"/api/work-orders/{wo['id']}")
    assert all(m["issued_qty"] >= m["required_qty"] for m in wo["materials"])

    # 防呆：未做组装不能直接光学测试
    r = _report(api, sns[0], 20, ref)
    assert r.status_code == 400 and "防呆" in r.json()["detail"]
    # 正常组装
    assert _report(api, sns[0], 10, ref).json()["result"] == "PASS"
    # 光学测试必须选设备；校准过期的设备被拒
    r = _report(api, sns[0], 20, ref, equipment_id=None)
    assert r.status_code == 400 and "设备" in r.json()["detail"]
    r = _report(api, sns[0], 20, ref, equipment_id=ref["eq"]["EQ-SPEC-02"])
    assert r.status_code == 400 and "校准已过期" in r.json()["detail"]
    # 漏填测试项
    r = _report(api, sns[0], 20, ref, values={"WL_RED": 660})
    assert r.status_code == 400 and "测量值" in r.json()["detail"]
    # 辐照度超上限 → 系统自动判 FAIL 并开 NCR
    res = _report(api, sns[0], 20, ref, values={"WL_RED": 660, "WL_NIR": 850, "IRR": 65}).json()
    assert res["result"] == "FAIL" and res["ncr_no"]
    # NG 产品在处置前不能继续报工
    r = _report(api, sns[0], 20, ref)
    assert r.status_code == 400 and "NCR" in r.json()["detail"]
    ncr = find(api, "/api/ncrs", q=res["ncr_no"])
    # 质检员没有处置权限；过程不合格不允许让步放行；密码错误签名失败
    assert api.as_("qc").post(f"/api/ncrs/{ncr['id']}/disposition", {"disposition": "REWORK", "signature": SIG}).status_code == 403
    r = api.as_("qa").post(f"/api/ncrs/{ncr['id']}/disposition", {"disposition": "USE_AS_IS", "signature": SIG})
    assert r.status_code == 400
    r = api.as_("qa").post(f"/api/ncrs/{ncr['id']}/disposition",
                           {"disposition": "REWORK", "signature": {"password": "wrong"}})
    assert r.status_code == 400 and "签名" in r.json()["detail"]
    api.as_("qa").ok("post", f"/api/ncrs/{ncr['id']}/disposition", {"disposition": "REWORK", "remark": "更换IC", "signature": SIG})
    # 返工后重新测试通过，标记为返工记录
    assert _report(api, sns[0], 20, ref).json()["result"] == "PASS"
    scan = api.ok("get", f"/api/mes/scan/{sns[0]}")
    assert scan["next_operation"]["seq"] == 30 and any(h["is_rework"] for h in scan["history"])

    # 关键件：包装工序需绑定已领用的电源批次
    for seq in (30, 40, 50):
        assert _report(api, sns[0], seq, ref).json()["result"] == "PASS"
    r = _report(api, sns[0], 60, ref, key_parts=[{"lot_no": "NOT-ISSUED"}])
    assert r.status_code == 400 and "未领用" in r.json()["detail"]
    assert _report(api, sns[0], 60, ref).json()["sn_status"] == "COMPLETED"

    # 第二台全部通过；第三台安规失败 → 报废
    for seq in (10, 20, 30, 40, 50, 60):
        assert _report(api, sns[1], seq, ref).json()["result"] == "PASS"
    for seq in (10, 20, 30):
        _report(api, sns[2], seq, ref)
    res = _report(api, sns[2], 40, ref, values={"HIPOT": 1, "EARTH_LK": 100, "PAT_LK": 150}).json()
    assert res["result"] == "FAIL"
    ncr2 = find(api, "/api/ncrs", q=res["ncr_no"])
    api.as_("qa").ok("post", f"/api/ncrs/{ncr2['id']}/disposition", {"disposition": "SCRAP", "signature": SIG})
    wo = api.ok("get", f"/api/work-orders/{wo['id']}")
    assert wo["status"] == "COMPLETED" and wo["completed_qty"] == 2 and wo["scrap_qty"] == 1

    # DHR：未入库前检查项不通过，不能放行
    dhr = api.ok("get", f"/api/work-orders/{wo['id']}/dhr")
    assert not all(c["ok"] for c in dhr["checks"])
    r = api.as_("qa").post(f"/api/work-orders/{wo['id']}/dhr/release", {"approve": True, "signature": SIG})
    assert r.status_code == 400

    # 完工入库 → 待放行
    fg = api.as_("wh").ok("post", f"/api/work-orders/{wo['id']}/fg-receipt", {"location_id": ref["loc"]["FG-01"]})
    assert fg["lines"][0]["qty"] == 2 and fg["lines"][0]["status"] == "QUARANTINE"
    # 未放行不能发货
    so_detail = api.ok("get", f"/api/sales-orders/{so['id']}")
    r = api.as_("wh").post("/api/shipments", {"so_id": so["id"], "lines": [{"so_line_id": so_detail["lines"][0]["id"], "qty": 1, "serials": [sns[0]]}]})
    assert r.status_code == 400 and "放行" in r.json()["detail"]

    # QA 电子签名放行
    dhr = api.ok("get", f"/api/work-orders/{wo['id']}/dhr")
    assert all(c["ok"] for c in dhr["checks"]), dhr["checks"]
    assert len(dhr["materials"]) >= 10 and dhr["operations"][1]["first_pass_yield"] < 100
    wo = api.as_("qa").ok("post", f"/api/work-orders/{wo['id']}/dhr/release", {"approve": True, "signature": SIG})
    assert wo["dhr_status"] == "RELEASED" and wo["status"] == "CLOSED"
    stock = api.ok("get", "/api/stock", params={"lot_no": wo["lot_no"]})["items"]
    assert stock[0]["status"] == "AVAILABLE" and stock[0]["qty"] == 2

    # 报废的序列号不能发货
    r = api.as_("wh").post("/api/shipments", {"so_id": so["id"], "lines": [{"so_line_id": so_detail["lines"][0]["id"], "qty": 1, "serials": [sns[2]]}]})
    assert r.status_code == 400
    # 发货（自动选取已放行序列号）
    sh = api.as_("wh").ok("post", "/api/shipments", {"so_id": so["id"], "carrier": "顺丰", "lines": [{"so_line_id": so_detail["lines"][0]["id"], "qty": 2}]})
    assert sorted(sh["lines"][0]["serial_list"]) == sorted(sns[:2])
    sh = api.as_("wh").ok("post", f"/api/shipments/{sh['id']}/confirm")
    assert sh["status"] == "SHIPPED"
    so_detail = api.ok("get", f"/api/sales-orders/{so['id']}")
    assert so_detail["status"] == "PARTIAL_SHIPPED" and so_detail["lines"][0]["shipped_qty"] == 2
    ar = api.ok("get", "/api/finance/docs", params={"doc_type": "AR"})["items"]
    assert ar and ar[0]["amount"] == 2 * 88.0

    # 追溯
    t = api.ok("get", f"/api/trace/serial/{sns[0]}")
    assert t["shipment"]["customer_name"] == "Lumina Health Inc."
    assert any(r["is_rework"] for r in t["records"]) and t["key_parts"][0]["lot_no"] == "HY2609A"
    assert any(m["lot_no"] == "HY2609A" for m in t["materials"])
    t = api.ok("get", "/api/trace/lot", params={"material_code": "PSU-24V-5A", "lot_no": "HY2609A"})
    assert t["summary"]["shipped"] == 2 and t["customers"][0]["customer_name"] == "Lumina Health Inc."

    # 电子签名与审计追踪
    sigs = api.ok("get", "/api/system/esignatures", params={"entity": "mes_work_order", "entity_id": wo["id"]})["items"]
    assert sigs[0]["meaning"].startswith("产品放行") and sigs[0]["full_name"] == "赵QA"
    logs = api.ok("get", "/api/system/audit-logs", params={"entity": "mes_work_order", "entity_id": wo["id"]})["items"]
    assert any(l["action"] == "UPDATE" and "dhr_status" in l["changes"] and l["username"] == "qa" for l in logs)

    # 驾驶舱
    d = api.ok("get", "/api/dashboard")
    assert d["kpi"]["fpy"] is not None and d["kpi"]["today_output"] == 2


def test_batch_reporting_for_non_serial_product(api):
    """半成品（非序列号）按批量报工，防超报。"""
    ref = ids(api)
    wo = api.as_("pmc").ok("post", "/api/work-orders", {"material_id": ref["m"]["SA-RL300-LB"], "planned_qty": 10})
    wo = api.as_("pmc").ok("post", f"/api/work-orders/{wo['id']}/release")
    assert not wo["serial_control"]
    op = api.as_("op1")
    r = op.post(f"/api/work-orders/{wo['id']}/report-batch", {"seq": 20, "good_qty": 1})
    assert r.status_code == 400  # 上道工序未报工
    op.ok("post", f"/api/work-orders/{wo['id']}/report-batch", {"seq": 10, "good_qty": 8, "ng_qty": 2})
    r = op.post(f"/api/work-orders/{wo['id']}/report-batch", {"seq": 20, "good_qty": 9})
    assert r.status_code == 400 and "超出" in r.json()["detail"]
    op.ok("post", f"/api/work-orders/{wo['id']}/report-batch", {"seq": 20, "good_qty": 8})
    ncr = find(api, "/api/ncrs", wo_id=wo["id"])
    api.as_("qa").ok("post", f"/api/ncrs/{ncr['id']}/disposition", {"disposition": "REWORK", "signature": SIG})
    op.ok("post", f"/api/work-orders/{wo['id']}/report-batch", {"seq": 10, "good_qty": 2})
    res = op.ok("post", f"/api/work-orders/{wo['id']}/report-batch", {"seq": 20, "good_qty": 2})
    assert res["wo_status"] == "COMPLETED" and res["wo_completed_qty"] == 10
