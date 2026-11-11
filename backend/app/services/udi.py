"""UDI（GS1）工具：GTIN 校验位、UDI-PI 组合（生产日期/失效日期/批号/序列号）。"""
from datetime import date


def gtin_check_digit(body: str) -> int:
    """计算 GTIN 校验位。body 为不含校验位的数字串（GTIN-14 时为 13 位）。"""
    if not body.isdigit():
        raise ValueError("GTIN 只能包含数字")
    total = 0
    for i, ch in enumerate(reversed(body)):
        total += int(ch) * (3 if i % 2 == 0 else 1)
    return (10 - total % 10) % 10


def is_valid_gtin(gtin: str) -> bool:
    if not gtin or not gtin.isdigit() or len(gtin) not in (8, 12, 13, 14):
        return False
    return gtin_check_digit(gtin[:-1]) == int(gtin[-1])


def make_gtin14(company_prefix: str, item_ref: str, indicator: str = "0") -> str:
    body = (indicator + company_prefix + item_ref)[:13].ljust(13, "0")
    return body + str(gtin_check_digit(body))


def build_udi(gtin: str | None, *, mfg_date: date | None = None, expiry_date: date | None = None,
              lot: str | None = None, serial: str | None = None) -> str | None:
    """返回 GS1 人工可读格式（HRI），如 (01)06970000000012(11)261111(10)B261111001(21)RL3002611110001"""
    if not gtin:
        return None
    parts = [f"(01){gtin.zfill(14)}"]
    if mfg_date:
        parts.append(f"(11){mfg_date.strftime('%y%m%d')}")
    if expiry_date:
        parts.append(f"(17){expiry_date.strftime('%y%m%d')}")
    if lot:
        parts.append(f"(10){lot}")
    if serial:
        parts.append(f"(21){serial}")
    return "".join(parts)
