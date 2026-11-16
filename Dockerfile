# syntax=docker/dockerfile:1
#
# Production image: installs published @truefoundry/trueforge from npm.
# The app bits match the npm package exactly (not floating monorepo source).
#
# Required build-arg:
#   APP_VERSION — npm version to install, e.g. 0.1.0
#
# Example:
#   docker build --build-arg APP_VERSION=0.1.0 -t aman:0.1.0 .

FROM node:24-slim AS runner
WORKDIR /app
# HOST=0.0.0.0 so Kubernetes Service/probe traffic reaches the process.
ENV NODE_ENV=production \
    STANDALONE=false \
    HOST=0.0.0.0

# git and CA certificates: the server runs git itself for the sandbox slots, whose guests have no network.
RUN apt-get update \
  && apt-get install -y --no-install-recommends git ca-certificates \
  && rm -rf /var/lib/apt/lists/*

ARG APP_VERSION
RUN test -n "$APP_VERSION" || (echo "APP_VERSION build-arg is required" >&2 && exit 1)

# Fail closed if the version is not on the registry (no workspace fallback).
RUN npm install --omit=dev "@truefoundry/trueforge@${APP_VERSION}" \
  && npm cache clean --force

# Source reference this image was built from. The server reports it on
# GET /api/v1/capabilities and the UI shows it, so a released deployment can say which build it is.
# The release workflow passes the commit SHA; an omitted arg leaves it blank and the server reports
# the build as unstamped. Declared after the install so a restamp invalidates no layer above it.
ARG BUILD_REF=""
ENV BUILD_REF=${BUILD_REF}

RUN groupadd --gid 10001 trueforge \
  && useradd --uid 10001 --gid trueforge --shell /usr/sbin/nologin trueforge

# Writable data roots for the unprivileged runtime user. Deployments mount
# persistent volumes here (compose: memory-data -> /data/memory,
# persona-knowledge-data -> /data/persona-knowledge); creating them in the
# image lets the server start and run on deploy paths that mount nothing, and
# gives mounted volumes the right ownership when Docker initializes them from
# the image. Without a mounted volume this storage is ephemeral: anything
# written here is lost when the container is recreated, so real deployments
# must still mount persistent volumes. Without these dirs, the cwd-relative
# storage defaults resolve under the root-owned workdir and die with EACCES at
# first write. The Email send list volume mounts at /data/mail-policy and the
# server is its only writer, so the dir is created here the same way; without
# it the fresh volume starts out owned by root and the first write fails.
# The local model bridge's two sides share socket files in a volume mounted at
# /run/aman-local-model, made here for the same reason.
RUN mkdir -p /data/memory /data/persona-knowledge /data/app /data/mail-policy /run/aman-local-model \
  && chown -R 10001:10001 /data /run/aman-local-model

# Image-level defaults so either image works without deploy-specific env: the
# data roots above are writable by the runtime user. Deploys that pin their own
# values (compose, runbook templates) override these.
# APP_DATA_DIR keeps SQLite defaults, sandbox state and the git bridge on the data volume: the runtime user
# has no home directory, so the default under HOME would fail with EACCES at startup.
ENV MEMORY_MARKDOWN_DIR=/data/memory \
  PERSONA_KNOWLEDGE_DIR=/data/persona-knowledge \
  APP_DATA_DIR=/data/app \
  VOICE_VAD_MODEL_DIR=/opt/aman-voice \
  MEMORY_EMBEDDINGS_MODEL_DIR=/opt/aman-models/memory-search \
  HF_HUB_OFFLINE=1 \
  HF_HUB_DISABLE_TELEMETRY=1

# Voice mode's listening model (Silero VAD v5.1.2, MIT), fetched at build time and checked against its
# SHA-256, so the build fails on any other file and the running server never downloads it. The server
# pins the same hash in packages/trueforge/src/voice/vad/sileroVad.ts; a test keeps the two equal.
ADD --chmod=0644 --checksum=sha256:2623a2953f6ff3d2c1e61740c6cdb7168133479b267dfef114a4a3cc5bdd788f https://raw.githubusercontent.com/snakers4/silero-vad/v5.1.2/src/silero_vad/data/silero_vad.onnx /opt/aman-voice/silero_vad.onnx

# Memory search model (Xenova/multilingual-e5-small, MIT upstream), fetched at build time from the pinned
# revision and checked against its SHA-256 (the same pins as EMBEDDING_MODEL_FILES in
# packages/trueforge/src/runtime/memory/embeddingModel.ts). The server loads it from here and only
# downloads again if these bytes ever fail their check. The directory stays writable by the runtime user
# because the server checks that the model folder is writable before it loads.
RUN mkdir -p /opt/aman-models/memory-search/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx \
  && chown -R 10001:10001 /opt/aman-models
ADD --chown=10001:10001 --chmod=0644 --checksum=sha256:cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1 https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/config.json /opt/aman-models/memory-search/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78/config.json
ADD --chown=10001:10001 --chmod=0644 --checksum=sha256:cb99455288675345e1a4f411438d5d0adbba5fbd3a67ea4fb03c015433b996c1 https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/config.json /opt/aman-models/memory-search/Xenova/multilingual-e5-small/config.json
ADD --chown=10001:10001 --chmod=0644 --checksum=sha256:0b44a9d7b51c3c62626640cda0e2c2f70fdacdc25bbbd68038369d14ebdf4c39 https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer.json /opt/aman-models/memory-search/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer.json
ADD --chown=10001:10001 --chmod=0644 --checksum=sha256:a1d6bc8734a6f635dc158508bef000f8e2e5a759c7d92f984b2c86e5ff53425b https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer_config.json /opt/aman-models/memory-search/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78/tokenizer_config.json
ADD --chown=10001:10001 --chmod=0644 --checksum=sha256:f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193 https://huggingface.co/Xenova/multilingual-e5-small/resolve/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx/model_quantized.onnx /opt/aman-models/memory-search/Xenova/multilingual-e5-small/761b726dd34fb83930e26aab4e9ac3899aa1fa78/onnx/model_quantized.onnx

EXPOSE 8790

# Same entry as the from-source image / `pnpm start` (launch-only; dist is in the package).
USER 10001:10001
CMD ["node", "node_modules/@truefoundry/trueforge/dist/main.js"]
