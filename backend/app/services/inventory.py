"""库存核心服务：所有库存变动必须经过这里，确保余额与流水一致。"""
from dataclasses import dataclass
from datetime import date

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import now
from ..errors import BizError
from ..models import Location, Material, Stock, StockMove

EPS = 1e-9
STATUS_TEXT = {"QUARANTINE": "待检/待放行", "AVAILABLE": "合格", "REJECTED": "不合格", "HOLD": "冻结"}


@dataclass
class Ref:
    ref_type: str | None = None
    ref_id: int | None = None
    ref_no: str | None = None
    username: str | None = None
    remark: str | None = None


def _find(db: Session, material_id: int, location_id: int, lot_no: str, status: str,
          owner_customer_id: int | None, lock: bool = True) -> Stock | None:
    q = select(Stock).where(
        Stock.material_id == material_id, Stock.location_id == location_id, Stock.lot_no == (lot_no or ""),
        Stock.status == status,
        Stock.owner_customer_id.is_(None) if owner_customer_id is None else Stock.owner_customer_id == owner_customer_id,
    )
    if lock:
        q = q.with_for_update(of=Stock)
    return db.scalars(q).first()


def _log(db: Session, move_type: str, material_id: int, lot_no: str, qty: float, ref: Ref, *,
         from_location_id=None, to_location_id=None, from_status=None, to_status=None, owner_customer_id=None):
    db.add(StockMove(
        ts=now(), move_type=move_type, material_id=material_id, lot_no=lot_no or "", qty=qty,
        from_location_id=from_location_id, to_location_id=to_location_id, from_status=from_status,
        to_status=to_status, owner_customer_id=owner_customer_id, ref_type=ref.ref_type, ref_id=ref.ref_id,
        ref_no=ref.ref_no, username=ref.username, remark=ref.remark,
    ))


def _check_qty(qty: float):
    if qty is None or qty <= 0:
        raise BizError("数量必须大于 0")


def add_stock(db: Session, *, material_id: int, location_id: int, lot_no: str, status: str, qty: float,
              move_type: str, ref: Ref, owner_customer_id: int | None = None, mfg_date: date | None = None,
              expiry_date: date | None = None, supplier_id: int | None = None, supplier_lot: str | None = None,
              log: bool = True) -> Stock:
    _check_qty(qty)
    loc = db.get(Location, location_id)
    if not loc or not loc.is_active:
        raise BizError("库位不存在或已停用")
    st = _find(db, material_id, location_id, lot_no, status, owner_customer_id)
    if st is None:
        st = Stock(material_id=material_id, location_id=location_id, lot_no=lot_no or "", status=status,
                   owner_customer_id=owner_customer_id, qty=0, mfg_date=mfg_date, expiry_date=expiry_date,
                   supplier_id=supplier_id, supplier_lot=supplier_lot, received_at=now())
        db.add(st)
    st.qty = round((st.qty or 0) + qty, 4)
    if expiry_date and not st.expiry_date:
        st.expiry_date = expiry_date
    if log:
        _log(db, move_type, material_id, lot_no, qty, ref, to_location_id=location_id, to_status=status,
             owner_customer_id=owner_customer_id)
    db.flush()
    return st


def remove_stock(db: Session, *, material_id: int, location_id: int, lot_no: str, status: str, qty: float,
                 move_type: str, ref: Ref, owner_customer_id: int | None = None, log: bool = True) -> Stock:
    _check_qty(qty)
    st = _find(db, material_id, location_id, lot_no, status, owner_customer_id)
    have = st.qty if st else 0
    if have + EPS < qty:
        m = db.get(Material, material_id)
        loc = db.get(Location, location_id)
        raise BizError(
            f"库存不足：{m.code if m else material_id} 批次[{lot_no or '-'}] 库位[{loc.code if loc else location_id}] "
            f"{STATUS_TEXT.get(status, status)}库存 {have:g}，需要 {qty:g}"
        )
    st.qty = round(st.qty - qty, 4)
    if log:
        _log(db, move_type, material_id, lot_no, qty, ref, from_location_id=location_id, from_status=status,
             owner_customer_id=owner_customer_id)
    if st.qty <= EPS:
        db.delete(st)
    db.flush()
    return st


