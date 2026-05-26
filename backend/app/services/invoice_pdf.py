"""Invoice PDF generation. Two formats:

  generate_customer_invoice_pdf  — summary view sent to the customer.
                                   Charges grouped by category, no per-
                                   line detail. Single page for typical
                                   invoices. CN-branded black header
                                   band.

  generate_service_log_pdf        — full line-item backup for AP teams
                                   that need to verify each charge.
                                   Lists every InvoiceLine with code +
                                   description + qty + rate + total.

Both formats share the header / customer block / totals layout for
consistency. Spirit-faithful to CN-BILLING/src/pdf-invoice.js but
written in reportlab (already in the prod requirements.txt for the
tally PDF feature).
"""
from __future__ import annotations

import io
import logging
from collections import defaultdict
from datetime import date, datetime
from typing import Iterable

from reportlab.lib import colors
from reportlab.lib.pagesizes import letter
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import inch
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

from app.models import Customer, Invoice, InvoiceLine

logger = logging.getLogger(__name__)


# Company info — hardcoded defaults for Phase 1 (CN-BILLING reads these
# from a `settings` key/value table; Phase 2 we add a Settings page that
# overrides these via the customers / accounts admin).
COMPANY_NAME = "Conquer Nation Inc."
COMPANY_ADDRESS = "Vernon, CA"
COMPANY_EMAIL = "billing@conquernation.com"
PAYMENT_INSTRUCTIONS = (
    'ACH preferred. Check payable to "Conquer Nation Inc." '
    "Wire details available on request."
)
TERMS_FOOTER = (
    "Payment due within payment terms. 1.5% per month (18% APR) late "
    "fee applies to past-due balances. Disputes must be submitted in "
    "writing within 30 days of invoice date."
)

# Brand colors (memory file: cyan #0093D0 / navy #1B4676 / yellow #FED641).
_BLACK = colors.HexColor("#000000")
_INK = colors.HexColor("#111111")
_BODY = colors.HexColor("#3A3A3A")
_MUTED = colors.HexColor("#8A8A8A")
_RULE = colors.HexColor("#E2E2E2")
_PANEL = colors.HexColor("#FAFAFA")
_WHITE = colors.HexColor("#FFFFFF")

# Canonical category labels for grouping on the customer-facing invoice.
CATEGORY_DISPLAY = {
    "DRAYAGE": "Container Drayage",
    "HANDLING": "Handling",
    "PUTAWAY": "Put-Away & Sortation",
    "STORAGE": "Warehouse Storage",
    "ORDER_PROC": "Order Processing",
    "PICKING": "Pick & Pack",
    "BOL_SHIP": "Documentation & Labels",
    "LABOR": "On-Demand Labor",
    "ACCESSORIAL": "Specialized Services",
    "IT": "Technology Services",
    "MDS": "Regulatory Filings",
}
CATEGORY_ORDER = [
    "DRAYAGE", "HANDLING", "PUTAWAY", "STORAGE", "ORDER_PROC",
    "PICKING", "BOL_SHIP", "LABOR", "ACCESSORIAL", "IT", "MDS",
]


def _money(n: float | int | None) -> str:
    return f"${(n or 0):,.2f}"


def _fmt_date(d: date | datetime | None) -> str:
    if d is None:
        return "—"
    if isinstance(d, datetime):
        d = d.date()
    return d.strftime("%b %d, %Y")


def _header_band(canvas, doc, *, invoice_number: str):
    """Draws the black CN-branded header band on every page."""
    canvas.saveState()
    page_w, page_h = letter
    band_h = 100
    canvas.setFillColor(_BLACK)
    canvas.rect(0, page_h - band_h, page_w, band_h, stroke=0, fill=1)
    # Wordmark
    canvas.setFillColor(_WHITE)
    canvas.setFont("Helvetica-Bold", 14)
    canvas.drawString(0.5 * inch, page_h - 50, "CONQUER NATION")
    canvas.setFont("Helvetica", 8)
    canvas.setFillColor(colors.HexColor("#AAAAAA"))
    canvas.drawString(0.5 * inch, page_h - 64, "YOUR FULFILLMENT PARTNER")
    # Invoice block on the right
    canvas.setFillColor(colors.HexColor("#AAAAAA"))
    canvas.setFont("Helvetica", 8)
    canvas.drawRightString(page_w - 0.5 * inch, page_h - 36, "INVOICE")
    canvas.setFillColor(_WHITE)
    canvas.setFont("Helvetica-Bold", 18)
    canvas.drawRightString(page_w - 0.5 * inch, page_h - 60, invoice_number)
    canvas.restoreState()


