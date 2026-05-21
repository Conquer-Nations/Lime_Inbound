"""Server-side OCR for container plate photos.

Two backends, picked in order:
  1. Gemini 2.0 Flash (if GEMINI_API_KEY is set) — vision LLM, handles
     real-world photos with door rods / hinges / dirt / glare. Free tier
     (15 req/min) is plenty for warehouse use.
  2. EasyOCR (if installed in the runtime) — fallback.

If neither is available the router returns 503 and operators type the
container number manually.
"""

from __future__ import annotations

import asyncio
import base64
import io
import logging
import re

import httpx
import numpy as np
from PIL import Image

from app.config import settings

logger = logging.getLogger(__name__)

_reader = None


class OCRUnavailableError(RuntimeError):
    """Raised when EasyOCR isn't installed in the runtime — production
    deployments may omit it to keep the image small. Operators can still
    type container numbers manually."""


def _get_reader():
    """Lazy-init the EasyOCR reader. Heavy first call — model download + load."""
    global _reader
    if _reader is None:
        # Import here so module load doesn't trigger torch initialization.
        # In production we may have omitted easyocr (torch + cuda is ~1.5GB);
        # raise a typed error so the router can return a clean 503.
        try:
            import easyocr  # type: ignore[import-untyped]
        except ImportError as e:
            raise OCRUnavailableError(
                "EasyOCR is not installed in this runtime. "
                "Operators must type the container number manually."
            ) from e

        _reader = easyocr.Reader(["en"], gpu=False, verbose=False)
    return _reader


_STRICT = re.compile(r"[A-Z]{4}\d{7}")
_LOOSE_BIC = re.compile(r"([A-Z]{3})(U)[^A-Z0-9]{0,12}(\d{6})[^A-Z0-9]{0,12}(\d)")


# ISO 6346 letter values. A=10, B=12, ... skipping multiples of 11 (11, 22, 33).
def _build_letter_values() -> dict[str, int]:
    table: dict[str, int] = {}
    val = 10
    for letter in "ABCDEFGHIJKLMNOPQRSTUVWXYZ":
        while val in (11, 22, 33):
            val += 1
        table[letter] = val
        val += 1
    return table


_LETTER_VALUES = _build_letter_values()


def compute_check_digit(prefix: str) -> int:
    """Compute ISO 6346 check digit from the 10-char prefix (4 letters + 6 digits)."""
    if len(prefix) != 10:
        raise ValueError("prefix must be exactly 10 characters")
    total = 0
    for i, char in enumerate(prefix):
        if char.isdigit():
            value = int(char)
        else:
            value = _LETTER_VALUES[char]
        total += value * (2 ** i)
    digit = total % 11
    return 0 if digit == 10 else digit


def is_valid_bic(bic: str) -> bool:
    """True if `bic` is a structurally valid ISO 6346 container number."""
    if not _STRICT.fullmatch(bic):
        return False
    return compute_check_digit(bic[:10]) == int(bic[10])


def correct_check_digit(bic: str) -> str:
    """Return `bic` with its 11th character replaced by the computed check digit."""
    return bic[:10] + str(compute_check_digit(bic[:10]))


def extract_container_numbers(text: str) -> list[dict]:
    """Find ISO 6346 BIC codes in OCR output.

    Returns a list of candidate objects: {value, check_digit_valid, source}.
    Sources:
      - "ocr"                          → matched directly from OCR text
      - "ocr_check_digit_corrected"    → OCR-detected with wrong check digit;
                                         replaced with the computed correct one
    """
    upper = text.upper()
    candidates: set[str] = set()

    for m in _STRICT.findall(upper):
        candidates.add(m)

    partial = re.sub(r"[\s\-_./,]", "", upper)
    for m in _STRICT.findall(partial):
        candidates.add(m)

    alnum = re.sub(r"[^A-Z0-9]", "", upper)
    for m in _STRICT.findall(alnum):
        candidates.add(m)

    for m in _LOOSE_BIC.finditer(upper):
        reassembled = m.group(1) + m.group(2) + m.group(3) + m.group(4)
        if _STRICT.fullmatch(reassembled):
            candidates.add(reassembled)

    out: list[dict] = []
    seen: set[str] = set()
    for c in sorted(candidates):
        if c in seen:
            continue
        seen.add(c)
        valid = is_valid_bic(c)
        out.append({"value": c, "check_digit_valid": valid, "source": "ocr"})
        if not valid:
            corrected = correct_check_digit(c)
            if corrected not in seen:
                seen.add(corrected)
                out.append(
                    {
                        "value": corrected,
                        "check_digit_valid": True,
                        "source": "ocr_check_digit_corrected",
                    }
                )

    # Prefer valid candidates first
    out.sort(key=lambda x: (not x["check_digit_valid"], x["value"]))
    return out


def _do_ocr(image_bytes: bytes) -> tuple[list[str], str]:
    """Sync EasyOCR work. Wrapped in an executor by the async caller."""
    reader = _get_reader()
    image = Image.open(io.BytesIO(image_bytes))
    if image.mode != "RGB":
        image = image.convert("RGB")
    arr = np.array(image)
    # EasyOCR returns list of (bbox, text, confidence)
    results = reader.readtext(arr)
    raw_text = "\n".join(r[1] for r in results)
    candidates = extract_container_numbers(raw_text)
    return candidates, raw_text


_rapidocr_engine = None


def _get_rapidocr():
    """Lazy-init RapidOCR engine. First call loads ONNX models (~100MB)."""
    global _rapidocr_engine
    if _rapidocr_engine is None:
        try:
            from rapidocr_onnxruntime import RapidOCR  # type: ignore[import-untyped]
        except ImportError as e:
            raise OCRUnavailableError(
                "rapidocr-onnxruntime is not installed in this runtime."
            ) from e
        _rapidocr_engine = RapidOCR()
    return _rapidocr_engine


