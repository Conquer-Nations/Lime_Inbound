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


_LETTER_TO_DIGIT = {
    "O": "0", "Q": "0", "D": "0",
    "I": "1", "L": "1",
    "Z": "2",
    "E": "3",
    "A": "4",
    "S": "5",
    "G": "6",
    "T": "7",
    "B": "8",
    "P": "9",
}
_DIGIT_TO_LETTER = {
    "0": "O", "1": "I", "2": "Z", "5": "S", "6": "G", "8": "B",
}


def _snap_to_bic(window: str) -> str | None:
    """Snap an 11-char A-Z0-9 window to (4 letters + 7 digits). Recovers from
    OCR letter→digit confusions in the trailing digit positions (B→8, O→0,
    S→5, Z→2, etc.). The first 4 positions MUST already be letters in the
    source text — we don't snap digits to letters because that creates many
    spurious matches by sliding the window across the alphanumeric blob."""
    if len(window) != 11:
        return None
    out = ""
    for i, ch in enumerate(window):
        if i < 4:
            if ch.isalpha():
                out += ch
            else:
                return None
        else:
            if ch.isdigit():
                out += ch
            elif ch in _LETTER_TO_DIGIT:
                out += _LETTER_TO_DIGIT[ch]
            else:
                return None
    return out


