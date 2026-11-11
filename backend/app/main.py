"""Nuon 智造云 —— 光疗医疗器械代工（OEM/ODM）一体化平台：ERP + MES + WMS + QMS。"""
import logging
import os
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from sqlalchemy.orm import Session

from . import audit
from .config import settings
from .db import engine
from .models import Base
from .routers import auth, erp, imports, master, mes, qms, report, system, wms

audit.install(Session)
log = logging.getLogger("nuon")

if settings.SECRET_KEY.startswith("nuon-dev-secret-key"):
    log.warning("正在使用默认 SECRET_KEY，生产环境请通过环境变量 SECRET_KEY 设置随机密钥！")


def create_app() -> FastAPI:
    app = FastAPI(title=settings.APP_NAME, version="1.0.0",
                  description="面向光疗医疗器械代工厂的 ERP/MES/WMS/QMS 一体化系统，内置 GMP/ISO 13485 合规控制。",
                  docs_url="/api/docs", openapi_url="/api/openapi.json")
    app.add_middleware(CORSMiddleware, allow_origins=settings.CORS_ORIGINS, allow_credentials=True,
                       allow_methods=["*"], allow_headers=["*"])

    @app.exception_handler(ValueError)
    async def _value_error(_: Request, exc: ValueError):
        return JSONResponse(status_code=400, content={"detail": str(exc)})

    for r in (auth.router, system.router, master.router, erp.router, wms.router, mes.router, qms.router,
              report.router, imports.router):
        app.include_router(r)

    @app.get("/api/health", tags=["系统管理"])
    def health():
        return {"status": "ok", "app": settings.APP_NAME}

    # 生产部署：后端直接托管前端构建产物（frontend/dist），也可由 Nginx 托管
    dist = Path(os.getenv("FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist"))
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/{full_path:path}", include_in_schema=False)
        def spa(full_path: str):
            if full_path.startswith("api/"):
                return JSONResponse(status_code=404, content={"detail": "接口不存在"})
            f = dist / full_path
            if full_path and f.is_file():
                return FileResponse(f)
            return FileResponse(dist / "index.html")

    return app


Base.metadata.create_all(engine)
app = create_app()
