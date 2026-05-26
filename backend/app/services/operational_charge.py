"""Operational charge calculator — monthly fixed fee per customer.

Port of CN-BILLING/src/operational-charge.js. Tier-based with itemized
component breakdown so the invoice shows what the fee covers.

Tiers (key, threshold, monthly):
  small        ≤50 SKUs / 200 orders/mo / 5 containers/mo   → $300
  medium       ≤200 SKUs / 1k orders/mo / 20 containers/mo  → $750
  large        ≤500 SKUs / 5k orders/mo / 50 containers/mo  → $1500
  enterprise   everything above                              → $3000

Add-ons: hazmat ($150), drayage ($100) — additive on top of tier base.

Each tier's components MUST sum to its monthly total (sanity-checked at
module import). Edit the tables to change pricing.

The breakdown shows on the customer-facing invoice as itemized
sub-lines under "Account & Operations Management" — psychology choice
from the spec: several small named services read better than one lump
sum.
"""
from __future__ import annotations

import math
from typing import Any


TIERS: list[dict[str, Any]] = [
    {
        "key": "small",
        "label": "Small Account",
        "max_skus": 50,
        "max_orders": 200,
        "max_containers": 5,
        "monthly": 300,
        "components": [
            {"label": "Dedicated account coordinator", "monthly": 100},
            {"label": "Systems access — WMS & EDI portal", "monthly": 80},
            {"label": "Compliance & documentation", "monthly": 50},
            {"label": "Operational standby capacity", "monthly": 70},
        ],
    },
    {
        "key": "medium",
        "label": "Medium Account",
        "max_skus": 200,
        "max_orders": 1000,
        "max_containers": 20,
        "monthly": 750,
        "components": [
            {"label": "Dedicated account coordinator", "monthly": 250},
            {"label": "Systems access — WMS, EDI & reporting", "monthly": 200},
            {"label": "Compliance & documentation", "monthly": 100},
            {"label": "Operational standby capacity", "monthly": 150},
            {"label": "Customer service & inquiries", "monthly": 50},
        ],
    },
    {
        "key": "large",
        "label": "Large Account",
        "max_skus": 500,
        "max_orders": 5000,
        "max_containers": 50,
        "monthly": 1500,
        "components": [
            {"label": "Senior account manager", "monthly": 500},
            {"label": "Multi-system integration & reporting", "monthly": 400},
            {"label": "Compliance program management", "monthly": 200},
            {"label": "Priority operational standby", "monthly": 300},
            {"label": "Dedicated customer service tier", "monthly": 100},
        ],
    },
    {
        "key": "enterprise",
        "label": "Enterprise Account",
        "max_skus": math.inf,
        "max_orders": math.inf,
        "max_containers": math.inf,
        "monthly": 3000,
        "components": [
            {"label": "Strategic account team", "monthly": 1000},
            {"label": "Enterprise systems integration", "monthly": 800},
            {"label": "Compliance & audit support", "monthly": 400},
            {"label": "Priority operational capacity", "monthly": 600},
            {"label": "24/7 customer service tier", "monthly": 200},
        ],
    },
]


# Sanity check at module load — catches typos in the tables before they ship.
for _t in TIERS:
    _sum = sum(c["monthly"] for c in _t["components"])
    if _sum != _t["monthly"]:
        raise ValueError(
            f"Operational charge config error: {_t['label']} "
            f"components total ${_sum} but tier monthly is ${_t['monthly']}"
        )


ADDONS: list[dict[str, Any]] = [
    {"key": "hazmat", "label": "Hazmat handling premium", "monthly": 150,
     "when": lambda m: m.get("hazmat")},
    {"key": "drayage", "label": "Drayage operations premium", "monthly": 100,
     "when": lambda m: m.get("drayage")},
]


def metrics_from_profile(profile: dict | None) -> dict[str, Any]:
    """Extract the metrics the tier picker needs from a customer
    profile_json. Returns zeros / False when sections are missing."""
    p = profile or {}
    annual_orders = float((p.get("outbound") or {}).get("annual_orders") or 0)
    return {
        "skus": int((p.get("storage") or {}).get("total_skus") or 0),
        "orders": round(annual_orders / 12),
        "annual_orders": annual_orders,
        "containers": int((p.get("drayage") or {}).get("containers_per_month") or 0),
        "hazmat": (p.get("storage") or {}).get("hazmat") == "Y",
        "drayage": (p.get("drayage") or {}).get("required") == "Y",
    }


def pick_tier(m: dict) -> dict:
    """First tier where ALL three caps are not exceeded. Falls back to
    enterprise if every smaller tier is exceeded."""
    for t in TIERS:
        if (
            m["skus"] <= t["max_skus"]
            and m["orders"] <= t["max_orders"]
            and m["containers"] <= t["max_containers"]
        ):
            return t
    return TIERS[-1]


def calculate(profile: dict | None) -> dict:
    """Returns a structured tier + components + addons + monthly +
    rendered breakdown strings. Use the dict on the invoice
    operational_charge_breakdown column."""
    m = metrics_from_profile(profile)
    tier = pick_tier(m)
    components = [{"label": c["label"], "monthly": c["monthly"]} for c in tier["components"]]
    addons = [
        {"key": a["key"], "label": a["label"], "monthly": a["monthly"]}
        for a in ADDONS
        if a["when"](m)
    ]
    addon_total = sum(a["monthly"] for a in addons)
    monthly = tier["monthly"] + addon_total
    breakdown = [
        f"Tier: {tier['label']} (base ${tier['monthly']:.2f})",
        f"Metrics: {m['skus']} SKUs · {m['orders']} orders/mo · {m['containers']} containers/mo",
        *[f"  {c['label']}: ${c['monthly']:.2f}" for c in components],
        *[f"+ {a['label']}: ${a['monthly']:.2f}" for a in addons],
        f"Calculated monthly: ${monthly:.2f}",
    ]
    return {
        "tier": tier["label"],
        "tier_key": tier["key"],
        "base": tier["monthly"],
        "components": components,
        "addons": addons,
        "addon_total": addon_total,
        "monthly": monthly,
        "metrics": m,
        "breakdown": breakdown,
    }


def snapshot_for_invoice(profile: dict | None, effective_monthly: float) -> dict:
    """Snapshot of the breakdown to store on the invoice. If the
    customer has a manual override (effective_monthly differs from
    calculated), the snapshot is a single 'per agreement' line — no
    component leakage of an override into the customer's view."""
    calc = calculate(profile)
    is_override = abs(effective_monthly - calc["monthly"]) > 0.01
    if is_override:
        return {
            "tier_label": "Custom rate per agreement",
            "items": [
                {
                    "label": "Operational Service Fee (per agreement)",
                    "monthly": float(effective_monthly),
                },
            ],
            "total": float(effective_monthly),
        }
    return {
        "tier_label": calc["tier"],
        "items": [
            *calc["components"],
            *[{"label": a["label"], "monthly": a["monthly"]} for a in calc["addons"]],
        ],
        "total": calc["monthly"],
    }
