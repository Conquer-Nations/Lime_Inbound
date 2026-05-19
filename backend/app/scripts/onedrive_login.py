"""One-time OneDrive (Microsoft Graph) device-code authorization.

Run this once, from the `backend/` directory, after enabling the Graph
upload path in your .env (set ONEDRIVE_GRAPH_ENABLED=true).

    cd backend
    python -m app.scripts.onedrive_login

Follow the printed instructions: open https://microsoft.com/devicelogin in
any browser, paste the displayed code, sign in with the OneDrive account
that should own the uploaded files (e.g. tvpinto@usc.edu). After success
the refresh token is saved to disk (path from ONEDRIVE_GRAPH_CACHE_PATH)
and the backend can upload files silently from then on.

Pass --check to see whether you're already signed in:

    python -m app.scripts.onedrive_login --check

Pass --logout to forget the saved token:

    python -m app.scripts.onedrive_login --logout
"""
from __future__ import annotations

import sys

from app.config import settings
from app.services import onedrive_graph


def main() -> int:
    argv = sys.argv[1:]

    if "--check" in argv:
        if not settings.onedrive_graph_enabled:
            print(
                "ONEDRIVE_GRAPH_ENABLED is false in .env — the Graph upload "
                "path is disabled. Set it to true to enable."
            )
            return 1
        upn = onedrive_graph.signed_in_account()
        if upn:
            print(f"✓ Signed in as: {upn}")
            print(f"  Token cache:  {onedrive_graph._cache_path()}")
            return 0
        print("✗ Not signed in. Run without --check to authorize.")
        return 1

    if "--logout" in argv:
        before = onedrive_graph.signed_in_account()
        onedrive_graph.sign_out()
        if before:
            print(f"Signed out of {before}. Run again (no flags) to re-authorize.")
        else:
            print("Already signed out.")
        return 0

    if not settings.onedrive_graph_enabled:
        print(
            "WARNING: ONEDRIVE_GRAPH_ENABLED is false in your .env. The "
            "device-code login will still run, but the backend won't actually "
            "use the saved token until you set the flag to true."
        )

    print("Starting OneDrive device-code login...")
    print(f"  Client ID:  {settings.onedrive_graph_client_id}")
    print(f"  Tenant:     {settings.onedrive_graph_tenant}")
    print(f"  Root folder: {settings.onedrive_graph_root}")
    print(f"  Token cache: {onedrive_graph._cache_path()}")
    print()

    try:
        result = onedrive_graph.device_code_login()
    except RuntimeError as e:
        print(f"\n✗ Login failed: {e}", file=sys.stderr)
        return 2

    claims = result.get("id_token_claims") or {}
    upn = claims.get("preferred_username") or claims.get("upn") or "(unknown)"
    print(f"\n✓ Signed in as: {upn}")
    print(f"  Token cache saved to: {onedrive_graph._cache_path()}")
    print("\nThe backend can now upload to OneDrive. Restart uvicorn if it's already running.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
