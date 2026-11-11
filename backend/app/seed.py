"""初始化/演示数据。

    python -m app.seed            # 初始化基础数据（用户、主数据、BOM、工艺、期初库存、订单）
    python -m app.seed --demo     # 额外跑一遍完整业务流程，生成生产/质量/发货演示数据
    python -m app.seed --reset    # 清空数据库后重建
"""
import random
import sys
from datetime import timedelta

from sqlalchemy import select

from .config import today
from .db import SessionLocal, engine
from .models import (
    Base, Bom, BomLine, Customer, Equipment, Location, Material, Routing, RoutingOperation, RoutingParam,
    SalesOrder, SalesOrderLine, Supplier, User, Warehouse, WorkCenter,
)
from .security import SignatureIn, hash_password
from .services.udi import make_gtin14

DEMO_PASSWORD = "Nuon@2026"

USERS = [
    ("admin", "系统管理员", "admin", "信息部"), ("manager", "王厂长", "manager", "总经办"),
    ("sales", "李销售", "sales", "销售部"), ("buyer", "陈采购", "purchaser", "采购部"),
    ("pmc", "周计划", "planner", "PMC"), ("engineer", "吴工艺", "engineer", "工程部"),
    ("wh", "郑仓管", "warehouse", "仓储部"), ("op1", "刘操作", "operator", "生产部"), ("op2", "黄操作", "operator", "生产部"),
    ("qc", "孙质检", "qc", "品质部"), ("qa", "赵QA", "qa", "品质部"), ("finance", "钱财务", "finance", "财务部"),
]


def _get_or_add(db, cls, code, /, **kw):
    obj = db.scalar(select(cls).where(cls.code == code))
    if obj is None:
        obj = cls(code=code, created_by="system", **kw)
        db.add(obj)
        db.flush()
    return obj


