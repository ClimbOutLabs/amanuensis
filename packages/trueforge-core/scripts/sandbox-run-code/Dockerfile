# syntax=docker/dockerfile:1
#
# run_code sandbox image (Docker driver).
#
# Base digests were fetched from Docker Hub on 2026-09-22 and are pinned here so
# every build starts from identical bits. Re-pin on the weekly rebuild: run
# scripts/build-sandbox-image.sh --repin-bases, which prints fresh digests for
# these two tags after the transcript/log scan gate clears.
#
#   python:3.13-slim-bookworm @ sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26
#   node:22-bookworm-slim    @ sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9
#
# Layer order is deliberate: stable base -> runtimes/system packages -> pip
# layer last, so dependency bumps only invalidate the final layer.
#
# This image is UNBUILT on the authoring VM (no Docker daemon there); see
# scripts/build-sandbox-image.sh. Do not claim verification without a real build.

# ---- node runtime stage (binary copied into the python base below) ----
FROM node:22-bookworm-slim@sha256:48e4b67d85f87bd551df43704e24d252f56cc5f8e9718841aace50f19948f0f9 AS node

FROM python:3.13-slim-bookworm@sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26 AS base

ENV DEBIAN_FRONTEND=noninteractive \
    PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

ARG POPPLER_UTILS_VERSION="22.12.0-2+deb12u3"
ARG TESSERACT_OCR_VERSION="5.3.0-2"

# System layer: document tooling the data packages shell out to. Pinned so the
# layer is reproducible on bookworm; no curl/git — the sandbox has no network
# and installs nothing at runtime.
RUN apt-get update \
      && apt-get install -y --no-install-recommends \
        ca-certificates \
        poppler-utils=${POPPLER_UTILS_VERSION} \
        tesseract-ocr=${TESSERACT_OCR_VERSION} \
        tesseract-ocr-eng \
      && rm -rf /var/lib/apt/lists/*

# Node 22 runtime: copy only the binary (python lives in /usr/local/bin too,
# so the whole /usr/local tree must NOT be copied over it). npm is not needed —
# nothing is installed at runtime.
COPY --from=node /usr/local/bin/node /usr/local/bin/node

# Sandbox layout + non-root execution user (uid/gid 65532, matching the
# driver's ownership handoff). The driver bind-mounts per-run dirs over these.
RUN groupadd -g 65532 sandbox \
      && useradd -u 65532 -g 65532 -m -s /bin/sh sandbox \
      && mkdir -p /ingress /scratch /egress \
      && chown -R 65532:65532 /ingress /scratch /egress /home/sandbox

# Pip layer LAST: requirements.lock is the hash-locked single source of truth
# (every package == pinned with --hash entries for every downloadable file).
# --require-hashes installs bit-identical files with no re-resolution against
# PyPI at build time (plan S7/D2, §2.9). --no-cache-dir keeps the layer lean.
COPY requirements.lock /tmp/requirements.lock
RUN python -m pip install --require-hashes --no-cache-dir -r /tmp/requirements.lock \
      && rm /tmp/requirements.lock \
      && python -c "import pandas, numpy, matplotlib, seaborn, plotly, openpyxl, pdfplumber, PIL, requests, genson, pydantic, yaml, bs4; print('py imports ok')" \
      && node --version \
      && pdftoppm -v \
      && tesseract --version

USER 65532:65532
WORKDIR /scratch
