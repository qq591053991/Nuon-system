"""QMS 路由：检验（IQC）、AQL 抽样计算、NCR、CAPA。"""
from datetime import date

from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import now
from ..crud import paginate
from ..db import get_db
from ..errors import BizError, NotFound
from ..models import Capa, Inspection, Material, Ncr, User
from ..security import SignatureIn, esign, get_current_user, require
from ..serial import ser
from ..services import quality as svc
from ..services.aql import sampling_plan
from ..services.numbering import next_no

router = APIRouter(tags=["质量QMS"])


@router.get("/api/quality/aql", summary="AQL 抽样方案（GB/T 2828.1 一般检验水平 II）")
def aql(lot_qty: float, aql: float = 1.0, _: User = Depends(get_current_user)):
    return sampling_plan(lot_qty, aql)


@router.get("/api/inspections", summary="检验单列表")
def list_insp(q: str | None = None, status: str | None = None, insp_type: str | None = None, page: int = 1,
              page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Inspection).join(Material).order_by(Inspection.id.desc())
    if q:
        stmt = stmt.where(or_(Inspection.no.ilike(f"%{q}%"), Inspection.lot_no.ilike(f"%{q}%"),
                              Material.code.ilike(f"%{q}%"), Material.name.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(Inspection.status.in_(status.split(",")))
    if insp_type:
        stmt = stmt.where(Inspection.insp_type == insp_type)
    return paginate(db, stmt, page, page_size)


@router.get("/api/inspections/{iid}", summary="检验单详情")
def get_insp(iid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    i = db.get(Inspection, iid)
    if not i:
        raise NotFound("检验单")
    return ser(i, ("items",))


class InspItemIn(BaseModel):
    id: int | None = None
    name: str
    standard: str | None = None
    value: str | None = None
    result: str = "PASS"


class InspSubmitIn(BaseModel):
    defect_qty: int = 0
    items: list[InspItemIn] = []
    concession: bool = False  # 不合格时申请让步接收（需 QA）
    remark: str | None = None
    signature: SignatureIn


@router.post("/api/inspections/{iid}/submit", summary="提交检验结果（电子签名，自动转换库存质量状态）")
def submit_insp(iid: int, body: InspSubmitIn, db: Session = Depends(get_db), user: User = Depends(require("qc"))):
    i = db.get(Inspection, iid)
    if not i:
        raise NotFound("检验单")
    svc.submit_inspection(db, user, i, items=[x.model_dump() for x in body.items], defect_qty=body.defect_qty,
                          concession=body.concession, remark=body.remark, sig=body.signature)
    db.commit()
    return ser(i, ("items",))


# ---------- NCR ----------
@router.get("/api/ncrs", summary="不合格品报告列表")
def list_ncr(q: str | None = None, status: str | None = None, source: str | None = None, wo_id: int | None = None,
             page: int = 1, page_size: int = 20, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Ncr).order_by(Ncr.id.desc())
    if q:
        stmt = stmt.where(or_(Ncr.no.ilike(f"%{q}%"), Ncr.sn.ilike(f"%{q}%"), Ncr.lot_no.ilike(f"%{q}%"),
                              Ncr.description.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(Ncr.status.in_(status.split(",")))
    if source:
        stmt = stmt.where(Ncr.source == source)
    if wo_id:
        stmt = stmt.where(Ncr.wo_id == wo_id)
    return paginate(db, stmt, page, page_size)


@router.get("/api/ncrs/{nid}", summary="NCR 详情")
def get_ncr(nid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    n = db.get(Ncr, nid)
    if not n:
        raise NotFound("NCR")
    return ser(n)


class NcrIn(BaseModel):
    source: str = "OTHER"  # CUSTOMER/OTHER/FQC...
    severity: str = "MAJOR"
    material_id: int | None = None
    lot_no: str | None = None
    sn: str | None = None
    customer_id: int | None = None
    supplier_id: int | None = None
    qty: float = 1
    description: str


@router.post("/api/ncrs", summary="手工开具 NCR（如客诉、巡检发现）")
def create_ncr(body: NcrIn, db: Session = Depends(get_db), user: User = Depends(require("qc", "qa"))):
    if body.source in ("PROCESS", "IQC"):
        raise BizError("过程/来料不合格由系统自动开具")
    n = Ncr(no=next_no(db, "NCR"), status="OPEN", created_by=user.username, **body.model_dump())
    db.add(n)
    db.commit()
    return ser(n)


class DispositionIn(BaseModel):
    disposition: str  # REWORK/SCRAP/USE_AS_IS/RETURN
    remark: str | None = None
    signature: SignatureIn


@router.post("/api/ncrs/{nid}/disposition", summary="NCR 评审处置（QA 电子签名）")
def disposition(nid: int, body: DispositionIn, db: Session = Depends(get_db), user: User = Depends(require("qa"))):
    n = db.get(Ncr, nid)
    if not n:
        raise NotFound("NCR")
    svc.disposition_ncr(db, user, n, body.disposition, body.remark, body.signature)
    db.commit()
    return ser(n)


class NcrCloseIn(BaseModel):
    capa_id: int | None = None


@router.post("/api/ncrs/{nid}/close", summary="关闭 NCR")
def close_ncr(nid: int, body: NcrCloseIn | None = None, db: Session = Depends(get_db), _: User = Depends(require("qa"))):
    n = db.get(Ncr, nid)
    if not n:
        raise NotFound("NCR")
    if n.status != "DISPOSITIONED":
        raise BizError("NCR 需先完成处置")
    n.status = "CLOSED"
    if body and body.capa_id:
        n.capa_id = body.capa_id
    db.commit()
    return ser(n)


# ---------- CAPA ----------
class CapaIn(BaseModel):
    title: str
    source: str = "NCR"
    ncr_id: int | None = None
    description: str | None = None
    root_cause: str | None = None
    correction: str | None = None
    corrective_action: str | None = None
    preventive_action: str | None = None
    owner: str | None = None
    due_date: date | None = None
    effectiveness: str | None = None


@router.get("/api/capas", summary="CAPA 列表")
def list_capa(q: str | None = None, status: str | None = None, page: int = 1, page_size: int = 20,
              db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    stmt = select(Capa).order_by(Capa.id.desc())
    if q:
        stmt = stmt.where(or_(Capa.no.ilike(f"%{q}%"), Capa.title.ilike(f"%{q}%")))
    if status:
        stmt = stmt.where(Capa.status.in_(status.split(",")))
    return paginate(db, stmt, page, page_size)


@router.get("/api/capas/{cid}", summary="CAPA 详情")
def get_capa(cid: int, db: Session = Depends(get_db), _: User = Depends(get_current_user)):
    c = db.get(Capa, cid)
    if not c:
        raise NotFound("CAPA")
    d = ser(c)
    d["ncrs"] = [ser(n) for n in db.scalars(select(Ncr).where(Ncr.capa_id == cid))]
    return d


@router.post("/api/capas", summary="新建 CAPA")
def create_capa(body: CapaIn, db: Session = Depends(get_db), user: User = Depends(require("qa"))):
    c = Capa(no=next_no(db, "CAPA"), status="OPEN", created_by=user.username,
             **body.model_dump(exclude={"ncr_id"}))
    db.add(c)
    db.flush()
    if body.ncr_id:
        n = db.get(Ncr, body.ncr_id)
        if n:
            n.capa_id = c.id
    db.commit()
    return ser(c)


@router.put("/api/capas/{cid}", summary="更新 CAPA")
def update_capa(cid: int, body: CapaIn, db: Session = Depends(get_db), _: User = Depends(require("qa"))):
    c = db.get(Capa, cid)
    if not c:
        raise NotFound("CAPA")
    if c.status == "CLOSED":
        raise BizError("CAPA 已关闭")
    for k, v in body.model_dump(exclude={"ncr_id"}, exclude_unset=True).items():
        setattr(c, k, v)
    if c.status == "OPEN" and (c.root_cause or c.corrective_action):
        c.status = "IN_PROGRESS"
    db.commit()
    return ser(c)


class CapaStatusIn(BaseModel):
    status: str  # IN_PROGRESS/VERIFYING/CLOSED
    effectiveness: str | None = None
    signature: SignatureIn | None = None


@router.post("/api/capas/{cid}/status", summary="CAPA 状态流转（关闭需电子签名）")
def capa_status(cid: int, body: CapaStatusIn, db: Session = Depends(get_db), user: User = Depends(require("qa"))):
    c = db.get(Capa, cid)
    if not c:
        raise NotFound("CAPA")
    flow = {"OPEN": ("IN_PROGRESS",), "IN_PROGRESS": ("VERIFYING",), "VERIFYING": ("CLOSED", "IN_PROGRESS")}
    if body.status not in flow.get(c.status, ()):
        raise BizError(f"不能从 {c.status} 变更为 {body.status}")
    if body.effectiveness:
        c.effectiveness = body.effectiveness
    if body.status == "VERIFYING" and not (c.root_cause and c.corrective_action):
        raise BizError("请先填写根本原因和纠正措施")
    if body.status == "CLOSED":
        if not c.effectiveness:
            raise BizError("请填写有效性验证结论")
        esign(db, user, body.signature, "CAPA关闭批准", "qms_capa", c.id, c.no)
        c.closed_by, c.closed_at = user.full_name, now()
    c.status = body.status
    db.commit()
    return ser(c)
