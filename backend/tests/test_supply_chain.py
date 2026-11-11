"""采购/IQC/客供料/MRP/库存作业。"""
import io

from openpyxl import Workbook

from .conftest import SIG, find, ids


def _po(api, supplier_code, material_id, qty=1000, price=0.35):
    sup = find(api, "/api/suppliers", q=supplier_code)
    return api.as_("buyer").ok("post", "/api/purchase-orders", {
        "supplier_id": sup["id"], "lines": [{"material_id": material_id, "qty": qty, "unit_price": price}]})


def test_po_requires_qualified_supplier(api):
    ref = ids(api)
    po = _po(api, "S006", ref["m"]["LED-660-3030"])
    r = api.as_("buyer").post(f"/api/purchase-orders/{po['id']}/approve")
    assert r.status_code == 400 and "合格供方" in r.json()["detail"]
    # 客供料不能采购
    sup = find(api, "/api/suppliers", q="S005")
    r = api.as_("buyer").post("/api/purchase-orders", {"supplier_id": sup["id"], "lines": [
        {"material_id": ref["m"]["PKG-RL300-BOX"], "qty": 10}]})
    assert r.status_code == 400 and "客供料" in r.json()["detail"]


def test_receive_iqc_reject_and_return(api):
    ref = ids(api)
    led = ref["m"]["LED-850-3030"]
    po = _po(api, "S001", led, qty=1000, price=0.42)
    api.as_("buyer").ok("post", f"/api/purchase-orders/{po['id']}/approve")
    # 超收（>5%）被拒
    r = api.as_("wh").post(f"/api/purchase-orders/{po['id']}/receive", {"lines": [
        {"po_line_id": po["lines"][0]["id"], "qty": 1100, "location_id": ref["loc"]["DRY-01"]}]})
    assert r.status_code == 400 and "超收" in r.json()["detail"]
    rc = api.as_("wh").ok("post", f"/api/purchase-orders/{po['id']}/receive", {"delivery_note": "DN-1", "lines": [
        {"po_line_id": po["lines"][0]["id"], "qty": 1000, "location_id": ref["loc"]["DRY-01"], "lot_no": "NEW-850"}]})
    assert rc["lines"][0]["status"] == "QUARANTINE"
    po = api.ok("get", f"/api/purchase-orders/{po['id']}")
    assert po["status"] == "RECEIVED"
    ap = api.ok("get", "/api/finance/docs", params={"doc_type": "AP"})["items"][0]
    assert ap["amount"] == 420.0

    insp = find(api, "/api/inspections", q="NEW-850")
    # 批量 1000、AQL 0.65 → J 字码 n=80 Ac=1
    assert (insp["sample_size"], insp["accept_num"], insp["status"]) == (80, 1, "PENDING")
    # 待检库存不能被领用分配：FEFO 只取合格库存
    stock = api.ok("get", "/api/stock", params={"lot_no": "NEW-850"})["items"]
    assert stock[0]["status"] == "QUARANTINE"

    # 不良 3 > Ac=1 → 判不合格，库存转不合格并自动开 NCR
    detail = api.ok("get", f"/api/inspections/{insp['id']}")
    items = [{**i, "result": "FAIL" if i["name"] == "峰值波长抽测" else "PASS"} for i in detail["items"]]
    res = api.as_("qc").ok("post", f"/api/inspections/{insp['id']}/submit",
                           {"defect_qty": 3, "items": items, "remark": "波长偏移", "signature": SIG})
    assert res["status"] == "REJECTED"
    assert api.ok("get", "/api/stock", params={"lot_no": "NEW-850"})["items"][0]["status"] == "REJECTED"
    ncr = find(api, "/api/ncrs", source="IQC")
    assert ncr["status"] == "OPEN" and "峰值波长抽测" in ncr["description"]
    api.as_("qa").ok("post", f"/api/ncrs/{ncr['id']}/disposition", {"disposition": "RETURN", "signature": SIG})
    assert api.ok("get", "/api/stock", params={"lot_no": "NEW-850"})["items"] == []
    moves = api.ok("get", "/api/stock-moves", params={"lot_no": "NEW-850"})["items"]
    assert [m["move_type"] for m in moves][:2] == ["RETURN_SUPPLIER", "IQC_REJECT"]
    api.as_("qa").ok("post", f"/api/ncrs/{ncr['id']}/close")


