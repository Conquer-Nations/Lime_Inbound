"""cn-ocr-service — FastAPI app exposing EasyOCR for container plate photos.

Deployed as a separate Azure Container App so the main App Service stays
lean. The frontend operator portal posts a plate photo here and receives
ISO 6346 BIC candidates.

Endpoints
---------
GET  /health             — readiness probe used by Azure Container Apps.
POST /container-photo    — accepts an image, returns candidates + raw text.

The contract is byte-identical to the main backend's /ocr/container-photo
endpoint so the existing CameraOcr React component works against either
URL without modification.
"""

from __future__ import annotations

import os

from fastapi import FastAPI, File, HTTPException, UploadFile, status
from fastapi.middleware.cors import CORSMiddleware

from app.ocr import ocr_container_photo

# 12 MB upload cap — phones with HEIC + landscape photos can push 8-10 MB.
MAX_IMAGE_BYTES = 12 * 1024 * 1024


# CORS — only allow the SWA origin(s) that should be hitting this. Defaults
# to "*" so the service is usable in local dev; in production override
# with CORS_ORIGINS env var ("https://black-grass-0bb650210.7.azurestaticapps.net").
def _cors_origins() -> list[str]:
    raw = os.environ.get("CORS_ORIGINS", "*").strip()
    if not raw or raw == "*":
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


app = FastAPI(
    title="cn-ocr-service",
    version="0.1.0",
    description="Container plate OCR via EasyOCR. Standalone Azure Container App.",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_cors_origins(),
    allow_credentials=False,         # we don't take cookies / JWTs here
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


@app.get("/health")
async def health() -> dict:
    """Liveness/readiness probe. Doesn't touch the OCR model so it's fast
    even on cold start — the Container App platform uses this to decide
    when the container is ready to receive traffic."""
    return {"status": "ok", "service": "cn-ocr-service"}


@app.post("/container-photo")
async def container_photo(photo: UploadFile = File(...)) -> dict:
    """Accept an image, OCR it, return ISO 6346 candidates + raw text.

    On the very first request after a cold start (scale-to-zero or fresh
    deploy), the EasyOCR Reader reloads from disk — typically <2s thanks
    to the Dockerfile's RUN-time model pre-warm. Subsequent requests run
    the model from in-memory state, typically <1s on CPU.
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
    except Exception as e:  # noqa: BLE001
        # In this service we always have easyocr installed (vs. the main
        # backend that omits it). So any failure here is genuinely
        # unexpected; surface a 500 so the frontend's manual-entry
        # fallback kicks in.
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"OCR failed: {e}",
        )

    return {
        "candidates": candidates,
        "raw_text": raw_text,
    }
