"""Generate a printable Tally Sheet PDF for each tally row.

One PDF per tally — written to disk every time the POD is uploaded
or the row is corrected via PATCH. Mirrors the data Tiana would
otherwise hand-write on the paper tally sheet template (Conquer
Nation's standard Inbound/Outbound form). Used for billing audit
and to hand to the driver as proof of receipt.

Implementation: pure reportlab (no Cairo, no system deps). Generated
from scratch for visual clarity — does not attempt to overlay on the
existing tallysheet.pdf template since the field positions there are
hand-drawn boxes that don't map cleanly to printable text rectangles.

If we ever want pixel-perfect template fidelity, swap this for an
overlay approach using pypdf to merge a reportlab canvas onto the
existing template page.
"""
from __future__ import annotations

import io
import logging
from datetime import datetime

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models import Container, TallySheet

logger = logging.getLogger(__name__)

# Conquer Nation brand colors (per memory: cyan #0093D0 / navy #1B4676).
_CN_NAVY = colors.HexColor("#1B4676")
_CN_CYAN = colors.HexColor("#0093D0")
_CN_LIGHT = colors.HexColor("#F5F8FB")


def _fmt_dt(dt: datetime | None) -> str:
    if dt is None:
        return ""
    return dt.strftime("%m/%d/%Y %I:%M %p")


def _row(label: str, value: str | None) -> list[str]:
    """Single key/value row, with em-dash for missing values."""
    return [label, value if value else "—"]


