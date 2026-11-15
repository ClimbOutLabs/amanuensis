FROM python:3.13-slim-bookworm

ENV DEBIAN_FRONTEND=noninteractive
ARG NATS_SERVER_VERSION="v2.14.5"
ARG HELM_VERSION="v4.2.3"
ARG POPPLER_UTILS_VERSION="22.12.0-2+deb12u3"
ARG TESSERACT_OCR_VERSION="5.3.0-2"
ARG TARGETARCH

COPY requirements.txt /tmp/requirements.txt
RUN apt-get update \
      && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        jq \
        poppler-utils=${POPPLER_UTILS_VERSION} \
        ripgrep \
        supervisor \
        tesseract-ocr=${TESSERACT_OCR_VERSION} \
        tree \
        unzip \
        zip \
      && case "${TARGETARCH}" in amd64|arm64) ;; *) echo "Unsupported target architecture: ${TARGETARCH}" >&2; exit 1 ;; esac \
      && helm_arch="linux-${TARGETARCH}" \
      && helm_archive="/tmp/helm-${HELM_VERSION}-${helm_arch}.tar.gz" \
      && curl -fL "https://get.helm.sh/helm-${HELM_VERSION}-${helm_arch}.tar.gz" -o "${helm_archive}" \
      && tar -xzf "${helm_archive}" -C /tmp \
      && mv "/tmp/${helm_arch}/helm" /usr/local/bin/helm \
      && rm -rf "${helm_archive}" "/tmp/${helm_arch}" \
      && helm version \
      && nats_arch="linux-${TARGETARCH}" \
      && nats_archive="/tmp/nats-server-${NATS_SERVER_VERSION}-${nats_arch}.tar.gz" \
      && curl -fL "https://github.com/nats-io/nats-server/releases/download/${NATS_SERVER_VERSION}/nats-server-${NATS_SERVER_VERSION}-${nats_arch}.tar.gz" -o "${nats_archive}" \
      && tar -xzf "${nats_archive}" -C /tmp \
      && mv "/tmp/nats-server-${NATS_SERVER_VERSION}-${nats_arch}/nats-server" /usr/local/bin/nats-server \
      && rm -rf "${nats_archive}" "/tmp/nats-server-${NATS_SERVER_VERSION}-${nats_arch}" \
      && mkdir -p /var/lib/nats /var/log/nats \
      && nats-server --version \
      && git config --global user.email "trueforge@example.org" \
      && git config --global user.name "TrueForge Agent" \
      && python -m pip install --no-cache-dir --upgrade pip \
      && python -m pip install --no-cache-dir -r /tmp/requirements.txt \
      && rm /tmp/requirements.txt \
      && rm -rf /var/lib/apt/lists/*

RUN command -v pdftoppm \
      && command -v tesseract \
      && pdftoppm -v \
      && tesseract --version

COPY nats.supervisor.conf /etc/supervisor/conf.d/nats.conf
COPY nats.conf /var/lib/nats/nats.conf
WORKDIR /home/trueforge
ENTRYPOINT ["/usr/bin/supervisord", "-n"]
