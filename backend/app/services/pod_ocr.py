"""POD (Proof of Delivery) field extraction.

Two extractors, picked in this order at call time:

  1. **Gemini vision** (default when GEMINI_API_KEY is set). Reads the
     full POD — handwritten or typed — and returns a structured JSON
     with all fields: container_no, chassis_no, seal_no, driver_name,
     driver_license_no, driver_phone, carrier, from/to addresses,
     pod_date, time_arrived, consignee, whpo_no, etc. Handles
     handwriting, mixed layouts, the attached driver-license card,
     and the post-it phone numbers scribbled below.

  2. **RapidOCR + rule-based parser** (fallback when Gemini unavailable
     or errors). Pure-Python, only extracts from/to locations using
     printed labels as anchors. The rule-based parser is lifted
     verbatim from https://github.com/Conquer-Nations/OCR-Driver-POD
     `ocr_service/parser.py` — credit there.

Why both: handwriting recognition is hard for OCR engines but easy for
vision LLMs. Rule-based stays for offline / no-API-key environments
and for redundancy when Gemini quota is exhausted.

Public surface:
    run_pod_ocr(image_bytes) -> {
      # Universal fields (Gemini fills, rule-based may leave blank)
      "container_no": str | None,
      "chassis_no": str | None,
      "seal_no": str | None,
      "driver_name": str | None,
      "driver_license_no": str | None,
      "driver_phone": str | None,
      "carrier": str | None,
      "from_location": str,        # always present (may be "")
      "to_location": str,          # always present (may be "")
      "pod_date": str | None,      # ISO YYYY-MM-DD
      "time_arrived": str | None,  # HH:MM or as-written
      "consignee": str | None,
      "whpo_no": str | None,
      "received_qty": str | None,
      "weight": str | None,
      "_confidence": dict[str, str],
      "_engine": "gemini" | "rapidocr",
      "_debug": dict,
    }
"""
from __future__ import annotations

import asyncio
import base64
import io
import json
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx
import numpy as np
from PIL import Image

from app.config import settings
from app.services.ocr import OCRUnavailableError, _get_rapidocr

logger = logging.getLogger(__name__)


# ─── Word dataclass (used by parser) ────────────────────────────────────


@dataclass
class Word:
    text: str
    x: float
    y: float
    w: float
    h: float
    conf: float

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2

    @property
    def right(self) -> float:
        return self.x + self.w

    @property
    def bottom(self) -> float:
        return self.y + self.h


# ─── Parser (lifted from upstream OCR-Driver-POD/ocr_service/parser.py) ──


def _norm(s: str) -> str:
    return re.sub(r"[^a-z0-9]", "", s.strip().lower())


RIGHT_COLUMN_LABELS = {"date", "inv", "container", "chassis", "seal", "driver", "time"}
BOTTOM_LABELS = {
    "failure", "load", "empty", "vessel", "voyage", "booking", "lading",
    "quantity", "description", "weight",
}
TOP_LABELS = {"proof", "delivery"}


def _detect_right_x(words: list[Word], img_w: int) -> float:
    xs = [w.x for w in words if _norm(w.text) in RIGHT_COLUMN_LABELS and w.x > img_w * 0.35]
    if xs:
        return min(xs) - 8
    return img_w * 0.55


def _detect_bottom_y(words: list[Word], img_h: int) -> float:
    ys = [w.y for w in words if _norm(w.text) in BOTTOM_LABELS]
    if ys:
        return min(ys) - 4
    return img_h * 0.55


def _detect_top_y(words: list[Word], img_h: int) -> float:
    ys = [w.bottom for w in words if _norm(w.text) in TOP_LABELS]
    if ys:
        return max(ys) + 4
    return img_h * 0.05


def _detect_left_x(words: list[Word], img_w: int) -> float:
    candidates: list[float] = []
    for w in words:
        if w.x < img_w * 0.15 and len(w.text.strip()) <= 2:
            candidates.append(w.right)
    if candidates:
        return max(candidates) + 6
    return img_w * 0.06


def _words_in_region(
    words: list[Word], x1: float, y1: float, x2: float, y2: float
) -> list[Word]:
    return [w for w in words if x1 <= w.cx <= x2 and y1 <= w.cy <= y2]