def generate_tally_pdf(tally: TallySheet, container: Container | None) -> bytes:
    """Return the generated PDF as bytes. Caller persists with
    `vendor_uploads.save_bytes(...)`.

    Pulls data from the tally row first (snapshotted at tally time —
    authoritative for billing); falls back to the container row for
    fields the tally doesn't snapshot (expected vs. actual arrival,
    parent WHPO, etc.)."""
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.4 * inch,
        rightMargin=0.4 * inch,
        topMargin=0.4 * inch,
        bottomMargin=0.4 * inch,
        title=f"Tally Sheet — {tally.matched_container_no}",
        author="Conquer Nation",
    )

    styles = getSampleStyleSheet()
    h1 = ParagraphStyle(
        "Title",
        parent=styles["Heading1"],
        textColor=_CN_NAVY,
        fontSize=20,
        spaceAfter=6,
        alignment=1,
    )
    h2 = ParagraphStyle(
        "Section",
        parent=styles["Heading2"],
        textColor=_CN_CYAN,
        fontSize=10,
        spaceBefore=10,
        spaceAfter=4,
        leading=12,
    )
    small = ParagraphStyle(
        "Small",
        parent=styles["Normal"],
        fontSize=8,
        textColor=colors.HexColor("#64748B"),
        alignment=1,
    )

    story: list = []

    # ── Header ─────────────────────────────────────────────────────────
    story.append(Paragraph("TALLY SHEET — INBOUND", h1))
    story.append(
        Paragraph(
            f"Generated {datetime.utcnow().strftime('%m/%d/%Y %I:%M %p')} UTC · "
            f"Tally #{tally.id}",
            small,
        )
    )
    story.append(Spacer(1, 8))

    # ── Top band: dates + signatures ───────────────────────────────────
    top_band = [
        ["Tallied at", _fmt_dt(tally.tallied_at), "Tallied by", tally.tallied_by or "—"],
        [
            "Billing status",
            tally.billing_status.upper(),
            "POD file",
            tally.pod_filename or "—",
        ],
    ]
    top_t = Table(top_band, colWidths=[1.2 * inch, 2.4 * inch, 1.2 * inch, 2.4 * inch])
    top_t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (0, -1), _CN_LIGHT),
                ("BACKGROUND", (2, 0), (2, -1), _CN_LIGHT),
                ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
                ("FONTNAME", (2, 0), (2, -1), "Helvetica-Bold"),
                ("TEXTCOLOR", (0, 0), (0, -1), _CN_NAVY),
                ("TEXTCOLOR", (2, 0), (2, -1), _CN_NAVY),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("RIGHTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 4),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
                ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
                ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#CBD5E1")),
            ]
        )
    )
    story.append(top_t)

    # ── Container / shipment block ─────────────────────────────────────
    story.append(Paragraph("Container & shipment", h2))
    whpo_no = container.do.whpo.whpo_number if (container and container.do and container.do.whpo) else None
    do_no = container.do.do_number if (container and container.do) else None
    customer = container.do.whpo.customer.name if (container and container.do and container.do.whpo and container.do.whpo.customer) else None
    expected_arr = container.expected_arrival_date.isoformat() if (container and container.expected_arrival_date) else None
    actual_arr = container.actual_arrival_date.isoformat() if (container and container.actual_arrival_date) else None
    shipment_rows = [
        _row("Container #", tally.matched_container_no),
        _row("WHPO / Load #", whpo_no),
        _row("DO #", do_no),
        _row("Customer (brand)", customer),
        _row("Expected arrival", expected_arr),
        _row("Actual arrival", actual_arr),
    ]
    s_t = Table(shipment_rows, colWidths=[1.6 * inch, 5.6 * inch])
    s_t.setStyle(_keyvalue_style())
    story.append(s_t)

    # ── Driver / truck block ───────────────────────────────────────────
    story.append(Paragraph("Driver & truck", h2))
    driver_rows = [
        _row("Driver name", tally.matched_driver_name),
        _row("Driver license #", tally.matched_driver_license),
        _row("Driver phone", tally.matched_driver_phone),
        _row("Carrier", tally.matched_carrier),
        _row("Truck plate", tally.matched_truck_plate),
    ]
    d_t = Table(driver_rows, colWidths=[1.6 * inch, 5.6 * inch])
    d_t.setStyle(_keyvalue_style())
    story.append(d_t)

    # ── OCR / Manual fields from POD ───────────────────────────────────
    story.append(Paragraph("POD fields (OCR + manual)", h2))
    pod_rows = [
        _row("From location", tally.ocr_from_location),
        _row("To location", tally.ocr_to_location),
        _row("Seal #", tally.manual_seal_no),
        _row("Chassis #", tally.manual_chassis_no),
        _row("OCR engine", tally.ocr_engine),
    ]
    p_t = Table(pod_rows, colWidths=[1.6 * inch, 5.6 * inch])
    p_t.setStyle(_keyvalue_style())
    story.append(p_t)

    # ── Notes ──────────────────────────────────────────────────────────
    if tally.billing_notes:
        story.append(Paragraph("Billing notes", h2))
        notes_t = Table(
            [[Paragraph(tally.billing_notes, styles["Normal"])]],
            colWidths=[7.2 * inch],
        )
        notes_t.setStyle(
            TableStyle(
                [
                    ("BACKGROUND", (0, 0), (-1, -1), _CN_LIGHT),
                    ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
                    ("LEFTPADDING", (0, 0), (-1, -1), 8),
                    ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                    ("TOPPADDING", (0, 0), (-1, -1), 6),
                    ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
                ]
            )
        )
        story.append(notes_t)

    # ── Footer signatures area ─────────────────────────────────────────
    story.append(Spacer(1, 20))
    sig_t = Table(
        [
            ["Operator signature", "", "Driver signature", ""],
            ["", "Date: ____________", "", "Date: ____________"],
        ],
        colWidths=[1.6 * inch, 2.0 * inch, 1.6 * inch, 2.0 * inch],
        rowHeights=[28, 16],
    )
    sig_t.setStyle(
        TableStyle(
            [
                ("FONTNAME", (0, 0), (0, 0), "Helvetica-Bold"),
                ("FONTNAME", (2, 0), (2, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 9),
                ("TEXTCOLOR", (0, 0), (-1, -1), _CN_NAVY),
                # Signature lines (bottom border on the value cells)
                ("LINEBELOW", (1, 0), (1, 0), 0.7, _CN_NAVY),
                ("LINEBELOW", (3, 0), (3, 0), 0.7, _CN_NAVY),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ]
        )
    )
    story.append(sig_t)

    doc.build(story)
    return buf.getvalue()


def _keyvalue_style() -> TableStyle:
    return TableStyle(
        [
            ("BACKGROUND", (0, 0), (0, -1), _CN_LIGHT),
            ("FONTNAME", (0, 0), (0, -1), "Helvetica-Bold"),
            ("TEXTCOLOR", (0, 0), (0, -1), _CN_NAVY),
            ("FONTSIZE", (0, 0), (-1, -1), 9),
            ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
            ("LEFTPADDING", (0, 0), (-1, -1), 6),
            ("RIGHTPADDING", (0, 0), (-1, -1), 6),
            ("TOPPADDING", (0, 0), (-1, -1), 4),
            ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
            ("BOX", (0, 0), (-1, -1), 0.5, colors.HexColor("#CBD5E1")),
            ("INNERGRID", (0, 0), (-1, -1), 0.25, colors.HexColor("#E2E8F0")),
        ]
    )
