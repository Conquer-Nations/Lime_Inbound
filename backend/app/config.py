from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://localhost/cn_warehouse"
    cors_origins: list[str] = ["http://localhost:5173"]

    # Lot-assignment algorithm tuning
    standard_pallet_sqft: float = 16.0

    # Webhooks for downstream sinks. Both are HTTPS endpoints (Logic App,
    # Function App, Power Automate, etc.) that accept {"rows": [[...], ...]}.
    # Either / both / neither can be set. We POST to every URL that's set.
    inbound_webhook_url: str = ""  # primary sink (e.g. Function App → Blob CSV)
    onedrive_webhook_url: str = ""  # secondary sink (e.g. Logic App → OneDrive Excel APPEND)
    # Driver-info updates target this webhook instead — expected to UPDATE rows
    # in place (matching by whpo_number) rather than append duplicates.
    onedrive_update_webhook_url: str = ""
    inbound_webhook_secret: str = ""  # optional, sent as X-CN-Secret header

    # OPTIONAL alternative: Microsoft Graph app-only auth (needs an Entra ID
    # app registration, which student tenants often can't create). If you have
    # one, fill these and the backend posts directly to Graph instead of the
    # webhook above. Otherwise leave blank.
    ms_tenant_id: str = ""
    ms_client_id: str = ""
    ms_client_secret: str = ""
    onedrive_user_upn: str = ""
    onedrive_file_path: str = "/CN-Warehouse-Inbound.xlsx"
    onedrive_table_name: str = "InboundTable"

    # Vendor self-service login — Excel is source of truth.
    # Webhook URL points at a Logic App that runs the `VendorUsersOps`
    # Office Script in the workbook. Backend POSTs {action, payload} to it.
    onedrive_vendors_ops_url: str = ""
    # HS256 secret for JWT-signed vendor sessions. Must be set to something
    # long & random in production. 24h token expiry by default.
    jwt_secret: str = "dev-change-me-in-production"
    jwt_expiry_hours: int = 24

    # Vendor document uploads — driver's license, insurance, registration, etc.
    # Files are stored on the backend filesystem. Path is relative to the
    # process working directory unless absolute.
    uploads_dir: str = "./uploads"
    # 15 MB cap per upload. Pi-/HEIC-heavy phones can push images larger than
    # the default 5 MB.
    upload_max_bytes: int = 15 * 1024 * 1024

    # OneDrive mirror for vendor-uploaded documents. A Logic App receives
    # {company, year, month, whpo, container, filename, content_type, data_b64}
    # and lays the file into:
    #   /Vendor Files/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container}/{kind}.{ext}
    # Leave blank to disable the mirror (files still save locally + Postgres).
    onedrive_vendor_files_url: str = ""
    # Root folder name inside OneDrive — change here if you rename the tree.
    onedrive_vendor_files_root: str = "Vendor Files"

    # ─── Local OneDrive sync (preferred — sidesteps Logic Apps entirely) ──
    # Absolute path to a folder INSIDE the OneDrive desktop sync directory.
    # The backend writes files directly to that path in the nested structure;
    # the OneDrive client handles the cloud upload + folder creation. Set this
    # to e.g.
    #   /Users/<you>/Library/CloudStorage/OneDrive-USC/Vendor Files
    # Leave blank to disable.
    onedrive_local_sync_dir: str = ""

    # ─── Microsoft Graph direct upload (no desktop client needed) ─────────
    # Pure cloud path: backend talks to OneDrive via Microsoft Graph using
    # an OAuth refresh token. One-time browser login required — run:
    #     python -m app.scripts.onedrive_login
    # to authorize. After that, the backend uses the saved refresh token
    # to push files to OneDrive at
    #     /{root}/{Company}/{YYYY}/{MM - Month}/WHPO {whpo}/{container}/{kind}.{ext}
    # via Graph PUT (which auto-creates intermediate folders).
    onedrive_graph_enabled: bool = False
    # OAuth public-client app ID. Default = the Azure CLI public-client app,
    # which works in most tenants without separate app registration. Override
    # if USC's Conditional Access blocks it.
    onedrive_graph_client_id: str = "04b07795-8ddb-461a-bbee-02f9e1bf7b46"
    # Authority — "common" works for multi-tenant. Use a specific tenant ID
    # (USC's) if Conditional Access requires it.
    onedrive_graph_tenant: str = "common"
    # Where the MSAL token cache lives on disk. Default = backend's working
    # directory. The file contains a refresh token — protect like a secret.
    onedrive_graph_cache_path: str = "./.onedrive_token_cache.json"
    # Root folder INSIDE the user's OneDrive where the tree lives. Default
    # = "Vendor Files" (created automatically by Graph PUT on first upload).
    onedrive_graph_root: str = "Vendor Files"

    # ─── Scan-sheet feature (Lime 3PL Inbound Receipt) ──────────────────
    # When True, exposes the operator scan-sheet flow + auditor endpoints.
    # Default off — flip to true ONLY after the OCR Container App URL is
    # set and a smoke test has run. Falls back gracefully when off.
    scan_sheets_enabled: bool = False
    # Comma-separated list of vendor emails (or whatever future SSO subject)
    # allowed to access /audit/* endpoints. Single-source-of-truth; trivial
    # to extend without code change.
    auditor_emails: list[str] = ["developer@conquernation.com"]
    # Separate Azure Container App hosting EasyOCR (torch ~1.5GB doesn't fit
    # on the main App Service plan). Operator's container-plate photo POSTs
    # to {URL}/container-photo and gets back candidate strings. Leave blank
    # to fall back to operator-typed container numbers (always works).
    ocr_service_url: str = ""

    # ─── rclone-based OneDrive upload (fallback when Graph apps are blocked)
    # rclone is a third-party file sync tool with its own pre-registered
    # multi-tenant Microsoft app. When USC blocks ALL Microsoft first-party
    # client IDs from accessing Graph, rclone often still works because it
    # registers as a third-party app.
    #
    # One-time setup: `brew install rclone`, then `rclone config` to add a
    # OneDrive remote (named e.g. "onedrive"). The backend shells out to
    # the rclone binary for each upload / delete.
    onedrive_rclone_enabled: bool = False
    # Path to the rclone binary. Default = whatever's on $PATH.
    onedrive_rclone_binary: str = "rclone"
    # The remote name you set when running `rclone config`. NOT a path —
    # just the label, without the trailing colon. E.g. "onedrive".
    onedrive_rclone_remote: str = ""
    # Top-level folder INSIDE OneDrive where the tree lives.
    onedrive_rclone_root: str = "Vendor Files"


settings = Settings()
