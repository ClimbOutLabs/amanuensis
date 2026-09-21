FROM python:3.11.16-slim-bookworm@sha256:528257d48c1da0dcecc2e725d1ae34498d60c965f1241e39cd6a85a8859bdf84

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    HF_HOME=/tmp/huggingface \
    HF_HUB_OFFLINE=1 \
    TRANSFORMERS_OFFLINE=1 \
    TRANSFORMERS_NO_ADVISORY_WARNINGS=1 \
    TOKENIZERS_PARALLELISM=false \
    PROMPT_GUARD_HOST=0.0.0.0

RUN useradd --create-home --uid 10001 promptguard

WORKDIR /app
COPY requirements.txt ./
RUN pip install --no-cache-dir --require-hashes --requirement requirements.txt
COPY prompt_guard.py ./

USER promptguard
EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s CMD python -c \
  "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health')"

ENTRYPOINT ["python", "prompt_guard.py"]
