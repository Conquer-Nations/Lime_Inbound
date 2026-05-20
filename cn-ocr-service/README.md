# cn-ocr-service

Standalone FastAPI service that exposes **EasyOCR** for container plate
photos. Designed to run on **Azure Container Apps** with scale-to-zero,
so the main App Service stays lean (~150 MB) while OCR — which needs
torch + the EasyOCR model files (~1.5 GB total) — lives in its own
image.

The frontend operator portal posts a plate photo to
`{OCR_BASE}/container-photo` and gets back ISO 6346 candidates with
check-digit validation.

---

## Contract

| Method | Path                | Body                              | Returns                                                                   |
|--------|---------------------|-----------------------------------|---------------------------------------------------------------------------|
| GET    | `/health`           | —                                 | `{"status":"ok","service":"cn-ocr-service"}`                              |
| POST   | `/container-photo`  | multipart `photo=<image file>`    | `{"candidates":[{"value","check_digit_valid","source"},...],"raw_text"}`  |

Byte-identical to the main backend's `/ocr/container-photo` — the
frontend `CameraOcr` component works against either URL without code
change.

---

## Local smoke test

```bash
cd cn-ocr-service
docker build -t cn-ocr-service:dev .
docker run --rm -p 8080:8080 cn-ocr-service:dev

# In another terminal:
curl http://localhost:8080/health
# → {"status":"ok","service":"cn-ocr-service"}

curl -X POST http://localhost:8080/container-photo \
  -F 'photo=@/path/to/container_plate.jpg'
# → {"candidates":[{"value":"HPCU4492096",...}], "raw_text":"..."}
```

First container start downloads + caches the EasyOCR English model
(baked into the image at build time, so this is just a re-load from
disk — typically <2s).

---

## Deploy to Azure Container Apps

You need: Azure CLI logged in to the same subscription as the main
`cn-warehouse-backend` App Service. ~10 minutes start-to-finish.

### 1. Create an Azure Container Registry (one-time, ~1 min)

If you don't already have one:

```bash
az acr create \
  --resource-group cn-warehouse-rg \
  --name cnwarehouseacr \
  --sku Basic \
  --location centralus
```

The name must be globally unique — pick something distinct if
`cnwarehouseacr` is taken.

### 2. Build + push the image (~5 min)

Two options. Use **A** if you don't have Docker installed locally;
otherwise **B** is faster.

**A. Cloud build (no local Docker)**

```bash
cd cn-ocr-service
az acr build \
  --registry cnwarehouseacr \
  --image cn-ocr-service:v1 \
  --file Dockerfile .
```

Azure builds the image in the cloud and stores it as
`cnwarehouseacr.azurecr.io/cn-ocr-service:v1`.

**B. Local build + push**

```bash
cd cn-ocr-service
docker build -t cnwarehouseacr.azurecr.io/cn-ocr-service:v1 .
az acr login --name cnwarehouseacr
docker push cnwarehouseacr.azurecr.io/cn-ocr-service:v1
```

### 3. Create a Container Apps environment (one-time, ~1 min)

```bash
az containerapp env create \
  --name cn-warehouse-env \
  --resource-group cn-warehouse-rg \
  --location centralus
```

### 4. Deploy the Container App (~2 min)

```bash
az containerapp create \
  --name cn-ocr-service \
  --resource-group cn-warehouse-rg \
  --environment cn-warehouse-env \
  --image cnwarehouseacr.azurecr.io/cn-ocr-service:v1 \
  --target-port 8080 \
  --ingress external \
  --registry-server cnwarehouseacr.azurecr.io \
  --cpu 1 --memory 2Gi \
  --min-replicas 0 --max-replicas 2 \
  --env-vars "CORS_ORIGINS=https://black-grass-0bb650210.7.azurestaticapps.net"
```

Notes on the flags:
- `--ingress external` → public HTTPS URL (Container Apps takes care of TLS).
- `--target-port 8080` → matches the `EXPOSE 8080` in the Dockerfile.
- `--cpu 1 --memory 2Gi` → enough for EasyOCR. Torch's CPU model uses
  ~1.2 GB resident RAM. Smaller plans (`0.5 / 1Gi`) often OOM on the
  first inference.
- `--min-replicas 0` → scale-to-zero. Cost ≈ $0 when idle; first scan
  after idle takes ~15 seconds to spin up a replica.
- `--max-replicas 2` → soft cap. Operator volume is ~20–40 photos/day,
  so 1 replica is fine; keep 2 in case of a burst.
- `CORS_ORIGINS` → must match your SWA origin **exactly**, no trailing
  slash. Multiple origins are comma-separated; `*` disables the
  whitelist (don't use in prod).

The command prints the public URL when it completes:

```
{
  "properties": {
    "configuration": {
      "ingress": {
        "fqdn": "cn-ocr-service.icyrock-12345abc.centralus.azurecontainerapps.io"
      }
    }
  }
}
```

### 5. Set `VITE_OCR_BASE` on the SWA

The frontend needs to know where to send photos. Add the env var to
the SWA's build environment:

1. Open the `.github/workflows/azure-static-web-apps-*.yml` workflow.
2. In the `env:` block of the `build_and_deploy_job`, add:
   ```yaml
   VITE_OCR_BASE: https://cn-ocr-service.<the-fqdn-from-step-4>.azurecontainerapps.io
   ```
3. Commit + push. The SWA Action rebuilds with the new value baked in.

Same path used today for `VITE_API_BASE`. No SWA redeploy outside of
the normal Action.

### 6. Verify

```bash
curl https://cn-ocr-service.<fqdn>/health
# → {"status":"ok","service":"cn-ocr-service"}
```

Once the frontend's been redeployed, the operator's Container Intake
screen shows the **Take container photo** button at the top.

---

## Updating the image

```bash
cd cn-ocr-service
# Edit code...
az acr build --registry cnwarehouseacr --image cn-ocr-service:v2 --file Dockerfile .
az containerapp update --name cn-ocr-service --resource-group cn-warehouse-rg \
  --image cnwarehouseacr.azurecr.io/cn-ocr-service:v2
```

Container Apps does a rolling restart automatically. Zero downtime
because the old replica keeps serving until the new one passes the
`/health` probe.

---

## Rolling back / disabling

To turn off OCR temporarily without touching the deploy: just unset
`VITE_OCR_BASE` in the SWA workflow and push. The frontend hides the
photo button and operators continue with manual entry. The Container
App keeps running (idle, scale-to-zero, ~$0/mo) until you delete it:

```bash
az containerapp delete --name cn-ocr-service --resource-group cn-warehouse-rg --yes
```

The image stays in ACR — re-create at any time without rebuilding.

---

## Cost expectations

- Idle (no requests): ~$0/mo on scale-to-zero (you only pay for the
  Container App env's quota: ~$10/mo minimum for the environment,
  shared across any Container Apps you put in it).
- Active: ~$0.02 per OCR request at typical dock photo volumes
  (10–30 photos/day, each ~1s of compute).
- Total expected: **$10–25/mo** depending on how many other Container
  Apps share the environment.

If cost becomes a concern, the alternative is to upgrade the main
App Service plan to one that can host torch (~$70/mo Premium V2 P1V2)
and merge this service back into the backend. Container App is the
cheaper path until you have other compute needs.
