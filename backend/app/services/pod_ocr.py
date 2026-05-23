"""POD (Proof of Delivery) field extraction.

The rule-based parser (`parse_pod_fields`) is lifted verbatim from
https://github.com/Conquer-Nations/OCR-Driver-POD `ocr_service/parser.py`
— credit there. The reason for lifting rather than calling out:

  * Upstream runs EasyOCR (PyTorch). Our backend explicitly avoids torch
    in the prod requirements.txt (HANDOFF.md §32) and uses RapidOCR
    (ONNX) for the existing container-photo OCR.
  * The parser itself is pure-Python with no OCR-engine assumption — it
    only consumes `Word(text, x, y, w, h, conf)` tuples.

So we drop the parser in here and feed it RapidOCR's output through a
tiny adapter. Zero new heavy dependencies.

Public surface:
    run_pod_ocr(image_bytes) -> {
      "from_location": str,
      "to_location": str,
      "_confidence": {field: "high"|"medium"|"low"},
      "_debug": {...}
    }
"""
from __future__ import annotations

import asyncio
import io
import logging
import re
from dataclasses import dataclass
from typing import Any

import numpy as np
from PIL import Image

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


async def run_pod_ocr(image_bytes: bytes) -> dict[str, Any]:
    """Extract POD fields. Returns the dict described in the module
    docstring. Raises OCRUnavailableError if RapidOCR can't initialize."""
    try:
        loop = asyncio.get_event_loop()
        return await loop.run_in_executor(None, _do_pod_ocr_sync, image_bytes)
    except OCRUnavailableError:
        raise
    except Exception as e:
        logger.exception("POD OCR failed")
        return {
            "from_location": "",
            "to_location": "",
            "_confidence": {},
            "_debug": {"error": f"{type(e).__name__}: {e}"},
            "_engine": "rapidocr",
        }