def move_stock(db: Session, *, material_id: int, lot_no: str, qty: float, from_location_id: int,
               to_location_id: int, from_status: str, to_status: str, move_type: str, ref: Ref,
               owner_customer_id: int | None = None) -> Stock:
    """库位间移动 和/或 质量状态变更（如 待检→合格），保留批次属性。"""
    src = _find(db, material_id, from_location_id, lot_no, from_status, owner_customer_id)
    attrs = dict(mfg_date=src.mfg_date, expiry_date=src.expiry_date, supplier_id=src.supplier_id,
                 supplier_lot=src.supplier_lot) if src else {}
    remove_stock(db, material_id=material_id, location_id=from_location_id, lot_no=lot_no, status=from_status,
                 qty=qty, move_type=move_type, ref=ref, owner_customer_id=owner_customer_id, log=False)
    dst = add_stock(db, material_id=material_id, location_id=to_location_id, lot_no=lot_no, status=to_status,
                    qty=qty, move_type=move_type, ref=ref, owner_customer_id=owner_customer_id, log=False, **attrs)
    _log(db, move_type, material_id, lot_no, qty, ref, from_location_id=from_location_id,
         to_location_id=to_location_id, from_status=from_status, to_status=to_status,
         owner_customer_id=owner_customer_id)
    db.flush()
    return dst


def change_lot_status(db: Session, *, material_id: int, lot_no: str, from_status: str, to_status: str,
                      move_type: str, ref: Ref, owner_customer_id: int | None = None,
                      location_id: int | None = None) -> float:
    """把某批次在所有(或指定)库位上的某状态库存整体转为另一状态，返回转换数量。"""
    q = select(Stock).where(Stock.material_id == material_id, Stock.lot_no == (lot_no or ""),
                            Stock.status == from_status)
    q = q.where(Stock.owner_customer_id.is_(None) if owner_customer_id is None
                else Stock.owner_customer_id == owner_customer_id)
    if location_id:
        q = q.where(Stock.location_id == location_id)
    total = 0.0
    for st in list(db.scalars(q)):
        qty = st.qty
        if qty <= EPS:
            continue
        move_stock(db, material_id=material_id, lot_no=lot_no, qty=qty, from_location_id=st.location_id,
                   to_location_id=st.location_id, from_status=from_status, to_status=to_status,
                   move_type=move_type, ref=ref, owner_customer_id=owner_customer_id)
        total += qty
    return round(total, 4)


def available_lots(db: Session, material_id: int, owner_customer_id: int | None = None,
                   allow_own: bool = True) -> list[Stock]:
    """可用（合格）库存，按 FEFO（先到期先出）→ FIFO（先入先出）排序。"""
    q = select(Stock).where(Stock.material_id == material_id, Stock.status == "AVAILABLE", Stock.qty > EPS)
    stocks = list(db.scalars(q))

    def allowed(s: Stock) -> bool:
        if s.owner_customer_id is None:
            return allow_own
        return s.owner_customer_id == owner_customer_id

    stocks = [s for s in stocks if allowed(s) and s.location.location_type not in ("REJECT",)]
    today = now().date()
    stocks = [s for s in stocks if not s.expiry_date or s.expiry_date >= today]  # 过期物料不可用
    stocks.sort(key=lambda s: (s.expiry_date or date(9999, 12, 31), s.received_at or now(), s.id))
    return stocks


def allocate(db: Session, material_id: int, qty: float, owner_customer_id: int | None = None) -> tuple[list[tuple[Stock, float]], float]:
    """按 FEFO 分配，返回 [(库存行, 分配数量)] 与 未满足数量。
    客供料：只能分配该客户的货主库存；自购料：只能分配公司自有库存。"""
    m = db.get(Material, material_id)
    if m and m.owner_customer_id:
        lots = available_lots(db, material_id, owner_customer_id=m.owner_customer_id, allow_own=False)
    else:
        lots = available_lots(db, material_id, owner_customer_id=None, allow_own=True)
    result, remain = [], qty
    for s in lots:
        if remain <= EPS:
            break
        take = min(s.qty, remain)
        result.append((s, round(take, 4)))
        remain = round(remain - take, 4)
    return result, max(remain, 0)


def on_hand(db: Session, material_id: int, statuses=("AVAILABLE", "QUARANTINE")) -> float:
    total = 0.0
    for s in db.scalars(select(Stock).where(Stock.material_id == material_id, Stock.status.in_(statuses))):
        total += s.qty or 0
    return round(total, 4)