def seed_base(db) -> dict:
    t = today()
    for username, name, role, dept in USERS:
        if not db.scalar(select(User).where(User.username == username)):
            db.add(User(username=username, full_name=name, roles=role, department=dept,
                        password_hash=hash_password(DEMO_PASSWORD), created_by="system"))
    db.flush()

    c1 = _get_or_add(db, Customer, "C001", name="Lumina Health Inc.", short_name="Lumina", country="美国",
                     contact="Emily Carter", currency="USD", payment_terms_days=60, mah_name="Lumina Health Inc.",
                     quality_agreement_no="QA-C001-2026", quality_agreement_expiry=t + timedelta(days=500))
    c2 = _get_or_add(db, Customer, "C002", name="光悦医疗器械（上海）有限公司", short_name="光悦医疗", country="中国",
                     contact="张经理", currency="CNY", payment_terms_days=30, mah_name="光悦医疗器械（上海）有限公司",
                     quality_agreement_no="QA-C002-2026", quality_agreement_expiry=t + timedelta(days=300))
    c3 = _get_or_add(db, Customer, "C003", name="BrightSkin Co., Ltd.", short_name="BrightSkin", country="韩国",
                     contact="Kim Min-jun", currency="USD", payment_terms_days=45)

    s1 = _get_or_add(db, Supplier, "S001", name="晶光半导体（厦门）有限公司", short_name="晶光半导体", category="LED芯片/灯珠",
                     status="QUALIFIED", qualification_expiry=t + timedelta(days=220), iso13485=False)
    s2 = _get_or_add(db, Supplier, "S002", name="鑫达电子科技有限公司", short_name="鑫达电子", category="PCB/IC",
                     status="QUALIFIED", qualification_expiry=t + timedelta(days=300))
    s3 = _get_or_add(db, Supplier, "S003", name="恒源医用电源有限公司", short_name="恒源电源", category="医用电源/线材",
                     status="QUALIFIED", qualification_expiry=t + timedelta(days=40), iso13485=True)
    s4 = _get_or_add(db, Supplier, "S004", name="精塑模具制品有限公司", short_name="精塑模具", category="结构件/五金",
                     status="QUALIFIED", qualification_expiry=t + timedelta(days=365))
    s5 = _get_or_add(db, Supplier, "S005", name="佳印包装印刷有限公司", short_name="佳印包装", category="包材/标签",
                     status="QUALIFIED", qualification_expiry=t + timedelta(days=365))
    _get_or_add(db, Supplier, "S006", name="新锐光电有限公司", short_name="新锐光电", category="LED芯片/灯珠",
                status="PENDING", remark="样品评估中，未完成供应商审核")

    def mat(code, name, spec, cat="RAW", sup=None, cost=0, ss=0, lead=7, **kw):
        return _get_or_add(db, Material, code, name=name, spec=spec, category=cat,
                           default_supplier_id=sup.id if sup else None, std_cost=cost, safety_stock=ss,
                           lead_time_days=lead, **kw)

    m = {}
    m["LED660"] = mat("LED-660-3030", "红光LED 660nm", "3030 0.5W 660±5nm", sup=s1, cost=0.35, ss=2000, lead=15,
                      aql=0.65, wavelength_nm="660", msl_level="3", esd_sensitive=True, shelf_life_days=365, min_order_qty=1000)
    m["LED850"] = mat("LED-850-3030", "近红外LED 850nm", "3030 0.5W 850±10nm", sup=s1, cost=0.42, ss=2000, lead=15,
                      aql=0.65, wavelength_nm="850", msl_level="3", esd_sensitive=True, shelf_life_days=365, min_order_qty=1000)
    m["LED460"] = mat("LED-460-5050", "蓝光LED 460nm", "5050 1W 460±5nm", sup=s1, cost=0.55, ss=1000, lead=15,
                      aql=0.65, wavelength_nm="460", msl_level="3", esd_sensitive=True, shelf_life_days=365, min_order_qty=500)
    m["PCBAL"] = mat("PCB-AL-300", "LED铝基板 RL-300", "300×200mm 1.6mm 铝基", sup=s2, cost=18, lead=10)
    m["PCBBL"] = mat("PCB-AL-BL100", "LED铝基板 BL-100", "220×120mm 1.6mm 铝基", sup=s2, cost=14, lead=10)
    m["PCBCTRL"] = mat("PCB-CTRL-01", "主控板 PCBA", "MCU+触控+定时 V1.2", sup=s2, cost=26, ss=50, lead=12, esd_sensitive=True)
    m["ICDRV"] = mat("IC-DRV-CC", "恒流驱动IC", "SOP-8 350mA", sup=s2, cost=0.8, lead=20, esd_sensitive=True, msl_level="2")
    m["PSU"] = mat("PSU-24V-5A", "医用电源适配器 24V/5A", "IEC 60601-1 2xMOPP Class II", sup=s3, cost=45, ss=50, lead=20)
    m["FAN"] = mat("FAN-6015-24V", "散热风扇", "60×60×15mm 24V 静音", sup=s3, cost=6.5, lead=10)
    m["CBL"] = mat("CBL-PWR-1.5", "电源线", "1.5m 美规/欧规可选", sup=s3, cost=3.2, lead=10, iqc_required=False)
    m["HSGU"] = mat("HSG-RL300-U", "上壳 RL-300", "PC+ABS V0 白色", sup=s4, cost=12, lead=15, aql=1.0)
    m["HSGD"] = mat("HSG-RL300-D", "下壳 RL-300", "PC+ABS V0 白色", sup=s4, cost=10, lead=15, aql=1.0)
    m["HSGBL"] = mat("HSG-BL100", "灯箱外壳 BL-100", "铝合金+PC罩", sup=s4, cost=85, lead=20)
    m["STAND"] = mat("STAND-BL100", "移动支架 BL-100", "可升降 带脚轮", sup=s4, cost=160, lead=25)
    m["SCREW"] = mat("SCREW-M3X8", "螺丝 M3×8", "不锈钢 十字盘头", sup=s4, cost=0.02, lead=5, iqc_required=False, uom="PCS")
    m["LBL"] = mat("LBL-UDI-50X30", "UDI标签", "50×30mm 哑银 耐刮", cat="PACKAGING", sup=s5, cost=0.15, lead=7, iqc_required=False)
    m["BOXBL"] = mat("PKG-BL100-BOX", "包装箱 BL-100", "五层瓦楞 定制印刷", cat="PACKAGING", sup=s5, cost=18, lead=10)
    m["BOXRL"] = mat("PKG-RL300-BOX", "彩盒 RL-300（Lumina品牌）", "客供 品牌彩盒", cat="PACKAGING",
                     owner_customer_id=c1.id, aql=1.0)
    m["IFURL"] = mat("PKG-RL300-IFU", "说明书 RL-300（英文）", "客供 FDA 版 IFU", cat="PACKAGING", owner_customer_id=c1.id)

    m["SA_LB"] = mat("SA-RL300-LB", "LED灯板组件 RL-300", "60×660nm + 60×850nm", cat="SEMI", cost=95, lead=3,
                     iqc_required=False)
    m["RL300"] = mat("FG-RL300", "LED红光治疗仪 RL-300", "660nm+850nm 面板式 120颗LED", cat="FINISHED", cost=420,
                     lead=5, iqc_required=False, serial_control=True, customer_id=c1.id, model="RL-300",
                     registration_no="（示例）FDA 510(k) K26XXXX", device_class="II",
                     gtin=make_gtin14("697000000", "001"), sn_prefix="RL3")
    m["BL100"] = mat("FG-BL100", "新生儿蓝光治疗仪 BL-100", "460nm LED 蓝光 带支架", cat="FINISHED", cost=1650,
                     lead=7, iqc_required=False, serial_control=True, customer_id=c2.id, model="BL-100",
                     registration_no="（示例）沪械注准2026209XXXX", device_class="II",
                     gtin=make_gtin14("697000000", "002"), sn_prefix="BL1")
    db.flush()

    wcs = {code: _get_or_add(db, WorkCenter, code, name=name) for code, name in
           [("WC-SMT", "SMT贴片线"), ("WC-ASM", "总装线"), ("WC-TEST", "光学测试区"), ("WC-AGING", "老化房"),
            ("WC-SAFE", "安规测试区"), ("WC-PACK", "包装线")]}
    eq = {}
    eq["SPEC1"] = _get_or_add(db, Equipment, "EQ-SPEC-01", name="光谱辐照度计 #1", model="SPR-3000", equipment_type="TEST",
                              work_center_id=wcs["WC-TEST"].id, calibration_required=True, calibration_cycle_days=365,
                              last_calibration_date=t - timedelta(days=100), next_calibration_date=t + timedelta(days=265))
    eq["SPEC2"] = _get_or_add(db, Equipment, "EQ-SPEC-02", name="光谱辐照度计 #2（备用）", model="SPR-3000",
                              equipment_type="TEST", work_center_id=wcs["WC-TEST"].id, calibration_required=True,
                              calibration_cycle_days=365, last_calibration_date=t - timedelta(days=370),
                              next_calibration_date=t - timedelta(days=5))
    eq["HIPOT"] = _get_or_add(db, Equipment, "EQ-SAFE-01", name="医用安规综合测试仪", model="MS-6000",
                              equipment_type="TEST", work_center_id=wcs["WC-SAFE"].id, calibration_required=True,
                              calibration_cycle_days=365, last_calibration_date=t - timedelta(days=345),
                              next_calibration_date=t + timedelta(days=20))
    eq["AGING"] = _get_or_add(db, Equipment, "EQ-AGING-01", name="智能老化架 #1", model="AR-48", equipment_type="AGING",
                              work_center_id=wcs["WC-AGING"].id)
    _get_or_add(db, Equipment, "EQ-SMT-01", name="高速贴片机", model="SM-481", equipment_type="PRODUCTION",
                work_center_id=wcs["WC-SMT"].id)

    whs = {}
    for code, name, wtype, locs in [
        ("WH-RAW", "原材料仓", "RAW", [("RAW-A01", "原材料 A01", "STORAGE"), ("RAW-A02", "原材料 A02", "STORAGE"),
                                       ("DRY-01", "防潮柜 01（MSL物料）", "DRY_CABINET")]),
        ("WH-CS", "客供料仓", "CUSTOMER", [("CS-01", "客供料 01", "STORAGE")]),
        ("WH-WIP", "线边仓", "WIP", [("LINE-01", "总装线边", "STAGING")]),
        ("WH-FG", "成品仓", "FG", [("FG-01", "成品 01", "STORAGE"), ("FG-02", "成品 02", "STORAGE")]),
        ("WH-REJ", "不合格品仓", "REJECT", [("REJ-01", "不合格品区", "REJECT")]),
    ]:
        wh = _get_or_add(db, Warehouse, code, name=name, warehouse_type=wtype)
        whs[code] = wh
        for lc, ln, lt in locs:
            _get_or_add(db, Location, lc, name=ln, warehouse_id=wh.id, location_type=lt)
    db.flush()

    def bom(parent, version, lines):
        b = db.scalar(select(Bom).where(Bom.material_id == parent.id, Bom.version == version))
        if b:
            return b
        b = Bom(material_id=parent.id, version=version, status="RELEASED", released_by="系统初始化", ecn_no="ECN-INIT",
                effective_date=t, created_by="system")
        for n, (comp, qty, scrap, des) in enumerate(lines, start=1):
            b.lines.append(BomLine(line_no=n * 10, component_id=comp.id, qty_per=qty, scrap_rate=scrap, designator=des))
        db.add(b)
        return b

    bom(m["SA_LB"], "A0", [(m["PCBAL"], 1, 0, None), (m["LED660"], 60, 0.01, "D1-D60"),
                           (m["LED850"], 60, 0.01, "D61-D120"), (m["ICDRV"], 4, 0.01, "U1-U4")])
    bom(m["RL300"], "A1", [(m["SA_LB"], 1, 0, None), (m["PCBCTRL"], 1, 0, None), (m["PSU"], 1, 0, None),
                           (m["FAN"], 2, 0, None), (m["HSGU"], 1, 0, None), (m["HSGD"], 1, 0, None),
                           (m["SCREW"], 12, 0.02, None), (m["CBL"], 1, 0, None), (m["BOXRL"], 1, 0, None),
                           (m["IFURL"], 1, 0, None), (m["LBL"], 2, 0.02, None)])
    bom(m["BL100"], "A0", [(m["PCBBL"], 1, 0, None), (m["LED460"], 48, 0.01, "D1-D48"), (m["ICDRV"], 4, 0.01, None),
                           (m["PCBCTRL"], 1, 0, None), (m["PSU"], 1, 0, None), (m["FAN"], 1, 0, None),
                           (m["HSGBL"], 1, 0, None), (m["STAND"], 1, 0, None), (m["SCREW"], 16, 0.02, None),
                           (m["BOXBL"], 1, 0, None), (m["LBL"], 2, 0.02, None)])

    def routing(prod, version, ops):
        r = db.scalar(select(Routing).where(Routing.material_id == prod.id, Routing.version == version))
        if r:
            return r
        r = Routing(material_id=prod.id, version=version, name=f"{prod.model or prod.code} 标准工艺", status="RELEASED",
                    released_by="系统初始化", created_by="system")
        for seq, code, name, typ, wc, eqp, kp, sop, params in ops:
            op = RoutingOperation(seq=seq, code=code, name=name, op_type=typ, work_center_id=wcs[wc].id,
                                  requires_equipment=eqp, key_part_material_id=kp.id if kp else None, sop_no=sop,
                                  std_minutes=5)
            op.params = [RoutingParam(code=c, name=n, unit=u, lower=lo, upper=up, target=tg) for c, n, u, lo, up, tg in params]
            r.operations.append(op)
        db.add(r)
        return r

    routing(m["SA_LB"], "A0", [
        (10, "SMT", "SMT贴片+回流焊", "SMT", "WC-SMT", False, None, "SOP-SMT-001", []),
        (20, "AOI", "AOI光学检查", "INSPECTION", "WC-SMT", False, None, "SOP-SMT-002", []),
    ])
    routing(m["RL300"], "A1", [
        (10, "ASM", "整机组装", "ASSEMBLY", "WC-ASM", False, None, "SOP-RL300-010", []),
        (20, "OPT", "光学性能测试", "TEST_OPTICAL", "WC-TEST", True, None, "SOP-RL300-020", [
            ("WL_RED", "红光峰值波长", "nm", 650, 670, 660), ("WL_NIR", "近红外峰值波长", "nm", 840, 860, 850),
            ("IRR", "辐照度（距面板15cm）", "mW/cm²", 40, 60, 50)]),
        (30, "AGE", "老化测试", "AGING", "WC-AGING", True, None, "SOP-RL300-030", [
            ("AGE_H", "老化时长", "h", 4, None, 4), ("IRR_DROP", "老化后辐照度衰减", "%", None, 5, 0)]),
        (40, "SAFE", "安规测试", "TEST_SAFETY", "WC-SAFE", True, None, "SOP-RL300-040", [
            ("HIPOT", "耐压测试漏电流（1500VAC/60s）", "mA", None, 5, None),
            ("EARTH_LK", "对地漏电流", "μA", None, 500, None), ("PAT_LK", "患者漏电流", "μA", None, 100, None)]),
        (50, "FQC", "终检（外观/功能/标签）", "INSPECTION", "WC-PACK", False, None, "SOP-RL300-050", []),
        (60, "PACK", "包装（绑定电源适配器批次）", "PACKING", "WC-PACK", False, m["PSU"], "SOP-RL300-060", []),
    ])
    routing(m["BL100"], "A0", [
        (10, "ASM", "整机组装", "ASSEMBLY", "WC-ASM", False, None, "SOP-BL100-010", []),
        (20, "OPT", "光学性能测试", "TEST_OPTICAL", "WC-TEST", True, None, "SOP-BL100-020", [
            ("WL_PEAK", "峰值波长", "nm", 455, 470, 460),
            ("IRR_BILI", "胆红素有效辐照度", "μW/(cm²·nm)", 30, 55, 40),
            ("UNIFORM", "辐照均匀度（最小/最大）", "%", 40, None, 60)]),
        (30, "AGE", "老化测试", "AGING", "WC-AGING", True, None, "SOP-BL100-030", [("AGE_H", "老化时长", "h", 8, None, 8)]),
        (40, "SAFE", "安规测试", "TEST_SAFETY", "WC-SAFE", True, None, "SOP-BL100-040", [
            ("HIPOT", "耐压测试漏电流（1500VAC/60s）", "mA", None, 5, None),
            ("EARTH_LK", "对地漏电流", "μA", None, 500, None)]),
        (50, "FQC", "终检", "INSPECTION", "WC-PACK", False, None, "SOP-BL100-050", []),
        (60, "PACK", "包装", "PACKING", "WC-PACK", False, None, "SOP-BL100-060", []),
    ])
    db.flush()

    # 期初库存
    admin = db.scalar(select(User).where(User.username == "admin"))
    from .models import Stock
    if not db.scalar(select(Stock).limit(1)):
        from .services.wms import receive
        loc = {l.code: l.id for l in db.scalars(select(Location))}
        open_lines = [
            (m["LED660"], "DRY-01", 3000, "JG2609-660A", t - timedelta(days=60)),
            (m["LED850"], "DRY-01", 3000, "JG2609-850A", t - timedelta(days=60)),
            (m["LED460"], "DRY-01", 1500, "JG2608-460B", t - timedelta(days=90)),
            (m["PCBAL"], "RAW-A01", 40, "XD260915", None), (m["PCBBL"], "RAW-A01", 20, "XD260918", None),
            (m["PCBCTRL"], "RAW-A01", 60, "XD260920", None), (m["ICDRV"], "RAW-A01", 400, "XD260830", None),
            (m["PSU"], "RAW-A02", 35, "HY2609A", None), (m["FAN"], "RAW-A02", 80, "HY2609F", None),
            (m["CBL"], "RAW-A02", 100, "HY2609C", None), (m["HSGU"], "RAW-A02", 50, "JS2609U", None),
            (m["HSGD"], "RAW-A02", 50, "JS2609D", None), (m["HSGBL"], "RAW-A02", 12, "JS2609BL", None),
            (m["STAND"], "RAW-A02", 12, "JS2609ST", None), (m["SCREW"], "RAW-A02", 3000, "JS2609S", None),
            (m["LBL"], "RAW-A02", 500, "JY2609L", None), (m["BOXBL"], "RAW-A02", 15, "JY2609B", None),
            (m["BOXRL"], "CS-01", 40, "LUM-BOX-2609", None), (m["IFURL"], "CS-01", 40, "LUM-IFU-2609", None),
            (m["SA_LB"], "LINE-01", 30, "SA260920", None),
        ]
        receive(db, admin, receipt_type="OPENING", remark="期初库存（系统上线）", lines=[
            {"material_id": mm.id, "location_id": loc[lc], "qty": q, "lot_no": lot, "mfg_date": mfg,
             "expiry_date": (mfg + timedelta(days=mm.shelf_life_days)) if (mfg and mm.shelf_life_days) else None}
            for mm, lc, q, lot, mfg in open_lines])

    # 销售订单
    if not db.scalar(select(SalesOrder).limit(1)):
        from .services.numbering import next_no
        for cust, prod, qty, price, days, status, po in [
            (c1, m["RL300"], 20, 88.0, 20, "CONFIRMED", "LUM-PO-26-118"),
            (c2, m["BL100"], 10, 4200.0, 25, "CONFIRMED", "GY-2026-0931"),
            (c1, m["RL300"], 200, 86.0, 45, "DRAFT", "LUM-PO-26-131"),
        ]:
            so = SalesOrder(no=next_no(db, "SO"), customer_id=cust.id, order_date=t, delivery_date=t + timedelta(days=days),
                            customer_po=po, status=status, currency=cust.currency, created_by="sales")
            so.lines.append(SalesOrderLine(line_no=1, material_id=prod.id, qty=qty, unit_price=price,
                                           amount=qty * price, delivery_date=t + timedelta(days=days)))
            so.total_amount = qty * price
            db.add(so)
    db.commit()
    return {"materials": m, "equipment": eq, "customers": (c1, c2, c3), "admin": admin}


