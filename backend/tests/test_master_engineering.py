"""主数据、BOM/工艺受控发布、权限、审计。"""
from .conftest import SIG, find, ids


def test_permissions_and_material_validation(api):
    r = api.as_("op1").post("/api/materials", {"code": "X1", "name": "测试"})
    assert r.status_code == 403
    r = api.as_("engineer").post("/api/materials", {"code": "FG-X", "name": "成品X", "category": "FINISHED", "gtin": "06970000000011"})
    assert r.status_code == 400 and "校验位" in r.json()["detail"]
    m = api.as_("engineer").ok("post", "/api/materials", {"code": "FG-X", "name": "成品X", "category": "FINISHED", "serial_control": True})
    r = api.as_("engineer").post("/api/materials", {"code": "FG-X", "name": "重复"})
    assert r.status_code == 400 and "已存在" in r.json()["detail"]
    # 被 BOM 引用的物料不能删除
    led = find(api, "/api/materials", q="LED-660-3030")
    r = api.as_("engineer").delete(f"/api/materials/{led['id']}")
    assert r.status_code == 400 and "引用" in r.json()["detail"]
    api.as_("engineer").ok("delete", f"/api/materials/{m['id']}")


def test_bom_lifecycle_and_audit(api):
    ref = ids(api)
    bom = api.as_("engineer").ok("post", "/api/boms", {"material_id": ref["m"]["FG-BL100"], "version": "A1", "lines": [
        {"component_id": ref["m"]["LED-460-5050"], "qty_per": 48},
        {"component_id": ref["m"]["PCB-AL-BL100"], "qty_per": 1}]})
    assert bom["status"] == "DRAFT"
    # 自引用
    r = api.as_("engineer").put(f"/api/boms/{bom['id']}", {"material_id": ref["m"]["FG-BL100"], "version": "A1", "lines": [
        {"component_id": ref["m"]["FG-BL100"], "qty_per": 1}]})
    assert r.status_code == 400
    # 发布需要电子签名
    r = api.as_("engineer").post(f"/api/boms/{bom['id']}/release", {"signature": {"password": "bad"}})
    assert r.status_code == 400
    bom = api.as_("engineer").ok("post", f"/api/boms/{bom['id']}/release", {"signature": SIG})
    assert bom["status"] == "RELEASED" and bom["released_by"] == "吴工艺"
    old = api.ok("get", "/api/boms", params={"material_id": ref["m"]["FG-BL100"], "status": "OBSOLETE"})["items"]
    assert old and old[0]["version"] == "A0"
    # 发布后不可修改，只能升版
    r = api.as_("engineer").put(f"/api/boms/{bom['id']}", {"material_id": ref["m"]["FG-BL100"], "version": "A1", "lines": []})
    assert r.status_code == 400 and "升版" in r.json()["detail"]
    nb = api.as_("engineer").ok("post", f"/api/boms/{bom['id']}/new-version", {"version": "A2", "ecn_no": "ECN-001"})
    assert nb["status"] == "DRAFT" and len(nb["lines"]) == 2
    # 多级展开
    rl = find(api, "/api/boms", material_id=ref["m"]["FG-RL300"], status="RELEASED")
    tree = api.ok("get", f"/api/boms/{rl['id']}/tree", params={"qty": 10})["tree"]
    lb = next(n for n in tree if n["code"] == "SA-RL300-LB")
    led = next(n for n in lb["children"] if n["code"] == "LED-660-3030")
    assert led["total_qty"] == 606.0  # 10 × 60 × 1.01
    # 审计追踪 + 电子签名
    logs = api.ok("get", "/api/system/audit-logs", params={"entity": "eng_bom", "entity_id": bom["id"]})["items"]
    assert {l["action"] for l in logs} >= {"CREATE", "UPDATE"} and all(l["username"] == "engineer" for l in logs)
    sig = api.ok("get", "/api/system/esignatures", params={"entity": "eng_bom"})["items"][0]
    assert sig["meaning"] == "BOM发布批准"


def test_routing_release_and_wo_snapshot(api):
    ref = ids(api)
    rt = find(api, "/api/routings", material_id=ref["m"]["FG-BL100"], status="RELEASED")
    wo = api.as_("pmc").ok("post", "/api/work-orders", {"material_id": ref["m"]["FG-BL100"], "planned_qty": 2})
    wo = api.as_("pmc").ok("post", f"/api/work-orders/{wo['id']}/release")
    nr = api.as_("engineer").ok("post", f"/api/routings/{rt['id']}/new-version", {"version": "A1"})
    ops = api.ok("get", f"/api/routings/{nr['id']}")["operations"]
    ops[1]["params"][0]["upper"] = 999
    api.as_("engineer").ok("put", f"/api/routings/{nr['id']}", {"material_id": ref["m"]["FG-BL100"], "version": "A1", "operations": ops})
    api.as_("engineer").ok("post", f"/api/routings/{nr['id']}/release", {"signature": SIG})
    # 已下达工单的工序规格是快照，不受新版本影响
    wo = api.ok("get", f"/api/work-orders/{wo['id']}")
    assert wo["operations"][1]["params"][0]["upper"] == 470


def test_calibration_record_updates_equipment(api):
    ref = ids(api)
    eid = ref["eq"]["EQ-SPEC-02"]
    api.as_("qa").ok("post", f"/api/equipment/{eid}/calibrations", {"calibration_date": "2026-11-01", "certificate_no": "CAL-001"})
    eq = api.ok("get", f"/api/equipment/{eid}")
    assert eq["next_calibration_date"] == "2027-11-01"
    api.as_("qa").ok("post", f"/api/equipment/{eid}/calibrations", {"calibration_date": "2026-11-02", "result": "FAIL"})
    assert api.ok("get", f"/api/equipment/{eid}")["status"] == "DISABLED"


def test_auth_and_users(api):
    assert api.c.get("/api/dashboard").status_code == 401
    r = api.c.post("/api/auth/login", json={"username": "admin", "password": "x"})
    assert r.status_code == 401
    me = api.as_("qa").ok("get", "/api/auth/me")
    assert "qa" in me["permissions"] and "admin" not in me["permissions"]
    assert api.as_("qa").get("/api/system/users").status_code == 403
    u = api.ok("post", "/api/system/users", {"username": "op9", "full_name": "新员工", "password": "abc12345", "roles": ["operator"]})
    assert u["roles"] == "operator"
    r = api.post("/api/system/users", {"username": "op8", "full_name": "x", "password": "abc12345", "roles": ["boss"]})
    assert r.status_code == 400
