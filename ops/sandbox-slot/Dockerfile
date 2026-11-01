# Sandbox slot image: gVisor (runsc), the PID 1 agent and one guest root filesystem. Built on the machine
# that runs it, never pulled; every base is pinned by index digest so one file builds for amd64 and arm64.
# Build context is this directory (ops/sandbox-slot).
ARG ALPINE_IMAGE=alpine:3.23@sha256:85fe1e81d6758c208f3e1eed4338a1997e19d4be002d4dd32d3100c9a8c010a0
ARG GO_IMAGE=golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac
ARG NODE_IMAGE=node:24-bookworm-slim@sha256:d6aa754f16b3197301076f047b5def2f02ea1dbbc2ca920407d46d7ec7f87b20
ARG UBUNTU_IMAGE=ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55

FROM ${GO_IMAGE} AS agent
WORKDIR /src
COPY agent/go.mod ./
COPY agent/cmd ./cmd
COPY agent/src ./src
RUN CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o /out/aman-slot-agent ./cmd/aman-slot-agent

# gVisor release 20260928.0, official bucket. The sha512 values are the published gvisor.tar.bz2.sha512
# files for that release; update both architectures together.
FROM ${ALPINE_IMAGE} AS runsc
ARG RUNSC_RELEASE=20260928.0
ARG RUNSC_SHA512_X86_64=c8d3a9fd4d4c4f5b8ff213caa4517356be128d18659ec4cde37828fe797f61a9725a602a846c81a8ed19c057a996515d31c081eba343ed4613a89951ba32ed59
ARG RUNSC_SHA512_AARCH64=926538a4f20056d44838f230297ecec9192db2562e2523a207295f706b76126725f2ff7b4e59d747147510c5714057eeec862a0f77d43bf625746592b5f51b00
RUN set -eu; \
    arch="$(uname -m)"; \
    case "$arch" in \
      x86_64)  expected="$RUNSC_SHA512_X86_64" ;; \
      aarch64) expected="$RUNSC_SHA512_AARCH64" ;; \
      *) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
    esac; \
    url="https://storage.googleapis.com/gvisor/releases/release/${RUNSC_RELEASE}/${arch}/gvisor.tar.bz2"; \
    wget -q -O /tmp/gvisor.tar.bz2 "$url"; \
    echo "${expected}  /tmp/gvisor.tar.bz2" | sha512sum -c -; \
    mkdir -p /out/usr/local/bin; \
    tar -xjf /tmp/gvisor.tar.bz2 -C /out/usr/local/bin runsc gvisor-bin; \
    chmod 0755 /out/usr/local/bin/runsc

# Node.js LTS comes from the official image, so its provenance is the pinned digest.
FROM ${NODE_IMAGE} AS node

# The guest root filesystem: what model-written code sees. Nothing here can reach a network at run time.
FROM ${UBUNTU_IMAGE} AS guest
ENV DEBIAN_FRONTEND=noninteractive
# apt packages come from the Ubuntu archive at build time, verified by apt's signatures; only the base image is pinned.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      bash coreutils findutils grep sed gawk diffutils patch tar gzip unzip zip \
      git python3 python3-pip gcc g++ make libc6-dev \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale /var/cache/* /var/log/*

COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx \
 && ln -s python3 /usr/bin/python

# Python wheels and npm packages are installed only if they match the hashes in the checked-in lock files
# (`pnpm sandbox:slots:lock-python` and `npm install --package-lock-only` in guest/ regenerate them).
COPY guest/requirements.txt /tmp/requirements.txt
COPY guest/package.json guest/package-lock.json /opt/sandbox-tools/
RUN pip install --no-cache-dir --break-system-packages --no-deps --require-hashes --only-binary=:all: -r /tmp/requirements.txt \
 && npm ci --prefix /opt/sandbox-tools --omit=dev --ignore-scripts --no-audit --no-fund \
 && ln -s /opt/sandbox-tools/node_modules/.bin/tsc /usr/local/bin/tsc \
 && ln -s /opt/sandbox-tools/node_modules/.bin/tsx /usr/local/bin/tsx \
 && ln -s /opt/sandbox-tools/node_modules/.bin/vitest /usr/local/bin/vitest \
 && ln -s /opt/sandbox-tools/node_modules/.bin/jest /usr/local/bin/jest \
 && ln -s /opt/sandbox-tools/node_modules/.bin/eslint /usr/local/bin/eslint \
 && ln -s /opt/sandbox-tools/node_modules/.bin/prettier /usr/local/bin/prettier \
 && npm cache clean --force \
 && rm -rf /tmp/* /root/.npm /root/.cache

# Run every test and check tool once, so a broken install fails this build instead of a later session.
# These are only the image copies on /usr/local/bin: a project's own pinned tools, in its node_modules/.bin
# or its Python environment, are what its test commands resolve first, and nothing here changes that.
RUN pytest --version \
 && ruff --version \
 && mypy --version \
 && vitest --version \
 && jest --version \
 && eslint --version \
 && prettier --version

# The document pipeline reads attachments inside the guest with pdfinfo, pdftotext and pdftoppm (poppler-utils)
# and tesseract. poppler-data carries the character maps that PDFs in Japanese, Chinese and Korean need to give
# back text. Tesseract needs one data package per language it reads, and osd to tell a page's script so each page
# is read with that script's languages: English, Portuguese, Spanish, French, German, Italian, Dutch, Hindi,
# Marathi, Arabic, Russian, Chinese (simplified and traditional), Japanese and Korean. Its own layer, so changing
# it does not rebuild the Python and npm layers above.
RUN apt-get update \
 && apt-get install -y --no-install-recommends poppler-utils poppler-data tesseract-ocr tesseract-ocr-osd \
      tesseract-ocr-eng tesseract-ocr-por tesseract-ocr-spa tesseract-ocr-fra tesseract-ocr-deu tesseract-ocr-ita \
      tesseract-ocr-nld tesseract-ocr-hin tesseract-ocr-mar tesseract-ocr-ara tesseract-ocr-rus \
      tesseract-ocr-chi-sim tesseract-ocr-chi-tra tesseract-ocr-jpn tesseract-ocr-kor \
 && apt-get clean \
 && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man /usr/share/info /usr/share/locale /var/cache/* /var/log/*

# Optional toolchains chosen with `pnpm sandbox:slots --add`; none by default. The archives are mounted from the
# build context, not copied, so they add nothing to the image beyond the installed toolchain.
ARG AMAN_PACKS=""
RUN --mount=type=bind,source=packs,target=/tmp/packs sh /tmp/packs/install-packs.sh /tmp/packs "${AMAN_PACKS}"

# Mount points for the call directories.
RUN mkdir -p /ingress /scratch /egress /workspace /tmp \
 && chmod 1777 /tmp

FROM ${ALPINE_IMAGE}
COPY --from=runsc /out/usr/local/bin/ /usr/local/bin/
COPY --from=agent /out/aman-slot-agent /usr/local/bin/aman-slot-agent
COPY --from=guest / /rootfs
RUN mkdir -p /workspace /run/aman /run/runsc /tmp \
 && chown 65532:65532 /workspace /run/aman
# The package mirror volume mounts at /run/aman/mirror, and the installer starts the slots before the
# app, so this dir is the one a fresh mirror volume takes its ownership from. The app binds the mirror
# socket in it as its own user (10001), so the dir belongs to that user; the slot only connects through
# the socket and writes nothing in the dir.
RUN mkdir -p /run/aman/mirror \
 && chown 10001:10001 /run/aman/mirror
USER 65532:65532
ENTRYPOINT ["/usr/local/bin/aman-slot-agent"]