def seed_demo(db, ctx: dict) -> None:
    """跑一遍真实业务流：SO → 工单 → 领料 → 逐台过站（含一次光学不合格返工、一次安规不合格报废）→ 完工入库 →
    DHR 放行 → 发货；再生成一张在制工单和一张待检来料。"""
    from .models import PurchaseOrder, PurchaseOrderLine, WorkOrder
    from .services import production as prod
    from .services import quality as qsvc
    from .services import wms as wsvc
    from .services.numbering import next_no

    if db.scalar(select(WorkOrder).limit(1)):
        print("已存在生产数据，跳过演示流程")
        return
    rnd = random.Random(2026)
    u = {x.username: x for x in db.scalars(select(User))}
    m, eq = ctx["materials"], ctx["equipment"]
    sig = lambda name: SignatureIn(password=DEMO_PASSWORD, reason="演示数据")  # noqa: E731
    so = db.scalar(select(SalesOrder).where(SalesOrder.customer_po == "LUM-PO-26-118"))
    loc = {l.code: l.id for l in db.scalars(select(Location))}

    def values_for(op, fail_code=None):
        vals = {}
        for p in op.params:
            lo, up, tg = p.get("lower"), p.get("upper"), p.get("target")
            if lo is not None and up is not None:
                v = rnd.uniform(lo + (up - lo) * 0.25, up - (up - lo) * 0.25)
            elif lo is not None:
                v = (tg or lo) + rnd.uniform(0, 0.5)
            else:
                v = up * rnd.uniform(0.1, 0.5)
            if p["code"] == fail_code:
                v = (up or 0) * 1.08 if up is not None else (lo or 0) * 0.9
            vals[p["code"]] = round(v, 2)
        return vals

    eq_for = {"TEST_OPTICAL": eq["SPEC1"].id, "AGING": eq["AGING"].id, "TEST_SAFETY": eq["HIPOT"].id}

    def run_sn(wo, sn, operator, fail_at=None, fail_code=None, stop_after=None):
        while True:
            s = prod.get_sn(db, sn)
            if s.status in ("COMPLETED", "SCRAPPED", "NG"):
                return s.status
            op = prod.next_operation(wo, s)
            if op is None or (stop_after and op.seq > stop_after):
                return s.status
            kp = [{"lot_no": "HY2609A"}] if op.key_part_material_id else []
            fc = fail_code if (fail_at == op.seq and s.ng_seq is None) else None
            prod.report_serial(db, operator, sn_text=sn, seq=op.seq, values=values_for(op, fc),
                               equipment_id=eq_for.get(op.op_type), key_parts=kp)

    # 工单 1：RL-300 × 10，完整走完
    wo = WorkOrder(no=next_no(db, "WO"), material_id=m["RL300"].id, customer_id=so.customer_id, so_id=so.id,
                   so_line_id=so.lines[0].id, planned_qty=10, planned_start=today(), status="PLANNED",
                   source=so.no, created_by="pmc")
    db.add(wo)
    db.flush()
    so.status = "IN_PRODUCTION"
    prod.release_work_order(db, wo, u["pmc"])
    issue, _ = wsvc.create_issue(db, u["wh"], wo)
    wsvc.confirm_issue(db, u["wh"], issue)
    sns = [s.sn for s in db.scalars(select(prod.SerialNumber).where(prod.SerialNumber.wo_id == wo.id).order_by(prod.SerialNumber.sn))]
    for i, sn in enumerate(sns):
        operator = u["op1"] if i % 2 == 0 else u["op2"]
        if i == 3:  # 光学测试辐照度超上限 → NCR → 返工后通过
            run_sn(wo, sn, operator, fail_at=20, fail_code="IRR")
            ncr = db.scalar(select(prod.Ncr).where(prod.Ncr.sn == sn, prod.Ncr.status == "OPEN"))
            qsvc.disposition_ncr(db, u["qa"], ncr, "REWORK", "更换驱动IC后重新测试", sig("qa"))
            run_sn(wo, sn, operator)
        elif i == 7:  # 安规测试患者漏电流超标 → 报废
            run_sn(wo, sn, operator, fail_at=40, fail_code="PAT_LK")
            ncr = db.scalar(select(prod.Ncr).where(prod.Ncr.sn == sn, prod.Ncr.status == "OPEN"))
            qsvc.disposition_ncr(db, u["qa"], ncr, "SCRAP", "绝缘结构缺陷，报废并隔离", sig("qa"))
        else:
            run_sn(wo, sn, operator)
    prod.fg_receipt(db, u["wh"], wo, loc["FG-01"])
    prod.release_dhr(db, u["qa"], wo, True, sig("qa"), "DHR 记录完整，批准放行")
    sh = wsvc.create_shipment(db, u["sales"], so, [{"so_line_id": so.lines[0].id, "qty": 9}], carrier="DHL",
                              tracking_no="DHL6620260001")
    wsvc.confirm_shipment(db, u["wh"], sh)

    # 工单 2：RL-300 × 11，部分在制
    wo2 = WorkOrder(no=next_no(db, "WO"), material_id=m["RL300"].id, customer_id=so.customer_id, so_id=so.id,
                    so_line_id=so.lines[0].id, planned_qty=11, planned_start=today(), status="PLANNED",
                    source=so.no, created_by="pmc")
    db.add(wo2)
    db.flush()
    prod.release_work_order(db, wo2, u["pmc"])
    issue2, _ = wsvc.create_issue(db, u["wh"], wo2)
    wsvc.confirm_issue(db, u["wh"], issue2)
    sns2 = [s.sn for s in db.scalars(select(prod.SerialNumber).where(prod.SerialNumber.wo_id == wo2.id).order_by(prod.SerialNumber.sn))]
    stops = [60, 60, 40, 40, 30, 30, 20, 20, 10, None, None]
    for sn, stop in zip(sns2, stops):
        if stop:
            run_sn(wo2, sn, u["op1"], stop_after=stop)
    run_sn(wo2, sns2[8], u["op2"], fail_at=20, fail_code="WL_RED", stop_after=20)  # 留一条待处置 NCR

    # 采购：LED 补货，已到货待 IQC
    po = PurchaseOrder(no=next_no(db, "PO"), supplier_id=m["LED660"].default_supplier_id, order_date=today(),
                       expected_date=today() + timedelta(days=7), status="APPROVED", approved_by="陈采购",
                       created_by="buyer")
    po.lines.append(PurchaseOrderLine(line_no=1, material_id=m["LED660"].id, qty=5000, unit_price=0.35, amount=1750))
    po.lines.append(PurchaseOrderLine(line_no=2, material_id=m["LED850"].id, qty=5000, unit_price=0.42, amount=2100))
    po.total_amount = 3850
    db.add(po)
    db.flush()
    wsvc.receive(db, u["wh"], receipt_type="PURCHASE", po=po, supplier_id=po.supplier_id, delivery_note="JG-DN-88123",
                 lines=[{"po_line_id": po.lines[0].id, "material_id": m["LED660"].id, "qty": 5000, "location_id": loc["DRY-01"],
                         "lot_no": "JG2610-660C", "supplier_lot": "W2610-03", "mfg_date": today() - timedelta(days=10)}])
    db.commit()
    print("演示业务流程已生成")


def main(argv: list[str]) -> None:
    if "--reset" in argv:
        Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    from sqlalchemy.orm import Session

    from . import audit
    audit.install(Session)
    with SessionLocal() as db:
        ctx = seed_base(db)
        print(f"基础数据已初始化。演示账号：admin / {DEMO_PASSWORD}（其他账号见 README）")
        if "--demo" in argv:
            seed_demo(db, ctx)


if __name__ == "__main__":
    main(sys.argv[1:])
