from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.services.ocr import (
    OCRUnavailableError,
    extract_picking_ticket,
    ocr_container_photo,
)

router = APIRouter(prefix="/ocr", tags=["ocr"])


MAX_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB safety cap
MAX_PICKING_TICKET_BYTES = 20 * 1024 * 1024  # 20 MB — PDFs can be larger


@router.post("/container-photo")
async def container_photo(photo: UploadFile = File(...)):
    """Accept an image, OCR it, return ISO 6346 candidates + raw text.

    First request after backend startup is slow (~10–30s) — model download.
    Subsequent requests are typically <1s on CPU.
    """
    if not photo.content_type or not photo.content_type.startswith("image/"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload must be an image (jpeg/png).",
        )

    image_bytes = await photo.read()
    if len(image_bytes) > MAX_IMAGE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"Image is larger than {MAX_IMAGE_BYTES // (1024 * 1024)}MB.",
        )

    try:
        candidates, raw_text = await ocr_container_photo(image_bytes)
    except OCRUnavailableError as e:
        # easyocr not installed in this runtime (production omits it to
        # keep the App Service image slim). The operator UI should fall
        # back to manual entry.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OCR failed: {e}",
        )

    return {
        "candidates": candidates,
        "raw_text": raw_text,
    }


@router.post("/picking-ticket")
async def picking_ticket(file: UploadFile = File(...)):
    """Accept a picking-ticket PDF or image, send it to the vision LLM, and
    return structured order fields (TO#, ship-to, lines, etc). Primary use is
    auto-filling the New outbound order form.

    Best-effort — every field is null when the LLM can't read it. Caller
    decides which fields to prefill; the user can edit anything afterward."""
    content_type = (file.content_type or "").lower()
    is_pdf = content_type == "application/pdf"
    is_image = content_type.startswith("image/")
    if not (is_pdf or is_image):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Upload must be a PDF or image (jpeg/png).",
        )

    file_bytes = await file.read()
    if len(file_bytes) > MAX_PICKING_TICKET_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"File is larger than {MAX_PICKING_TICKET_BYTES // (1024 * 1024)}MB.",
        )

    try:
        result = await extract_picking_ticket(file_bytes, content_type)
    except OCRUnavailableError as e:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=str(e),
        )
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Picking-ticket extraction failed: {e}",
        )

    return result