def _build_styles():
    base = getSampleStyleSheet()
    return {
        "label": ParagraphStyle(
            "Label",
            parent=base["Normal"],
            fontSize=8,
            textColor=_MUTED,
            spaceAfter=2,
        ),
        "value": ParagraphStyle(
            "Value",
            parent=base["Normal"],
            fontSize=11,
            textColor=_INK,
            spaceAfter=2,
            leading=14,
        ),
        "h2": ParagraphStyle(
            "H2",
            parent=base["Heading2"],
            fontSize=10,
            textColor=_BLACK,
            spaceBefore=12,
            spaceAfter=6,
            leading=12,
        ),
        "body": ParagraphStyle(
            "Body",
            parent=base["Normal"],
            fontSize=10,
            textColor=_BODY,
            leading=13,
        ),
        "footer": ParagraphStyle(
            "Footer",
            parent=base["Normal"],
            fontSize=8,
            textColor=_MUTED,
            leading=10,
        ),
    }


def _customer_address_lines(profile: dict | None) -> list[str]:
    out: list[str] = []
    if not profile:
        return out
    company = profile.get("company") or {}
    if company.get("contact_name"):
        out.append(company["contact_name"])
    ba = company.get("billing_address") or {}
    if ba.get("street"):
        out.append(ba["street"])
    city_parts = [ba.get("city"), ba.get("state"), ba.get("zip")]
    city_line = ", ".join(p for p in city_parts if p)
    if city_line:
        out.append(city_line)
    return out


def _meta_row(styles, *, invoice: Invoice) -> Table:
    """ISSUED | DUE | TERMS three-column row."""
    cell_w = (letter[0] - 1.0 * inch) / 3
    rows = [
        [
            Paragraph("ISSUED", styles["label"]),
            Paragraph("DUE", styles["label"]),
            Paragraph("TERMS", styles["label"]),
        ],
        [
            Paragraph(_fmt_date(invoice.invoice_date), styles["value"]),
            Paragraph(_fmt_date(invoice.due_date), styles["value"]),
            Paragraph(invoice.terms or "Net 30", styles["value"]),
        ],
    ]
    t = Table(rows, colWidths=[cell_w] * 3)
    t.setStyle(
        TableStyle(
            [
                ("BOTTOMPADDING", (0, 0), (-1, -1), 2),
                ("TOPPADDING", (0, 0), (-1, -1), 0),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
            ]
        )
    )
    return t


def _prepared_for_block(styles, *, customer: Customer, invoice: Invoice, lines: list[InvoiceLine]) -> Table:
    """Two columns: customer info | service period."""
    cell_w = (letter[0] - 1.0 * inch - 0.4 * inch) / 2

    left = [Paragraph("PREPARED FOR", styles["label"])]
    left.append(Paragraph(customer.name, styles["value"]))
    for line in _customer_address_lines(customer.profile_json or {}):
        left.append(Paragraph(line, styles["body"]))
    left.append(Paragraph(f"Account #{customer.id}", styles["footer"]))

    right = [Paragraph("SERVICE PERIOD", styles["label"])]
    right.append(
        Paragraph(_fmt_date(invoice.invoice_date), styles["value"])
    )
    right.append(
        Paragraph(
            f"{len(lines)} charge line{'s' if len(lines) != 1 else ''}",
            styles["body"],
        )
    )

    t = Table([[left, right]], colWidths=[cell_w, cell_w])
    t.setStyle(
        TableStyle(
            [
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 0),
                ("RIGHTPADDING", (0, 0), (-1, -1), 0),
            ]
        )
    )
    return t


