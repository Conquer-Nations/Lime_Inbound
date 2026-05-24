from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from sqlalchemy import text

from app.config import settings
from app.db import engine
from app.routers import audit as audit_router
from app.routers import manager as manager_router
from app.routers import ocr as ocr_router
from app.routers import operator as operator_router
from app.routers import outbound as outbound_router
from app.routers import scan_sheet as scan_sheet_router
from app.routers import tally as tally_router
from app.routers import vendor as vendor_router
from app.routers import vendor_auth as vendor_auth_router


@asynccontextmanager
async def lifespan(_app: FastAPI):
    yield
    await engine.dispose()


app = FastAPI(title="CN Warehouse API", version="0.1.0", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


app.include_router(operator_router.router)
app.include_router(vendor_router.router)
app.include_router(vendor_auth_router.router)
app.include_router(manager_router.router)
app.include_router(ocr_router.router)
# Scan-sheet feature — endpoints respond 503 until SCAN_SHEETS_ENABLED=true.
app.include_router(scan_sheet_router.router)
app.include_router(audit_router.router)
# Outbound (Phase 2) — vendor-facing /vendor/outbound endpoints
app.include_router(outbound_router.router)
# Tally sheets — POD-driven billing audit log (#13). Manager uploads
# POD, operator scan-sheet open is gated on tally existing, vendor
# sees status.
app.include_router(tally_router.router)
app.include_router(tally_router.vendor_router)


@app.get("/health")
async def health():
    return {"status": "ok", "service": "cn-warehouse", "version": app.version}


@app.get("/health/db")
async def health_db():
    async with engine.connect() as conn:
        result = await conn.execute(text("SELECT 1"))
        value = result.scalar()
    return {"status": "ok", "db_check": value}