def extract_container_numbers(text: str) -> list[dict]:
    """Find ISO 6346 BIC codes in OCR output.

    Returns a list of candidate objects: {value, check_digit_valid, source}.
    Sources:
      - "ocr"                          → matched directly from OCR text
      - "ocr_check_digit_corrected"    → OCR-detected with wrong check digit
                                         or a single letter↔digit confusion
                                         was repaired
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

    # Fuzzy snap: try every 11-char window of [A-Z0-9] and coerce each cell
    # into its expected class (letters → first 4, digits → last 7). Catches
    # things like JZPU802168B → JZPU8021688 (B mis-read for 8 in the boxed
    # check-digit cell).
    for i in range(0, max(0, len(alnum) - 10)):
        snapped = _snap_to_bic(alnum[i : i + 11])
        if snapped is not None:
            candidates.add(snapped)

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

    # Rank: (1) check-digit-valid first, (2) direct OCR matches before
    # fuzzy-corrected ones, (3) alphabetical as a stable tiebreaker.
    _source_rank = {"ocr": 0, "ocr_check_digit_corrected": 1}
    out.sort(
        key=lambda x: (
            not x["check_digit_valid"],
            _source_rank.get(x["source"], 99),
            x["value"],
        )
    )
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
        except Exception as e:
            # Surface the real underlying error (often libGL / cv2 / onnx)
            raise OCRUnavailableError(
                f"rapidocr-onnxruntime import failed [{type(e).__name__}]: {e}"
            ) from e
        try:
            _rapidocr_engine = RapidOCR()
        except Exception as e:
            raise OCRUnavailableError(
                f"RapidOCR() init failed [{type(e).__name__}]: {e}"
            ) from e
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
    # RapidOCR is our local provider. We don't fall back to EasyOCR (which is
    # never installed in production) — that just masks the real RapidOCR
    # error. Surface the import / runtime error directly instead.
    logger.info("OCR: running RapidOCR (local)")
    return await loop.run_in_executor(None, _do_rapidocr, image_bytes)


# ─── Picking-ticket extraction ─────────────────────────────────────────


def _pdf_first_page_to_png(pdf_bytes: bytes) -> bytes:
    """Render the first page of a PDF to a PNG using pypdfium2. We only need
    the first page — picking tickets put the order header + ship-to on it."""
    try:
        import pypdfium2 as pdfium
    except ImportError as e:
        raise OCRUnavailableError(
            "pypdfium2 not installed — PDF picking tickets unsupported. "
            "Upload an image (PNG/JPEG) of the picking ticket instead."
        ) from e

    doc = pdfium.PdfDocument(pdf_bytes)
    if len(doc) == 0:
        raise ValueError("PDF has no pages.")
    page = doc[0]
    # scale=2 → ~144 DPI, plenty for vision LLMs to read addresses
    pil_image = page.render(scale=2).to_pil()
    buf = io.BytesIO()
    pil_image.save(buf, format="PNG")
    return buf.getvalue()


async def extract_picking_ticket(file_bytes: bytes, content_type: str) -> dict:
    """Send a picking-ticket image/PDF to OpenRouter Gemini and return
    structured order fields:
      {
        transfer_order_no, order_date, priority, memo,
        ship_to_name, ship_to_address,
        ship_from_name, ship_from_address,
        lines: [{sku, description, order_qty, unit}],
      }
    Every field is best-effort — the LLM returns null when it can't read
    a field rather than hallucinating. Caller decides what to prefill."""
    if not settings.openrouter_api_key:
        raise OCRUnavailableError(
            "Picking-ticket extraction needs OPENROUTER_API_KEY (vision LLM). "
            "Type the ship-to address manually instead."
        )

    # PDF → first-page PNG so the vision model gets a consistent image input.
    if content_type == "application/pdf":
        image_bytes = await asyncio.get_event_loop().run_in_executor(
            None, _pdf_first_page_to_png, file_bytes
        )
        mime = "image/png"
    else:
        image_bytes = file_bytes
        mime = content_type or "image/jpeg"

    img_b64 = base64.b64encode(image_bytes).decode("ascii")

    system_prompt = (
        "You read warehouse picking tickets / Transfer Order documents and "
        "extract structured fields. Return ONLY a single JSON object — no "
        "preamble, no markdown fences, no explanation.\n\n"
        "Schema:\n"
        "{\n"
        '  "transfer_order_no": string|null,   // e.g. "TO21787"\n'
        '  "order_date": string|null,           // ISO YYYY-MM-DD if shown\n'
        '  "priority": string|null,             // "normal" or "urgent"\n'
        '  "memo": string|null,                 // memo line if shown\n'
        '  "ship_from_name": string|null,\n'
        '  "ship_from_address": string|null,    // multi-line OK, use \\n\n'
        '  "ship_to_name": string|null,         // destination name / location code\n'
        '  "ship_to_address": string|null,      // multi-line OK, use \\n\n'
        '  "lines": [\n'
        '    {"sku": string, "description": string|null, '
        '"order_qty": number, "unit": string|null}\n'
        "  ]\n"
        "}\n\n"
        "Rules:\n"
        "- Use null (not empty string) when a field is missing.\n"
        "- For ship_to_address: include street, city, state/region, postal code, "
        "country if present, separated by \\n.\n"
        "- For lines: read every SKU row in the line-items table. order_qty is "
        "the requested quantity, not the picked quantity.\n"
        "- DO NOT invent data. If the page only shows ship-to and you can't "
        "find a SKU table, return an empty lines array."
    )

    body = {
        "model": settings.openrouter_model,
        "temperature": 0.0,
        "max_tokens": 1200,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": system_prompt},
            {
                "role": "user",
                "content": [
                    {
                        "type": "text",
                        "text": (
                            "Extract the picking-ticket fields from this "
                            "document. Pay special attention to the ship-to "
                            "address — that's the primary field. Return "
                            "JSON matching the schema."
                        ),
                    },
                    {
                        "type": "image_url",
                        "image_url": {"url": f"data:{mime};base64,{img_b64}"},
                    },
                ],
            },
        ],
    }
    headers = {
        "Authorization": f"Bearer {settings.openrouter_api_key}",
        "Content-Type": "application/json",
        "HTTP-Referer": "https://lime.cnwarehousing.com",
        "X-Title": "Conquer Nation Warehouse",
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            json=body,
            headers=headers,
        )
    if not r.is_success:
        raise RuntimeError(f"OpenRouter {r.status_code}: {r.text[:300]}")

    data = r.json()
    try:
        text = (data["choices"][0]["message"]["content"] or "").strip()
    except (KeyError, IndexError, TypeError):
        raise RuntimeError("OpenRouter returned no message content.")

    # Defensive: some models still wrap JSON in ```json fences despite the
    # response_format hint — strip them.
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)

    import json as _json

    try:
        parsed = _json.loads(text)
    except _json.JSONDecodeError as e:
        raise RuntimeError(
            f"Picking-ticket OCR returned non-JSON: {text[:200]}"
        ) from e

    # Normalise: clamp lines to list of dicts with expected keys
    lines = parsed.get("lines") or []
    if not isinstance(lines, list):
        lines = []
    cleaned_lines = []
    for ln in lines:
        if not isinstance(ln, dict):
            continue
        sku = ln.get("sku")
        if not sku:
            continue
        try:
            qty = int(ln.get("order_qty") or 0)
        except (TypeError, ValueError):
            qty = 0
        if qty < 1:
            continue
        cleaned_lines.append(
            {
                "sku": str(sku).strip().upper(),
                "description": (ln.get("description") or None),
                "order_qty": qty,
                "unit": (ln.get("unit") or "EA"),
            }
        )

    return {
        "transfer_order_no": parsed.get("transfer_order_no") or None,
        "order_date": parsed.get("order_date") or None,
        "priority": parsed.get("priority") or None,
        "memo": parsed.get("memo") or None,
        "ship_from_name": parsed.get("ship_from_name") or None,
        "ship_from_address": parsed.get("ship_from_address") or None,
        "ship_to_name": parsed.get("ship_to_name") or None,
        "ship_to_address": parsed.get("ship_to_address") or None,
        "lines": cleaned_lines,
    }
