from __future__ import annotations

from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.services.ocr import OCRUnavailableError, ocr_container_photo

router = APIRouter(prefix="/ocr", tags=["ocr"])


MAX_IMAGE_BYTES = 12 * 1024 * 1024  # 12 MB safety cap


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
