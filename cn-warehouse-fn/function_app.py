import json, os, csv, io
import azure.functions as func
from azure.storage.blob import BlobClient, ContentSettings

app = func.FunctionApp(http_auth_level=func.AuthLevel.FUNCTION)

HEADERS = ["container_no","whpo_number","expected_arrival_date",
           "expected_arrival_time","qty","product_type","sku","customer",
           "do_number","submitter_name","submitter_email","submitted_at",
           "driver_name","driver_license","driver_phone",
           "truck_license_plate","insurance","carrier","last_updated_at",
           "bol_number"]  # column 20 — keep in sync with backend HEADERS

@app.route(route="AppendInbound", methods=["POST"])
def append_inbound(req: func.HttpRequest) -> func.HttpResponse:
    rows = req.get_json().get("rows", [])
    blob = BlobClient.from_connection_string(
        os.environ["AzureWebJobsStorage"],
        container_name="inbound", blob_name="inbound.csv",
    )
    try:
        existing = blob.download_blob().readall().decode()
    except Exception:
        buf = io.StringIO(); csv.writer(buf).writerow(HEADERS); existing = buf.getvalue()
    out = io.StringIO(); out.write(existing.rstrip("\n") + "\n")
    w = csv.writer(out)
    for r in rows: w.writerow(r)
    blob.upload_blob(out.getvalue(), overwrite=True,
                     content_settings=ContentSettings(content_type="text/csv"))
    return func.HttpResponse(json.dumps({"appended": len(rows)}),
                             mimetype="application/json")