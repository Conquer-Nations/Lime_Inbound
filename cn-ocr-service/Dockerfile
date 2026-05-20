# Dockerfile for cn-ocr-service.
#
# Targets Azure Container Apps with scale-to-zero. Building locally:
#   docker build -t cn-ocr-service:dev .
#   docker run --rm -p 8080:8080 cn-ocr-service:dev
#   curl -s http://localhost:8080/health   # → {"status":"ok",...}
#
# Image size note: ~1.5 GB on disk. EasyOCR + torch (CPU) is the bulk;
# the GPU variant would be ~5 GB and isn't needed at the dock.

FROM python:3.12-slim AS base

WORKDIR /app

# OS deps needed at runtime by Pillow + opencv (easyocr pulls opencv-python-headless).
# libgl1 / libglib2.0-0 are the canonical "missing libGL.so" pair.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        libgl1 \
        libglib2.0-0 \
    && rm -rf /var/lib/apt/lists/*

# Install Python deps. Use the CPU torch index so we don't pull cuda binaries.
COPY requirements.txt .
RUN pip install --no-cache-dir \
        --extra-index-url https://download.pytorch.org/whl/cpu \
        -r requirements.txt

# Pre-warm EasyOCR's English model. First run downloads ~80MB into
# /root/.EasyOCR/ — baking that into the image saves ~30 seconds on
# the very first OCR after each cold start.
RUN python -c "import easyocr; easyocr.Reader(['en'], gpu=False, verbose=False)"

# App code
COPY app ./app

# Azure Container Apps expects the container to listen on a single port
# advertised via `targetPort`. We default to 8080 — override at deploy
# time with `--ingress external --target-port 8080`.
EXPOSE 8080

# Single worker — EasyOCR's Reader is held in process memory and isn't
# safe to share across workers without extra sync. Container Apps does
# horizontal scaling for us; in-process concurrency stays at 1.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8080", "--workers", "1", "--log-level", "info"]
