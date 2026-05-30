#!/usr/bin/env python3
"""One-time bulk migration: vendor accounts from the OneDrive Excel store
into the Postgres `vendor_users` table.

Vendor logins used to read the Excel workbook (via the Excel Online
connector) on every request, which drained the connector's daily call
quota and locked the portal out. Auth now lives in Postgres; this script
moves the existing accounts over in ONE connector call (a single `list`)
so the portal stops depending on Excel immediately, instead of waiting for
each account to migrate itself lazily on next login.

Default mode is DRY-RUN — prints what would be inserted and exits without
writing. Re-run with --commit to actually insert.

Idempotent: skips any email that already exists in `vendor_users`. Safe to
re-run; it only ever adds missing accounts.

Reads the same env the app uses (DATABASE_URL, ONEDRIVE_VENDORS_OPS_URL),
so run it where those are set — e.g. the App Service SSH console
(`cd /home/site/wwwroot && python scripts/migrate_vendor_users_to_pg.py`)
or locally with backend/.env loaded.

Usage:
    python scripts/migrate_vendor_users_to_pg.py            # dry-run
    python scripts/migrate_vendor_users_to_pg.py --commit   # write
"""
from __future__ import annotations

import argparse
import asyncio
from datetime import datetime, timezone

from app.db import SessionLocal
from app.services import vendor_excel, vendor_users


def _parse_iso(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        dt = datetime.fromisoformat(str(value).strip())
    except (ValueError, AttributeError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt


async def run(commit: bool) -> int:
    if not vendor_excel.is_configured():
        print("ERROR: ONEDRIVE_VENDORS_OPS_URL is not configured — nothing to "
              "read from Excel.")
        return 1

    print("Reading vendor accounts from Excel (single connector call)…")
    excel_rows = await vendor_excel.list_users(force_refresh=True)
    print(f"  Excel returned {len(excel_rows)} account(s).")

    to_insert: list[dict] = []
    skipped_existing = 0
    skipped_bad = 0

    async with SessionLocal() as session:
        for row in excel_rows:
            email = (row.get("email") or "").strip().lower()
            pwd_hash = row.get("password_hash") or ""
            if not email or not pwd_hash:
                skipped_bad += 1
                continue
            existing = await vendor_users.find_by_email(session, email)
            if existing is not None:
                skipped_existing += 1
                continue
            to_insert.append(row)

        print(f"\nPlan: {len(to_insert)} to insert, "
              f"{skipped_existing} already in Postgres, "
              f"{skipped_bad} skipped (missing email/hash).")
        for row in to_insert:
            print(f"  + {row.get('email')}  ({row.get('company') or '—'})")

        if not commit:
            print("\nDRY-RUN — no rows written. Re-run with --commit to apply.")
            return 0

        for row in to_insert:
            await vendor_users.create_user(
                session,
                email=(row.get("email") or "").strip().lower(),
                full_name=row.get("full_name") or "",
                company=row.get("company") or "",
                password_hash=row.get("password_hash") or "",
                registered_at=_parse_iso(row.get("registered_at")),
                last_login_at=_parse_iso(row.get("last_login_at")),
                migrated_from_excel=True,
            )
        await session.commit()
        print(f"\nDONE — inserted {len(to_insert)} account(s) into vendor_users.")
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument(
        "--commit",
        action="store_true",
        help="Actually write rows (default is dry-run).",
    )
    args = ap.parse_args()
    raise SystemExit(asyncio.run(run(args.commit)))


if __name__ == "__main__":
    main()
