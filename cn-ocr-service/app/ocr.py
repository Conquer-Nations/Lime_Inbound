"""Container plate OCR — EasyOCR pipeline + ISO 6346 candidate extraction.

This is a verbatim copy of `backend/app/services/ocr.py`. We keep two
copies on purpose: the main backend imports its own (which falls back to
a 503 when easyocr isn't installed); this Container App always has
easyocr installed and serves the heavy work without bloating the
App Service image.
"""

from __future__ import annotations

import asyncio
import io
import re

import numpy as np
from PIL import Image

_reader = None


def _get_reader():
    """Lazy-init the EasyOCR reader. Heavy first call — model download + load."""
    global _reader
    if _reader is None:
        # The Dockerfile pre-warms the model so this is a cheap reload of an
        # already-cached file — typically <1s in the container, even after
        # scale-to-zero cold start (image already has /root/.EasyOCR/ baked).
        import easyocr  # type: ignore[import-untyped]
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


def _do_ocr(image_bytes: bytes) -> tuple[list[dict], str]:
    """Sync OCR work. Wrapped in an executor by the async caller."""
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


async def ocr_container_photo(image_bytes: bytes) -> tuple[list[dict], str]:
    """Run OCR on image bytes off the event loop."""
    loop = asyncio.get_event_loop()
    return await loop.run_in_executor(None, _do_ocr, image_bytes)
