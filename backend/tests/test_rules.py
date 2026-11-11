"""纯规则：AQL 抽样、GTIN/UDI。"""
from datetime import date

from app.services.aql import sampling_plan
from app.services.udi import build_udi, gtin_check_digit, is_valid_gtin, make_gtin14


def test_aql_general_level_ii():
    # 批量 1000, AQL 1.0 → J/80, Ac2 Re3
    p = sampling_plan(1000, 1.0)
    assert (p["code_letter"], p["sample_size"], p["accept_num"], p["reject_num"]) == ("J", 80, 2, 3)
    # 批量 500, AQL 0.65 → 字码 H，箭头向下采用 J 方案 n=80 Ac1
    p = sampling_plan(500, 0.65)
    assert (p["code_letter"], p["plan_letter"], p["sample_size"], p["accept_num"]) == ("H", "J", 80, 1)
    # 批量 60, AQL 2.5 → E，箭头向下 F 方案 n=20 Ac1
    p = sampling_plan(60, 2.5)
    assert (p["sample_size"], p["accept_num"]) == (20, 1)
    # 批量 20000, AQL 4.0 → M/315 Ac21
    assert sampling_plan(20000, 4.0)["accept_num"] == 21
    # 小批量：样本量 ≥ 批量 → 全检
    p = sampling_plan(5, 1.0)
    assert p["full_inspection"] and p["sample_size"] == 5 and p["accept_num"] == 0


def test_gtin_and_udi():
    assert gtin_check_digit("629104150021") == 3  # GS1 官方示例 6291041500213
    assert is_valid_gtin("6291041500213")
    assert not is_valid_gtin("6291041500214")
    g = make_gtin14("697000000", "001")
    assert len(g) == 14 and is_valid_gtin(g)
    udi = build_udi(g, mfg_date=date(2026, 11, 11), expiry_date=date(2031, 11, 10), lot="B261111001", serial="RL30001")
    assert udi == f"(01){g}(11)261111(17)311110(10)B261111001(21)RL30001"