def _group_into_lines(ws: list[Word]) -> list[list[Word]]:
    if not ws:
        return []
    ws_sorted = sorted(ws, key=lambda w: w.cy)
    lines: list[list[Word]] = []
    current: list[Word] = [ws_sorted[0]]
    line_h = ws_sorted[0].h or 20
    for w in ws_sorted[1:]:
        if abs(w.cy - current[-1].cy) < max(line_h, w.h) * 0.7:
            current.append(w)
        else:
            lines.append(sorted(current, key=lambda x: x.x))
            current = [w]
            line_h = w.h or 20
    lines.append(sorted(current, key=lambda x: x.x))
    return lines


def _join_lines(lines: list[list[Word]]) -> str:
    out: list[str] = []
    for line in lines:
        text = " ".join(w.text for w in line).strip()
        if text:
            out.append(text)
    return "\n".join(out)


def parse_pod_fields(words: list[Word], img_w: int, img_h: int) -> dict[str, Any]:
    """Anchor on printed labels (DATE/CONTAINER/CHASSIS/SEAL/DRIVER on the
    right, FAILURE/LOAD/EMPTY at the bottom, PROOF/DELIVERY at the top)
    to find the FROM/TO column, then split it vertically in half."""
    fields: dict[str, Any] = {"from_location": "", "to_location": ""}
    confidence: dict[str, str] = {}

    if not words:
        return {**fields, "_confidence": confidence, "_debug": {"error": "no words detected"}}

    top_y = _detect_top_y(words, img_h)
    bottom_y = _detect_bottom_y(words, img_h)
    right_x = _detect_right_x(words, img_w)
    left_x = _detect_left_x(words, img_w)
    mid_y = (top_y + bottom_y) / 2

    from_words = _words_in_region(words, left_x, top_y, right_x, mid_y)
    to_words = _words_in_region(words, left_x, mid_y, right_x, bottom_y)

    fields["from_location"] = _join_lines(_group_into_lines(from_words))
    fields["to_location"] = _join_lines(_group_into_lines(to_words))
    if fields["from_location"]:
        confidence["from_location"] = "medium"
    if fields["to_location"]:
        confidence["to_location"] = "medium"

    return {
        **fields,
        "_confidence": confidence,
        "_debug": {
            "img_w": img_w,
            "img_h": img_h,
            "left_x": round(left_x, 1),
            "right_x": round(right_x, 1),
            "top_y": round(top_y, 1),
            "mid_y": round(mid_y, 1),
            "bottom_y": round(bottom_y, 1),
            "n_words": len(words),
            "n_from_words": len(from_words),
            "n_to_words": len(to_words),
        },
    }


# ─── RapidOCR → Word adapter ────────────────────────────────────────────


def _rapidocr_to_words(rapid_result: Any) -> list[Word]:
    """Convert RapidOCR's `[(box, text, conf), ...]` into our `Word` shape.
    `box` is a 4-point polygon `[[x1,y1],[x2,y2],[x3,y3],[x4,y4]]`."""
    if rapid_result is None:
        return []
    words: list[Word] = []
    for entry in rapid_result:
        box, text, conf = entry[0], entry[1], entry[2]
        xs = [float(p[0]) for p in box]
        ys = [float(p[1]) for p in box]
        words.append(
            Word(
                text=str(text).strip(),
                x=min(xs),
                y=min(ys),
                w=max(xs) - min(xs),
                h=max(ys) - min(ys),
                conf=float(conf),
            )
        )
    return words


def _do_pod_ocr_sync(image_bytes: bytes) -> dict[str, Any]:
    """Synchronous OCR + parse. Wrapped in an executor by the async caller
    so we don't block the event loop with EasyOCR-style heavy CPU work."""
    engine = _get_rapidocr()
    image = Image.open(io.BytesIO(image_bytes))
    if image.mode != "RGB":
        image = image.convert("RGB")
    arr = np.array(image)
    result, _ = engine(arr)
    words = _rapidocr_to_words(result)
    parsed = parse_pod_fields(words, image.width, image.height)
    parsed["_engine"] = "rapidocr"
    return parsed


