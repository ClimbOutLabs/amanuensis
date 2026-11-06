# aman-tts: local text-to-speech sidecar (Kokoro-82M int8 ONNX, CPU-only).
#
# Build:  docker build -t aman-tts:latest .
# Run:    docker run --memory=1g --restart unless-stopped aman-tts:latest
#
# The model, three American English voices and the English word lists are
# downloaded once, while the image builds, from the exact URLs pinned in
# pins.py; every file's size and SHA-256 is checked before it is kept. The
# running service needs no network access and the model is verified again
# before it loads. No GPU access: onnxruntime runs on the CPU provider only.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258 AS assets

WORKDIR /build
COPY pins.py build_assets.py ./
RUN python build_assets.py /opt/aman-tts/assets

FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AMAN_TTS_ASSET_DIR=/opt/aman-tts/assets

RUN useradd --create-home --uid 10001 tts

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes --requirement requirements.txt
COPY --from=assets /opt/aman-tts/assets /opt/aman-tts/assets
COPY aman_tts.py phonemes.py pins.py kokoro_vocab.json ./

USER tts
EXPOSE 8002

HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD python -c \
  "import json, urllib.request; d = json.load(urllib.request.urlopen('http://127.0.0.1:8002/healthz', timeout=4)); assert d.get('model_loaded') is True, 'model not warm'"

ENTRYPOINT ["python", "-m", "uvicorn", "aman_tts:app", "--host", "0.0.0.0", "--port", "8002"]
