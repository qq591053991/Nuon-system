"""数据导入（金蝶等旧系统迁移）：支持 Excel(.xlsx)/CSV，表头兼容金蝶 K/3 Cloud / 星空 常见导出列名。"""
import csv
import io
from collections import defaultdict
from datetime import date, datetime

from fastapi import APIRouter, Depends, File, UploadFile
from fastapi.responses import StreamingResponse
from openpyxl import Workbook, load_workbook
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..errors import BizError
from ..models import Bom, BomLine, Customer, Location, Material, Supplier, User
from ..security import require
from ..services import wms as wms_svc

router = APIRouter(prefix="/api/import", tags=["数据导入"])

YES = {"是", "Y", "y", "yes", "true", "1", "TRUE", "启用", "√"}
CATEGORY = {"原材料": "RAW", "原料": "RAW", "外购": "RAW", "半成品": "SEMI", "委外": "SEMI", "成品": "FINISHED",
            "产成品": "FINISHED", "自制": "FINISHED", "包材": "PACKAGING", "包装材料": "PACKAGING", "辅料": "CONSUMABLE",
            "耗材": "CONSUMABLE", "RAW": "RAW", "SEMI": "SEMI", "FINISHED": "FINISHED", "PACKAGING": "PACKAGING",
            "CONSUMABLE": "CONSUMABLE"}
SUP_STATUS = {"合格": "QUALIFIED", "合格供方": "QUALIFIED", "待评": "PENDING", "暂停": "SUSPENDED", "取消": "DISQUALIFIED",
              "QUALIFIED": "QUALIFIED", "PENDING": "PENDING"}

SPECS: dict[str, dict] = {
    "materials": {
        "title": "物料",
        "fields": {
            "code": ["物料编码", "编码", "代码", "FNumber"], "name": ["物料名称", "名称", "FName"],
            "spec": ["规格型号", "规格"], "category": ["物料类别", "物料属性", "类别"],
            "uom": ["基本单位", "单位", "计量单位"], "safety_stock": ["安全库存"],
            "lead_time_days": ["采购提前期", "固定提前期", "提前期"], "std_cost": ["标准成本", "参考成本", "单价"],
            "shelf_life_days": ["保质期(天)", "保质期"], "lot_control": ["启用批号管理", "批号管理"],
            "serial_control": ["启用序列号管理", "序列号管理"], "default_supplier": ["默认供应商"],
            "iqc_required": ["来料检验", "需检验"], "wavelength_nm": ["波长(nm)", "波长"], "msl_level": ["湿敏等级", "MSL"],
            "remark": ["备注"],
        },
        "example": ["LED-660-3030", "红光LED 660nm", "3030 0.5W 660±5nm", "原材料", "PCS", 2000, 15, 0.35, 365, "是", "否",
                    "SUP001", "是", "660", "3", ""],
    },
    "customers": {
        "title": "客户",
        "fields": {"code": ["客户编码", "编码", "FNumber"], "name": ["客户名称", "名称", "FName"], "short_name": ["简称"],
                   "country": ["国家", "国家/地区"], "contact": ["联系人"], "phone": ["电话", "联系电话"],
                   "address": ["地址", "通讯地址"], "tax_no": ["税号", "纳税登记号"], "currency": ["币别", "结算币别"],
                   "mah_name": ["注册人", "注册人名称"], "remark": ["备注"]},
        "example": ["C100", "示例品牌医疗科技有限公司", "示例品牌", "中国", "张经理", "13800000000", "上海市", "91310000XXXX",
                    "CNY", "示例品牌医疗科技有限公司", ""],
    },
    "suppliers": {
        "title": "供应商",
        "fields": {"code": ["供应商编码", "编码", "FNumber"], "name": ["供应商名称", "名称", "FName"], "short_name": ["简称"],
                   "category": ["供应类别", "类别"], "contact": ["联系人"], "phone": ["电话", "联系电话"],
                   "address": ["地址", "通讯地址"], "status": ["状态", "合格状态"], "remark": ["备注"]},
        "example": ["S100", "示例电子有限公司", "示例电子", "LED芯片", "李工", "13900000000", "深圳市", "合格", ""],
    },
    "boms": {
        "title": "BOM",
        "fields": {"parent": ["父项物料编码", "父项编码", "产品编码"], "version": ["BOM版本", "版本"],
                   "component": ["子项物料编码", "子项编码", "组件编码"], "qty": ["用量", "子项用量", "用量:分子", "分子"],
                   "denominator": ["用量:分母", "分母"], "scrap_rate": ["损耗率", "损耗率(%)"], "designator": ["位号"]},
        "example": ["FG-RL300", "A0", "LED-660-3030", 60, 1, 1, "D1-D60"],
    },
    "stock": {
        "title": "期初库存",
        "fields": {"material": ["物料编码", "编码"], "location": ["库位编码", "仓位", "库位"], "lot_no": ["批号"],
                   "qty": ["数量", "库存数量", "期初数量"], "mfg_date": ["生产日期"], "expiry_date": ["有效期至", "到期日"]},
        "example": ["LED-660-3030", "RAW-A01", "L20260901", 5000, "2026-09-01", "2027-09-01"],
    },
}