def test_iqc_pass_and_concession(api):
    ref = ids(api)
    for lot, defects, concession, expected in [("OK-1", 0, False, "PASSED"), ("CON-1", 5, True, "CONCESSION")]:
        po = _po(api, "S004", ref["m"]["HSG-RL300-U"], qty=200, price=12)
        api.as_("buyer").ok("post", f"/api/purchase-orders/{po['id']}/approve")
        api.as_("wh").ok("post", f"/api/purchase-orders/{po['id']}/receive", {"lines": [
            {"po_line_id": po["lines"][0]["id"], "qty": 200, "location_id": ref["loc"]["RAW-A02"], "lot_no": lot}]})
        insp = find(api, "/api/inspections", q=lot)
        who = "qa" if concession else "qc"
        if concession:  # 质检员不能批准让步
            r = api.as_("qc").post(f"/api/inspections/{insp['id']}/submit", {"defect_qty": defects, "concession": True, "signature": SIG})
            assert r.status_code == 400
        res = api.as_(who).ok("post", f"/api/inspections/{insp['id']}/submit",
                              {"defect_qty": defects, "concession": concession, "signature": SIG})
        assert res["status"] == expected
        assert api.ok("get", "/api/stock", params={"lot_no": lot})["items"][0]["status"] == "AVAILABLE"


def test_customer_supplied_receipt_isolation(api):
    ref = ids(api)
    c1 = find(api, "/api/customers", q="C001")
    c2 = find(api, "/api/customers", q="C002")
    line = {"material_id": ref["m"]["PKG-RL300-IFU"], "qty": 100, "location_id": ref["loc"]["CS-01"], "lot_no": "IFU-NEW"}
    r = api.as_("wh").post("/api/receipts", {"receipt_type": "CUSTOMER_SUPPLIED", "customer_id": c2["id"], "lines": [line]})
    assert r.status_code == 400 and "货主" in r.json()["detail"]
    rc = api.as_("wh").ok("post", "/api/receipts", {"receipt_type": "CUSTOMER_SUPPLIED", "customer_id": c1["id"], "lines": [line]})
    assert rc["lines"][0]["status"] == "QUARANTINE"
    st = api.ok("get", "/api/stock", params={"lot_no": "IFU-NEW"})["items"][0]
    assert st["owner_customer_id"] == c1["id"]


def test_mrp_and_convert(api):
    ref = ids(api)
    so = find(api, "/api/sales-orders", q="LUM-PO-26-131")  # 200 台草稿
    api.as_("sales").ok("post", f"/api/sales-orders/{so['id']}/confirm")
    run = api.as_("pmc").ok("post", "/api/mrp/run")
    by = {s["material_code"]: s for s in run["suggestions"]}
    assert by["FG-RL300"]["action"] == "PRODUCE"
    assert by["SA-RL300-LB"]["action"] == "PRODUCE" and by["SA-RL300-LB"]["level"] > by["FG-RL300"]["level"]
    assert by["LED-660-3030"]["action"] == "PURCHASE"  # 灯板的下层物料
    assert by["PKG-RL300-BOX"]["action"] == "CUSTOMER_SUPPLY"
    # 安全库存计入：LED 净需求 ≥ 毛需求 + 安全库存 − 库存
    led = by["LED-660-3030"]
    assert led["net_qty"] == round(led["gross_qty"] + led["safety_stock"] - led["on_hand_qty"] - led["on_order_qty"], 4)
    res = api.as_("pmc").ok("post", "/api/mrp/convert", {"suggestion_ids": [led["id"], by["FG-RL300"]["id"], by["PKG-RL300-BOX"]["id"]]})
    assert len(res["purchase_orders"]) == 1 and len(res["work_orders"]) == 1 and res["skipped"]
    po = find(api, "/api/purchase-orders", q=res["purchase_orders"][0])
    assert po["status"] == "DRAFT" and po["source"] == "MRP" and po["lines"][0]["qty"] == led["suggested_qty"]


