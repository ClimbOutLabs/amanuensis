# aman-stt: local speech-to-text sidecar (Whisper small int8, CPU-only).
#
# Build:  docker build -t aman-stt:latest .
# Run:    docker run --memory=2g --restart unless-stopped aman-stt:latest
#
# No GPU access: the base image has no CUDA userspace and the service pins
# device=cpu. The Whisper small weights (~464 MB, Systran/faster-whisper-small,
# MIT) are fetched at build time from the exact Hugging Face commit that
# aman_stt.py pins, and each file must match its SHA-256 or the build fails.
# The running service never downloads anything: it loads these files from the
# image, and the offline flags below stop the Hugging Face libraries from
# reaching out at all.
FROM python:3.12-slim-bookworm@sha256:34386ef0cb081344d7ec1c103ba398e6e9f64e9ab3a1509accc92a4e24a07258

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    AMAN_STT_MODEL_DIR=/opt/aman-stt-models \
    HF_HUB_OFFLINE=1 \
    HF_HUB_DISABLE_TELEMETRY=1 \
    AMAN_STT_HOST=0.0.0.0 \
    AMAN_STT_PORT=8001

RUN useradd --create-home --uid 10001 stt

# Hugging Face cache layout for the pinned revision (see _offline_snapshot_dir in aman_stt.py).
# Files are read-only and owned by root: the service only reads them. The folders are made here with the
# normal mode: --chmod on ADD would also set the folders to 0644, which drops the search bit, so the
# service user could not see the snapshot and would try to download it.
RUN mkdir -p /opt/aman-stt-models/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120
ADD --chmod=0644 --checksum=sha256:b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828 https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/config.json /opt/aman-stt-models/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/config.json
ADD --chmod=0644 --checksum=sha256:3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671 https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/model.bin /opt/aman-stt-models/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/model.bin
ADD --chmod=0644 --checksum=sha256:fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/tokenizer.json /opt/aman-stt-models/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/tokenizer.json
ADD --chmod=0644 --checksum=sha256:34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913 https://huggingface.co/Systran/faster-whisper-small/resolve/536b0662742c02347bc0e980a01041f333bce120/vocabulary.txt /opt/aman-stt-models/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/vocabulary.txt

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes --requirement requirements.txt
COPY aman_stt.py ./

USER stt
EXPOSE 8001

HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD python -c \
  "import json, urllib.request; d = json.load(urllib.request.urlopen('http://127.0.0.1:8001/healthz', timeout=4)); assert d.get('model_loaded') is True, 'model not warm'"

ENTRYPOINT ["python", "-m", "uvicorn", "aman_stt:app", "--host", "0.0.0.0", "--port", "8001"]
