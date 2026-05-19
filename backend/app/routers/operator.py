from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_session
from app.schemas.operator import (
    ContainerLookupRequest,
    ContainerLookupResponse,
    FinishRequest,
    FinishResponse,
    ScanRequest,
    ScanResponse,
)
from app.services.assignment import (
    CapacityOverflowError,
    MissingMasterDataError,
    UnknownSKUError,
)
from app.services.receiving import (
    ContainerNotFoundError,
    ReceiptNotFoundError,
    finish_container,
    lookup_container,
    record_scan,
)

router = APIRouter(prefix="/operator", tags=["operator"])


@router.post("/container/lookup", response_model=ContainerLookupResponse)
async def lookup(req: ContainerLookupRequest, session: AsyncSession = Depends(get_session)):
    try:
        result = await lookup_container(session, req.container_no, req.operator)
    except ContainerNotFoundError:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Container {req.container_no} not found in any DO.",
        )
    except UnknownSKUError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"Unknown SKU '{e.sku_raw}' — manager review needed.",
        )
    except MissingMasterDataError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"SKU '{e.sku}' missing {e.field} — manager review needed.",
        )
    except CapacityOverflowError as e:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                f"Warehouse capacity insufficient: need {e.pallets_needed} pallets, "
                f"only {e.pallets_available} free."
            ),
        )

    await session.commit()
    return result


@router.post("/scan", response_model=ScanResponse)
async def scan(req: ScanRequest, session: AsyncSession = Depends(get_session)):
    try:
        result = await record_scan(session, req.receipt_id, req.item_barcode, req.operator)
    except ReceiptNotFoundError:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {req.receipt_id} not found.",
        )
    except NotImplementedError as e:
        await session.rollback()
        raise HTTPException(status_code=status.HTTP_501_NOT_IMPLEMENTED, detail=str(e))

    await session.commit()
    return result


@router.post("/container/finish", response_model=FinishResponse)
async def finish(req: FinishRequest, session: AsyncSession = Depends(get_session)):
    try:
        result = await finish_container(session, req.receipt_id, req.operator)
    except ReceiptNotFoundError:
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Receipt {req.receipt_id} not found.",
        )

    await session.commit()
    return result