def _rows(file: UploadFile) -> list[dict]:
    raw = file.file.read()
    name = (file.filename or "").lower()
    if name.endswith(".csv"):
        text = raw.decode("utf-8-sig", errors="ignore")
        if "�" in text or not text.strip():
            text = raw.decode("gbk", errors="ignore")
        return list(csv.DictReader(io.StringIO(text)))
    wb = load_workbook(io.BytesIO(raw), read_only=True, data_only=True)
    ws = wb.active
    it = ws.iter_rows(values_only=True)
    header = None
    for row in it:  # 跳过金蝶导出顶部的标题行，取第一行非空表头
        if row and sum(1 for c in row if c not in (None, "")) >= 2:
            header = [str(c).strip() if c is not None else "" for c in row]
            break
    if not header:
        return []
    out = []
    for row in it:
        if not row or all(c in (None, "") for c in row):
            continue
        out.append({header[i]: row[i] for i in range(min(len(header), len(row)))})
    return out


def _get(row: dict, aliases: list[str]):
    for a in aliases:
        if a in row and row[a] not in (None, ""):
            v = row[a]
            return v.strip() if isinstance(v, str) else v
    return None


def _num(v, default=None):
    if v in (None, ""):
        return default
    try:
        return float(str(v).replace(",", "").replace("%", ""))
    except ValueError:
        raise ValueError(f"数值格式错误：{v}")


def _date(v):
    if v in (None, ""):
        return None
    if isinstance(v, datetime):
        return v.date()
    if isinstance(v, date):
        return v
    return date.fromisoformat(str(v).strip()[:10].replace("/", "-"))


@router.get("/templates/{entity}", summary="下载导入模板")
def template(entity: str):
    spec = SPECS.get(entity)
    if not spec:
        raise BizError("不支持的导入类型")
    wb = Workbook()
    ws = wb.active
    ws.title = spec["title"]
    ws.append([v[0] for v in spec["fields"].values()])
    ws.append(spec["example"])
    for col in ws.columns:
        ws.column_dimensions[col[0].column_letter].width = 16
    buf = io.BytesIO()
    wb.save(buf)
    buf.seek(0)
    return StreamingResponse(buf, media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
                             headers={"Content-Disposition": f"attachment; filename={entity}_template.xlsx"})


