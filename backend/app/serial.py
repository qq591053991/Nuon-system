"""ORM → dict 序列化：自动包含所有字段 + 模型上定义的只读属性（如 customer_name），并按需嵌套子表。"""
from functools import lru_cache

from sqlalchemy import inspect as sa_inspect

_HIDDEN = {"password_hash", "params_json", "serials"}


@lru_cache(maxsize=None)
def _props(cls) -> tuple[str, ...]:
    names = []
    for klass in cls.__mro__:
        for k, v in vars(klass).items():
            if isinstance(v, property) and not k.startswith("_") and k not in names:
                names.append(k)
    return tuple(names)


def _tree(children) -> dict:
    tree: dict = {}
    for path in children or ():
        node = tree
        for part in path.split("."):
            node = node.setdefault(part, {})
    return tree


def ser(obj, children=(), _tree_node: dict | None = None) -> dict | None:
    if obj is None:
        return None
    node = _tree_node if _tree_node is not None else _tree(children)
    mapper = sa_inspect(obj).mapper
    d = {}
    for attr in mapper.column_attrs:
        if attr.key in _HIDDEN:
            continue
        d[attr.key] = getattr(obj, attr.key)
    for p in _props(type(obj)):
        try:
            d[p] = getattr(obj, p)
        except Exception:  # pragma: no cover - 防御：属性计算失败不影响主数据返回
            d[p] = None
    for rel, sub in node.items():
        val = getattr(obj, rel)
        if isinstance(val, list):
            d[rel] = [ser(v, _tree_node=sub) for v in val]
        else:
            d[rel] = ser(val, _tree_node=sub)
    return d


def ser_list(objs, children=()) -> list[dict]:
    tree = _tree(children)
    return [ser(o, _tree_node=tree) for o in objs]
