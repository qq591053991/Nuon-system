"""GB/T 2828.1-2012 (ISO 2859-1) 正常检验一次抽样方案，一般检验水平 II。

主表规律：对每个 AQL 列，Ac=0/Re=1 位于某一字码行 r0；其下一行为“↑”、再下一行为“↓”，
之后依次为 1/2、2/3、3/4、5/6、7/8、10/11、14/15、21/22；r0 以上为“↓”，21/22 以下为“↑”。
箭头指向的方案连同其样本量一起采用；若样本量 ≥ 批量则全检。
"""

LOT_RANGES = [  # (上限, 字码) 一般检验水平 II
    (8, "A"), (15, "B"), (25, "C"), (50, "D"), (90, "E"), (150, "F"), (280, "G"), (500, "H"),
    (1200, "J"), (3200, "K"), (10000, "L"), (35000, "M"), (150000, "N"), (500000, "P"), (10**12, "Q"),
]
LETTERS = ["A", "B", "C", "D", "E", "F", "G", "H", "J", "K", "L", "M", "N", "P", "Q", "R"]
SAMPLE_SIZE = dict(zip(LETTERS, [2, 3, 5, 8, 13, 20, 32, 50, 80, 125, 200, 315, 500, 800, 1250, 2000]))
AQL_R0 = {0.065: 10, 0.1: 9, 0.15: 8, 0.25: 7, 0.4: 6, 0.65: 5, 1.0: 4, 1.5: 3, 2.5: 2, 4.0: 1, 6.5: 0}
AC_SEQ = [1, 2, 3, 5, 7, 10, 14, 21]  # 位于 r0+3 ... r0+10


def code_letter(lot_qty: int) -> str:
    for upper, letter in LOT_RANGES:
        if lot_qty <= upper:
            return letter
    return "Q"


def _resolve(row: int, r0: int) -> int:
    """把(行, 列)解析为实际采用方案所在行（跟随箭头）。"""
    if row <= r0:
        return r0
    if row == r0 + 1:  # ↑
        return r0
    if row == r0 + 2:  # ↓
        return r0 + 3
    if row > r0 + 10:  # ↑ 到 21/22
        return r0 + 10
    return row


def sampling_plan(lot_qty: float, aql: float = 1.0) -> dict:
    lot = max(int(round(lot_qty or 0)), 1)
    aql_key = min(AQL_R0, key=lambda a: abs(a - float(aql)))
    r0 = AQL_R0[aql_key]
    letter = code_letter(lot)
    row = _resolve(LETTERS.index(letter), r0)
    if row >= len(LETTERS):
        row = len(LETTERS) - 1
    n = SAMPLE_SIZE[LETTERS[row]]
    ac = 0 if row == r0 else AC_SEQ[row - r0 - 3]
    full = n >= lot
    return {
        "lot_qty": lot, "aql": aql_key, "code_letter": letter, "plan_letter": LETTERS[row],
        "sample_size": lot if full else n, "accept_num": ac, "reject_num": ac + 1, "full_inspection": full,
    }