@router.post("/{entity}", summary="上传导入（按编码新增或更新）")
def do_import(entity: str, file: UploadFile = File(...), db: Session = Depends(get_db),
              user: User = Depends(require("master", "engineering", "wms"))):
    spec = SPECS.get(entity)
    if not spec:
        raise BizError("不支持的导入类型")
    rows = _rows(file)
    if not rows:
        raise BizError("文件为空或无法识别表头")
    f = spec["fields"]
    created = updated = 0
    errors: list[dict] = []

    if entity in ("materials", "customers", "suppliers"):
        model = {"materials": Material, "customers": Customer, "suppliers": Supplier}[entity]
        for i, row in enumerate(rows, start=2):
            sp = db.begin_nested()  # 每行一个保存点，单行出错不影响其他行的错误收集
            try:
                code = _get(row, f["code"])
                name = _get(row, f["name"])
                if not code or not name:
                    raise ValueError("编码和名称不能为空")
                code = str(code)
                data = {}
                for key, aliases in f.items():
                    if key in ("code", "default_supplier"):
                        continue
                    v = _get(row, aliases)
                    if v is None:
                        continue
                    if key == "category":
                        if str(v) not in CATEGORY:
                            raise ValueError(f"无法识别的物料类别：{v}")
                        v = CATEGORY[str(v)]
                    elif key == "status":
                        v = SUP_STATUS.get(str(v), "PENDING")
                    elif key in ("lot_control", "serial_control", "iqc_required"):
                        v = str(v) in YES
                    elif key in ("safety_stock", "std_cost"):
                        v = _num(v, 0)
                    elif key in ("lead_time_days", "shelf_life_days"):
                        v = int(_num(v, 0))
                    else:
                        v = str(v)
                    data[key] = v
                if entity == "materials":
                    sup = _get(row, f["default_supplier"])
                    if sup:
                        s = db.scalar(select(Supplier).where((Supplier.code == str(sup)) | (Supplier.name == str(sup))))
                        if not s:
                            raise ValueError(f"默认供应商 {sup} 不存在，请先导入供应商")
                        data["default_supplier_id"] = s.id
                obj = db.scalar(select(model).where(model.code == code))
                if obj:
                    for k, v in data.items():
                        setattr(obj, k, v)
                    updated += 1
                else:
                    db.add(model(code=code, created_by=user.username, **data))
                    created += 1
                db.flush()
                sp.commit()
            except Exception as e:  # noqa: BLE001 - 汇总每一行的错误返回给用户
                sp.rollback()
                errors.append({"row": i, "message": str(getattr(e, "orig", e))})
    elif entity == "boms":
        groups: dict[tuple, list] = defaultdict(list)
        for i, row in enumerate(rows, start=2):
            groups[(str(_get(row, f["parent"]) or ""), str(_get(row, f["version"]) or "A0"))].append((i, row))
        for (parent, ver), items in groups.items():
            try:
                pm = db.scalar(select(Material).where(Material.code == parent))
                if not pm:
                    raise ValueError(f"父项物料 {parent} 不存在")
                if db.scalar(select(Bom).where(Bom.material_id == pm.id, Bom.version == ver)):
                    raise ValueError(f"{parent} 版本 {ver} 的 BOM 已存在（为保证受控，导入不覆盖已有 BOM）")
                b = Bom(material_id=pm.id, version=ver, status="DRAFT", remark="数据导入", created_by=user.username)
                for n, (i, row) in enumerate(items, start=1):
                    cc = str(_get(row, f["component"]) or "")
                    cm = db.scalar(select(Material).where(Material.code == cc))
                    if not cm:
                        raise ValueError(f"第 {i} 行子项物料 {cc} 不存在")
                    qty = _num(_get(row, f["qty"]), 0) / (_num(_get(row, f["denominator"]), 1) or 1)
                    sr = _num(_get(row, f["scrap_rate"]), 0)
                    b.lines.append(BomLine(line_no=n * 10, component_id=cm.id, qty_per=qty,
                                           scrap_rate=sr / 100 if sr and sr >= 1 else sr,
                                           designator=_get(row, f["designator"])))
                db.add(b)
                db.flush()
                created += 1
            except Exception as e:  # noqa: BLE001
                errors.append({"row": items[0][0], "message": str(e)})
    elif entity == "stock":
        lines = []
        for i, row in enumerate(rows, start=2):
            try:
                mc = str(_get(row, f["material"]) or "")
                m = db.scalar(select(Material).where(Material.code == mc))
                if not m:
                    raise ValueError(f"物料 {mc} 不存在")
                lc = str(_get(row, f["location"]) or "")
                loc = db.scalar(select(Location).where(Location.code == lc))
                if not loc:
                    raise ValueError(f"库位 {lc} 不存在")
                qty = _num(_get(row, f["qty"]), 0)
                if qty <= 0:
                    raise ValueError("数量必须大于 0")
                lines.append({"material_id": m.id, "location_id": loc.id, "qty": qty,
                              "lot_no": str(_get(row, f["lot_no"]) or "") or None,
                              "mfg_date": _date(_get(row, f["mfg_date"])),
                              "expiry_date": _date(_get(row, f["expiry_date"]))})
            except Exception as e:  # noqa: BLE001
                errors.append({"row": i, "message": str(e)})
        if lines and not errors:
            # 客供料期初需按货主分别入账
            wms_svc.receive(db, user, receipt_type="OPENING", lines=lines, remark="期初库存导入")
            created = len(lines)
    if errors:
        db.rollback()
        return {"ok": False, "created": 0, "updated": 0, "errors": errors,
                "message": f"发现 {len(errors)} 行错误，已全部回滚，请修正后重新导入"}
    db.commit()
    return {"ok": True, "created": created, "updated": updated, "errors": []}