def test_transfer_and_stock_count(api):
    ref = ids(api)
    st = api.ok("get", "/api/stock", params={"lot_no": "JS2609S"})["items"][0]  # 螺丝 3000
    api.as_("wh").ok("post", "/api/stock/transfer", {"stock_id": st["id"], "qty": 500, "to_location_id": ref["loc"]["LINE-01"]})
    locs = {s["location_code"]: s["qty"] for s in api.ok("get", "/api/stock", params={"lot_no": "JS2609S"})["items"]}
    assert locs == {"RAW-A02": 2500, "LINE-01": 500}
    r = api.as_("wh").post("/api/stock/transfer", {"stock_id": st["id"], "qty": 99999, "to_location_id": ref["loc"]["LINE-01"]})
    assert r.status_code == 400 and "库存不足" in r.json()["detail"]

    wh = find(api, "/api/warehouses", q="WH-WIP")
    sc = api.as_("wh").ok("post", "/api/stock-counts", {"warehouse_id": wh["id"]})
    assert api.as_("wh").post(f"/api/stock-counts/{sc['id']}/post").status_code == 400  # 未录入实盘
    lines = [{"id": l["id"], "counted_qty": l["system_qty"] - (2 if l["lot_no"] == "JS2609S" else 0)} for l in sc["lines"]]
    api.as_("wh").ok("put", f"/api/stock-counts/{sc['id']}/lines", lines)
    sc = api.as_("wh").ok("post", f"/api/stock-counts/{sc['id']}/post")
    assert sc["status"] == "POSTED"
    locs = {s["location_code"]: s["qty"] for s in api.ok("get", "/api/stock", params={"lot_no": "JS2609S"})["items"]}
    assert locs["LINE-01"] == 498


def test_import_materials_from_kingdee_excel(api):
    wb = Workbook()
    ws = wb.active
    ws.append(["物料列表（金蝶K/3 Cloud 导出）"])  # 顶部标题行应被跳过
    ws.append(["编码", "名称", "规格型号", "物料属性", "基本单位", "安全库存", "默认供应商"])
    ws.append(["LED-630-2835", "红光LED 630nm", "2835 0.2W", "外购", "PCS", 1000, "S001"])
    ws.append(["FG-MASK-M1", "LED面罩 M1", "三色光 硅胶", "成品", "台", 0, None])
    buf = io.BytesIO()
    wb.save(buf)
    files = {"file": ("materials.xlsx", buf.getvalue(), "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")}
    res = api.as_("engineer").ok("post", "/api/import/materials", files=files)
    assert res == {"ok": True, "created": 2, "updated": 0, "errors": []}
    m = find(api, "/api/materials", q="LED-630-2835")
    assert m["category"] == "RAW" and m["safety_stock"] == 1000 and m["default_supplier_name"].startswith("晶光")

    csv = "物料编码,物料名称,物料类别\nLED-630-2835,红光LED 630nm 改,原材料\nBAD-1,坏数据,未知类别\n"
    res = api.as_("engineer").ok("post", "/api/import/materials", files={"file": ("m.csv", csv.encode(), "text/csv")})
    assert not res["ok"] and res["errors"][0]["row"] == 3  # 有错误时整体回滚
    assert find(api, "/api/materials", q="LED-630-2835")["name"] == "红光LED 630nm"
    assert api.as_("engineer").get("/api/import/templates/boms").status_code == 200
