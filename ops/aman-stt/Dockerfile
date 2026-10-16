# aman-stt: local speech-to-text sidecar (Whisper small int8, CPU-only).
#
# Build:  docker build -t aman-stt:latest .
# Run:    docker run --cpuset-cpus="16-19" --memory=2g --restart unless-stopped aman-stt:latest
#
# No GPU access: the base image has no CUDA userspace and the service pins
# device=cpu. The model (~464 MB) downloads once from Hugging Face at first
# startup into the stt-model-cache volume: only the pinned revision recorded
# in aman_stt.py (PINNED_MODELS) is fetched, and every file's SHA-256 is
# verified before loading. Later starts reuse the verified cache with no
# network access. Pin AMAN_STT_MODEL_DIR to a baked-in directory to ship the
# weights inside the image instead.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/data/stt-cache \
    AMAN_STT_HOST=0.0.0.0 \
    AMAN_STT_PORT=8001

RUN useradd --create-home --uid 10001 stt && mkdir -p /data/stt-cache && chown stt:stt /data/stt-cache

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes --requirement requirements.txt
COPY aman_stt.py ./

USER stt
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD python -c \
  "import json, urllib.request; d = json.load(urllib.request.urlopen('http://127.0.0.1:8001/healthz', timeout=4)); assert d.get('model_loaded') is True, 'model not warm'"

ENTRYPOINT ["python", "-m", "uvicorn", "aman_stt:app", "--host", "0.0.0.0", "--port", "8001"]