def _category_summary_table(styles, lines: list[InvoiceLine]) -> Table:
    """One row per category with subtotal — for the customer-facing
    PDF. No per-line breakdown."""
    by_cat: dict[str, float] = defaultdict(float)
    for line in lines:
        if line.code in ("PIK-MIN",):
            # Bundle minimum into PICKING
            by_cat[line.category] += line.line_total
            continue
        by_cat[line.category] += line.line_total

    rows = [["Service category", "Subtotal"]]
    for key in CATEGORY_ORDER:
        if key in by_cat and by_cat[key] > 0:
            rows.append([CATEGORY_DISPLAY.get(key, key), _money(by_cat[key])])
    if len(rows) == 1:
        rows.append(["No charges yet", ""])

    t = Table(rows, colWidths=[4.5 * inch, 1.5 * inch])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), _PANEL),
                ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("TEXTCOLOR", (0, 0), (-1, -1), _INK),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, _BLACK),
                ("LINEBELOW", (0, 1), (-1, -1), 0.25, _RULE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return t


def _operational_breakdown_table(styles, invoice: Invoice) -> Table | None:
    """Itemised Account & Operations Management — only renders when
    the invoice has a breakdown JSON snapshot."""
    bd = invoice.operational_charge_breakdown
    if not bd or not isinstance(bd, dict) or not bd.get("items"):
        return None
    rows = [[Paragraph(bd.get("tier_label") or "Account & Operations Management", styles["h2"]), ""]]
    for item in bd["items"]:
        rows.append([item["label"], _money(item["monthly"])])
    t = Table(rows, colWidths=[4.5 * inch, 1.5 * inch])
    t.setStyle(
        TableStyle(
            [
                ("BACKGROUND", (0, 0), (-1, 0), _PANEL),
                ("FONTSIZE", (0, 1), (-1, -1), 9),
                ("TEXTCOLOR", (0, 0), (-1, -1), _INK),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("LINEBELOW", (0, 0), (-1, 0), 0.6, _BLACK),
                ("LINEBELOW", (0, 1), (-1, -2), 0.25, _RULE),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
            ]
        )
    )
    return t


def _totals_table(styles, invoice: Invoice) -> Table:
    rows = []
    rows.append(["Subtotal (services)", _money(invoice.subtotal - (invoice.operational_charge or 0))])
    if invoice.operational_charge:
        rows.append(["Account & Operations Management", _money(invoice.operational_charge)])
    if invoice.fuel_surcharge:
        rows.append(["Fuel surcharge (included above)", _money(invoice.fuel_surcharge)])
    if invoice.advancing:
        rows.append(["Advancing fees (included above)", _money(invoice.advancing)])
    if invoice.adjustment:
        rows.append([invoice.adjustment_note or "Adjustment", _money(invoice.adjustment)])
    if invoice.tax:
        rows.append(["Tax (CA)", _money(invoice.tax)])
    rows.append(["TOTAL DUE", _money(invoice.total)])

    t = Table(rows, colWidths=[4.5 * inch, 1.5 * inch])
    t.setStyle(
        TableStyle(
            [
                ("FONTSIZE", (0, 0), (-1, -1), 10),
                ("TEXTCOLOR", (0, 0), (-1, -1), _BODY),
                ("ALIGN", (1, 0), (1, -1), "RIGHT"),
                ("LINEABOVE", (0, -1), (-1, -1), 1.5, _BLACK),
                ("FONTNAME", (0, -1), (-1, -1), "Helvetica-Bold"),
                ("FONTSIZE", (0, -1), (-1, -1), 13),
                ("TEXTCOLOR", (0, -1), (-1, -1), _BLACK),
                ("LEFTPADDING", (0, 0), (-1, -1), 8),
                ("RIGHTPADDING", (0, 0), (-1, -1), 8),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]
        )
    )
    return t


def _line_item_table(styles, lines: list[InvoiceLine]) -> Table:
    """Full line-by-line table for the Service Log PDF."""
    by_cat: dict[str, list[InvoiceLine]] = defaultdict(list)
    for line in lines:
        by_cat[line.category].append(line)

    rows: list[list] = [["Code", "Description", "Qty", "Unit rate", "Total"]]
    for cat_key in CATEGORY_ORDER:
        cat_lines = by_cat.get(cat_key, [])
        if not cat_lines:
            continue
        rows.append([CATEGORY_DISPLAY.get(cat_key, cat_key), "", "", "", ""])
        cat_subtotal = 0.0
        for ln in cat_lines:
            rows.append(
                [
                    ln.code,
                    ln.description,
                    f"{ln.quantity:g}",
                    _money(ln.unit_rate),
                    _money(ln.line_total),
                ]
            )
            cat_subtotal += ln.line_total
        rows.append(["", f"Subtotal — {CATEGORY_DISPLAY.get(cat_key, cat_key)}", "", "", _money(cat_subtotal)])

    t = Table(
        rows,
        colWidths=[0.85 * inch, 3.05 * inch, 0.6 * inch, 0.85 * inch, 0.85 * inch],
    )
    style_cmds = [
        ("FONTSIZE", (0, 0), (-1, -1), 8.5),
        ("TEXTCOLOR", (0, 0), (-1, -1), _BODY),
        ("BACKGROUND", (0, 0), (-1, 0), _PANEL),
        ("FONTNAME", (0, 0), (-1, 0), "Helvetica-Bold"),
        ("LINEBELOW", (0, 0), (-1, 0), 0.6, _BLACK),
        ("ALIGN", (2, 0), (-1, -1), "RIGHT"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 3),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
    ]
    # Bold category headers + subtotal rows. Inspect each row to find them.
    for i, row in enumerate(rows):
        if i == 0:
            continue
        if row[1] == "" and row[0] in CATEGORY_DISPLAY.values():
            style_cmds.append(("FONTNAME", (0, i), (-1, i), "Helvetica-Bold"))
            style_cmds.append(("TEXTCOLOR", (0, i), (-1, i), _BLACK))
        if row[1].startswith("Subtotal — "):
            style_cmds.append(("FONTNAME", (0, i), (-1, i), "Helvetica-Oblique"))
            style_cmds.append(("LINEBELOW", (0, i), (-1, i), 0.4, _RULE))
    t.setStyle(TableStyle(style_cmds))
    return t


def _build_doc(buf: io.BytesIO, *, invoice_number: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        buf,
        pagesize=letter,
        leftMargin=0.5 * inch,
        rightMargin=0.5 * inch,
        topMargin=1.55 * inch,  # space for the header band (100pt) + breathing room
        bottomMargin=0.6 * inch,
        title=f"Invoice {invoice_number}",
        author=COMPANY_NAME,
    )


def _on_page(invoice_number: str):
    def _draw(canvas, doc):
        _header_band(canvas, doc, invoice_number=invoice_number)
    return _draw


def _footer_block(styles) -> list:
    return [
        Spacer(1, 16),
        Paragraph(f"Remit to: {COMPANY_NAME} — {COMPANY_EMAIL}", styles["footer"]),
        Paragraph(PAYMENT_INSTRUCTIONS, styles["footer"]),
        Spacer(1, 6),
        Paragraph(TERMS_FOOTER, styles["footer"]),
    ]


def generate_customer_invoice_pdf(
    invoice: Invoice,
    customer: Customer,
    lines: Iterable[InvoiceLine],
) -> bytes:
    """Clean summary PDF for the customer. Charges grouped by category;
    no per-line detail. Single page for typical invoices."""
    buf = io.BytesIO()
    doc = _build_doc(buf, invoice_number=invoice.invoice_number)
    styles = _build_styles()
    lines = list(lines)

    story: list = [
        _meta_row(styles, invoice=invoice),
        Spacer(1, 14),
        _prepared_for_block(styles, customer=customer, invoice=invoice, lines=lines),
        Spacer(1, 16),
        Paragraph("CHARGES SUMMARY", styles["label"]),
        Spacer(1, 4),
        _category_summary_table(styles, lines),
    ]
    op_table = _operational_breakdown_table(styles, invoice)
    if op_table is not None:
        story.extend([Spacer(1, 12), op_table])

    story.extend(
        [
            Spacer(1, 14),
            _totals_table(styles, invoice),
            *_footer_block(styles),
        ]
    )

    doc.build(
        story,
        onFirstPage=_on_page(invoice.invoice_number),
        onLaterPages=_on_page(invoice.invoice_number),
    )
    return buf.getvalue()


def generate_service_log_pdf(
    invoice: Invoice,
    customer: Customer,
    lines: Iterable[InvoiceLine],
) -> bytes:
    """Full line-item backup PDF. Sent to AP teams that need to verify
    each charge. Lists every InvoiceLine grouped by category."""
    buf = io.BytesIO()
    doc = _build_doc(buf, invoice_number=invoice.invoice_number)
    styles = _build_styles()
    lines = list(lines)

    story: list = [
        _meta_row(styles, invoice=invoice),
        Spacer(1, 14),
        _prepared_for_block(styles, customer=customer, invoice=invoice, lines=lines),
        Spacer(1, 14),
        Paragraph("SERVICE LOG — ITEMISED CHARGES", styles["label"]),
        Spacer(1, 4),
        _line_item_table(styles, lines),
    ]
    op_table = _operational_breakdown_table(styles, invoice)
    if op_table is not None:
        story.extend([Spacer(1, 10), op_table])

    story.extend(
        [
            Spacer(1, 14),
            _totals_table(styles, invoice),
            *_footer_block(styles),
        ]
    )

    doc.build(
        story,
        onFirstPage=_on_page(invoice.invoice_number),
        onLaterPages=_on_page(invoice.invoice_number),
    )
    return buf.getvalue()
