import os
import tempfile
import warnings

_tmp = tempfile.mkdtemp(prefix="nuon-test-")
os.environ.setdefault("DATABASE_URL", f"sqlite:///{_tmp}/test.db")
os.environ["BCRYPT_ROUNDS"] = "4"
warnings.filterwarnings("ignore", category=DeprecationWarning)

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.db import SessionLocal, engine  # noqa: E402
from app.main import app  # noqa: E402
from app.models import Base  # noqa: E402
from app.seed import DEMO_PASSWORD, seed_base  # noqa: E402


class Api:
    """带登录态的测试客户端：api.as_("qa").post(...)"""

    def __init__(self, client: TestClient):
        self.c = client
        self._tokens: dict[str, str] = {}
        self.user = "admin"

    def as_(self, username: str) -> "Api":
        other = Api(self.c)
        other._tokens = self._tokens
        other.user = username
        return other

    def _h(self):
        if self.user not in self._tokens:
            r = self.c.post("/api/auth/login", json={"username": self.user, "password": DEMO_PASSWORD})
            assert r.status_code == 200, r.text
            self._tokens[self.user] = r.json()["access_token"]
        return {"Authorization": f"Bearer {self._tokens[self.user]}"}

    def get(self, url, **kw):
        return self.c.get(url, headers=self._h(), **kw)

    def post(self, url, json=None, **kw):
        return self.c.post(url, json=json, headers=self._h(), **kw)

    def put(self, url, json=None, **kw):
        return self.c.put(url, json=json, headers=self._h(), **kw)

    def delete(self, url, **kw):
        return self.c.delete(url, headers=self._h(), **kw)

    def ok(self, method: str, url: str, json=None, **kw):
        r = getattr(self, method)(url, json=json, **kw) if method in ("post", "put") else getattr(self, method)(url, **kw)
        assert r.status_code == 200, f"{method.upper()} {url} -> {r.status_code}: {r.text}"
        return r.json()


SIG = {"password": DEMO_PASSWORD, "reason": "测试"}


@pytest.fixture()
def ctx():
    Base.metadata.drop_all(engine)
    Base.metadata.create_all(engine)
    with SessionLocal() as db:
        data = seed_base(db)
    return data


@pytest.fixture()
def api(ctx):
    with TestClient(app) as client:
        yield Api(client)


def find(api: Api, url: str, **params) -> dict:
    items = api.ok("get", url, params=params)["items"]
    assert items, f"no items for {url} {params}"
    return items[0]


def ids(api: Api) -> dict:
    """常用主数据 id 映射。"""
    mats = {m["code"]: m["id"] for m in api.ok("get", "/api/materials", params={"page_size": 200})["items"]}
    locs = {l["code"]: l["id"] for l in api.ok("get", "/api/locations", params={"page_size": 200})["items"]}
    eqs = {e["code"]: e["id"] for e in api.ok("get", "/api/equipment", params={"page_size": 200})["items"]}
    return {"m": mats, "loc": locs, "eq": eqs}
