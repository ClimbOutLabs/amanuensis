ARG NIGHTONA_BASE_IMAGE=REGISTRY_HOST:PORT/nightona/sandbox-arm64-tf@sha256:27b0a1332c3256de79adea4cf8e8c6af6a7fd29d80ac25cd2ddf69e203968fb1
FROM ${NIGHTONA_BASE_IMAGE}

USER root

ARG POPPLER_UTILS_VERSION=25.03.0-5+deb13u4
ARG TESSERACT_OCR_VERSION=5.5.0-1+b1
ARG FFMPEG_VERSION=7:7.1.5-0+deb13u1
ARG TESSERACT_LANGS=eng hin mar
ARG TESSERACT_LANG_PACK_VERSION=1:4.1.0-2

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      poppler-utils=${POPPLER_UTILS_VERSION} \
      tesseract-ocr=${TESSERACT_OCR_VERSION} \
      ffmpeg=${FFMPEG_VERSION} \
    && rm -rf /var/lib/apt/lists/*

# Debian names a pack with dashes (tesseract-ocr-chi-sim) where Tesseract's
# language code uses underscores (chi_sim). A missing pack fails the build at
# this step, not only at the verification step below.
RUN apt-get update \
    && for lang in ${TESSERACT_LANGS}; do \
      if [ "$lang" != "eng" ]; then \
        apt-get install -y --no-install-recommends \
          "tesseract-ocr-${lang//_/-}=${TESSERACT_LANG_PACK_VERSION}" || exit 1; \
      fi; \
    done \
    && rm -rf /var/lib/apt/lists/*

RUN command -v pdfinfo \
    && command -v pdftotext \
    && command -v pdftoppm \
    && command -v tesseract \
    && tesseract --list-langs | grep -Fx eng \
    && for lang in ${TESSERACT_LANGS}; do \
      tesseract --list-langs | grep -Fx "$lang" || exit 1; \
    done \
    && command -v ffmpeg \
    && ffmpeg -version | head -1

LABEL org.opencontainers.image.title="Aman Nightona sandbox with local PDF/OCR/media support" \
      org.opencontainers.image.description="Nightona sandbox extended with pinned Poppler, Tesseract, and FFmpeg packages"

USER nightona