def _do_rapidocr(image_bytes: bytes) -> tuple[list[dict], str]:
    """RapidOCR (PaddleOCR via ONNX) — local, no external API, ~100MB."""
    engine = _get_rapidocr()
    image = Image.open(io.BytesIO(image_bytes))
    if image.mode != "RGB":
        image = image.convert("RGB")
    arr = np.array(image)
    # RapidOCR returns (result, elapse). result is list of [box, text, conf]
    result, _ = engine(arr)
    if result is None:
        raw_text = ""
    else:
        raw_text = "\n".join(r[1] for r in result)
    candidates = extract_container_numbers(raw_text)
    return candidates, raw_text


_GEMINI_PROMPT = (
    "You are reading an ISO 6346 container number off a photo of a shipping "
    "container. The code is always 4 uppercase letters followed by 7 digits "
    "(the last digit may appear in a small box). Door rods, hinges, dirt, "
    "and the type-code line (e.g. '45G1') may be visible — ignore those.\n\n"
    "Reply with ONLY the 11-character code on a single line (e.g. JZPU8021688). "
    "If you cannot read it, reply NONE."
)


async def _ocr_with_gemini(image_bytes: bytes) -> tuple[list[dict], str]:
    """Send the image to Gemini and parse a BIC code out of the response."""
    api_key = settings.gemini_api_key
    if not api_key:
        raise OCRUnavailableError("GEMINI_API_KEY not configured")

    # Gemini accepts JPEG/PNG up to ~20MB. We normalize to JPEG.
    image = Image.open(io.BytesIO(image_bytes))
    if image.mode != "RGB":
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=88)
    img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    url = (
        f"https://generativelanguage.googleapis.com/v1beta/models/"
        f"{settings.gemini_model}:generateContent?key={api_key}"
    )
    body = {
        "contents": [
            {
                "parts": [
                    {"text": _GEMINI_PROMPT},
                    {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
                ]
            }
        ],
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 32},
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url, json=body)
    if not r.is_success:
        raise RuntimeError(f"Gemini {r.status_code}: {r.text[:300]}")
    data = r.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError):
        text = ""

    candidates = extract_container_numbers(text)
    return candidates, text


async def _ocr_with_openrouter(image_bytes: bytes) -> tuple[list[dict], str]:
    """Send the image to OpenRouter (same approach as the OCR-Driver-POD repo).
    OpenRouter relays to a vision LLM (default: free Gemini Flash) and lets us
    avoid direct-Gemini quota issues entirely."""
    api_key = settings.openrouter_api_key
    if not api_key:
        raise OCRUnavailableError("OPENROUTER_API_KEY not configured")

    image = Image.open(io.BytesIO(image_bytes))
    if image.mode != "RGB":
        image = image.convert("RGB")
    buf = io.BytesIO()
    image.save(buf, format="JPEG", quality=88)
    img_b64 = base64.b64encode(buf.getvalue()).decode("ascii")

    system_prompt = (
        "You read shipping-container ISO 6346 codes from photos. The code is "
        "ALWAYS exactly 11 characters: 4 uppercase letters then 7 digits "
        "(no spaces, no separators in your output). The 11th digit (check "
        "digit) may appear inside a small box on the container — include it. "
        "Vertical door rods, hinges, dirt, and the type-code line below "
        "(e.g. '45G1', '22G1') are not part of the code — ignore them.\n\n"
        "Examples of valid output: JZPU8021688  CMAU1234567  TGHU0123456\n\n"
        "Respond with ONLY the 11-character code, all on one line, nothing "
        "else — no preamble, no explanation. If the code is unreadable, "
        "respond with just: NONE"
    )

    body = {
        "model": settings.openrouter_model,
        "temperature": 0.0,
        "max_tokens": 64,
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Read the container code from this photo. "
                            "Return ALL 11 characters: 4 letters + 7 digits "
                            "(include the check digit even if it's in a separate box)."
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:image/jpeg;base64,{img_b64}"},
                    },
                ],
            },
        ],
    }
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://lime.cnwarehousing.com",
        "X-Title": "Conquer Nation Warehouse",
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            json=body,
            headers=headers,
        )
    if not r.is_success:
        raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:300]}")
    data = r.json()
    text = ""
    try:
        text = (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        pass

    candidates = extract_container_numbers(text)
    return candidates, text


async def ocr_container_photo(image_bytes: bytes) -> tuple[list[dict], str]:
    """Provider priority:
      1. OpenRouter (vision LLM, when openrouter_api_key set)
      2. Direct Gemini AI Studio (when gemini_api_key set)
      3. RapidOCR (local ONNX, no external API, ~100MB — always available
         when the package is installed)
      4. EasyOCR (legacy fallback; only if torch is installed)"""
    if settings.openrouter_api_key:
        logger.info("OCR: calling OpenRouter (model=%s)", settings.openrouter_model)
        return await _ocr_with_openrouter(image_bytes)
    if settings.gemini_api_key:
        logger.info("OCR: calling Gemini (model=%s)", settings.gemini_model)
        return await _ocr_with_gemini(image_bytes)
    loop = asyncio.get_event_loop()
    # Try RapidOCR (local) first — small, fast, no external dependency
    try:
        logger.info("OCR: running RapidOCR (local)")
        return await loop.run_in_executor(None, _do_rapidocr, image_bytes)
    except OCRUnavailableError as e:
        logger.warning("RapidOCR not available: %s. Falling back to EasyOCR.", e)
    return await loop.run_in_executor(None, _do_ocr, image_bytes)