_GEMINI_POD_PROMPT = """You are reading a Proof of Delivery (POD) form for a logistics company. The image may include handwriting, typed text, an attached driver's license photo, and post-it style scribbles below the form. Extract the following fields.

Return ONLY valid JSON (no markdown fences, no prose), with this exact schema. Use null for missing/illegible fields. Trim whitespace. Preserve original capitalization for IDs (container, chassis, seal, license numbers).

{
  "container_no": "ISO 6346 container number — exactly 4 uppercase letters + 7 digits when present (e.g. ZCSU7954612)",
  "chassis_no": "alphanumeric chassis number (e.g. CCH2480092)",
  "seal_no": "alphanumeric seal number (e.g. A4261209945)",
  "driver_name": "full name — prefer the driver's license card if present (e.g. 'Daniel Gandara'), else the handwritten name on the form",
  "driver_license_no": "license number from the attached license card (e.g. A4645877)",
  "driver_phone": "phone number scribbled on the form (any format, e.g. '(562) 234-0277')",
  "carrier": "name of the FROM company / carrier (e.g. 'Hight Logistics')",
  "from_location": "FROM address as written, single string with line breaks as ', '",
  "to_location": "TO / delivery address",
  "pod_date": "date on the form in ISO YYYY-MM-DD format (interpret 5-22-26 as 2026-05-22)",
  "time_arrived": "TIME ARRIVED value as written (e.g. '16:20' or '1620' or '4:19')",
  "consignee": "consignee name (signature line)",
  "whpo_no": "WHPO / Warehouse PO / Load number if visible — usually 8 digits",
  "received_qty": "quantity received as written (e.g. '4')",
  "weight": "weight if present",
  "load_or_empty": "exactly 'Load' or 'Empty' based on which checkbox is marked, or null"
}

Rules:
- Driver name from the license card OVERRIDES the handwritten name (license is authoritative)
- For container/chassis/seal numbers, prefer the typed-looking digits over messy handwriting if both appear
- If a number is partially illegible, return your best confident reading; use null if you genuinely can't read it
- Do NOT invent fields — only the keys above"""


async def _extract_pod_with_gemini(image_bytes: bytes) -> dict[str, Any]:
    """Vision-LLM extraction. Returns the dict with all fields populated
    (or null) per the prompt's JSON schema."""
    api_key = settings.gemini_api_key
    if not api_key:
        raise OCRUnavailableError("GEMINI_API_KEY not configured")

    # Normalise to JPEG for predictable Gemini input.
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
                    {"text": _GEMINI_POD_PROMPT},
                    {"inline_data": {"mime_type": "image/jpeg", "data": img_b64}},
                ]
            }
        ],
        # Larger token budget than container-OCR (full JSON object vs single code).
        # temperature=0 for deterministic output.
        "generationConfig": {"temperature": 0.0, "maxOutputTokens": 1024},
    }

    async with httpx.AsyncClient(timeout=60.0) as client:
        r = await client.post(url, json=body)
    if not r.is_success:
        raise RuntimeError(f"Gemini {r.status_code}: {r.text[:300]}")
    data = r.json()
    try:
        text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
    except (KeyError, IndexError, TypeError):
        text = ""

    # Strip markdown fences if Gemini wrapped the JSON despite instructions.
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text.strip(), flags=re.MULTILINE).strip()
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as e:
        logger.warning("Gemini POD JSON parse failed: %s\nText: %s", e, text[:300])
        return {
            "from_location": "",
            "to_location": "",
            "_confidence": {},
            "_engine": "gemini",
            "_debug": {"error": "json_parse_failed", "raw_text": text[:500]},
        }

    # Normalise: ensure from/to are strings (never null) for downstream callers
    # that always treat them as strings.
    parsed.setdefault("from_location", "")
    parsed.setdefault("to_location", "")
    if parsed["from_location"] is None:
        parsed["from_location"] = ""
    if parsed["to_location"] is None:
        parsed["to_location"] = ""
    parsed["_engine"] = "gemini"
    parsed["_confidence"] = {k: "high" for k, v in parsed.items() if v and not k.startswith("_")}
    return parsed


async def run_pod_ocr(image_bytes: bytes) -> dict[str, Any]:
    """Extract POD fields. Prefers Gemini vision (richer extraction —
    handles handwriting, driver-license card, all fields). Falls back to
    RapidOCR rule-based (from/to only) when Gemini unavailable or errors.
    Never raises — returns a degraded result on failure so the manager
    can still file the tally and correct fields manually."""
    # 1) Gemini if configured.
    if settings.gemini_api_key:
        try:
            return await _extract_pod_with_gemini(image_bytes)
        except OCRUnavailableError:
            pass  # No key — fall through to rule-based.
        except Exception as e:
            logger.warning(
                "Gemini POD extraction failed [%s: %s] — falling back to RapidOCR",
                type(e).__name__,
                e,
            )

    # 2) RapidOCR rule-based fallback.
    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _do_pod_ocr_sync, image_bytes)
    except OCRUnavailableError:
        raise
    except Exception as e:
        logger.exception("POD OCR failed (rule-based fallback)")
        return {
            "from_location": "",
            "to_location": "",
            "_confidence": {},
            "_debug": {"error": f"{type(e).__name__}: {e}"},
            "_engine": "rapidocr",
        }
