"""Local speech-to-text sidecar: Whisper `small` int8 via faster-whisper.

Model weights are pinned to exact Hugging Face revisions with SHA-256
hashes (see PINNED_MODELS). On first start the pinned revision is
downloaded and every file is hash-verified before loading; later starts
reuse the verified cache without network access and re-verify at load.

HTTP contract:
  GET  /healthz       -> {"status": "ok", "model_loaded": bool, "model_error": str | None}
  POST /v1/transcribe -> {"text", "language", "duration_ms", "model"}

Accepts `audio/wav` (16 kHz mono 16-bit PCM) or `audio/x-raw-pcm` with
`sample_rate`/`channels`/`sample_width` query params (defaults 16000/1/2).
Body cap is 30 MB (413 above). Audio stays in memory; only durations and
error codes are logged, never transcripts or audio bytes.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import logging
import os
import shutil
import time
import wave
from collections.abc import Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
from fastapi import FastAPI, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse

LOGGER = logging.getLogger("aman_stt")

SAMPLE_RATE = 16000
CHANNELS = 1
SAMPLE_WIDTH_BYTES = 2
WAV_CONTENT_TYPE = "audio/wav"
RAW_PCM_CONTENT_TYPE = "audio/x-raw-pcm"


def _env_int(name: str, default: int) -> int:
    raw = os.environ.get(name)
    if raw is None or raw.strip() == "":
        return default
    try:
        return int(raw)
    except ValueError:
        LOGGER.warning("Ignoring invalid %s=%r; using default %d", name, raw, default)
        return default


@dataclass
class Settings:
    host: str = field(default_factory=lambda: os.environ.get("AMAN_STT_HOST", "127.0.0.1"))
    port: int = field(default_factory=lambda: _env_int("AMAN_STT_PORT", 8001))
    model_size: str = field(default_factory=lambda: os.environ.get("AMAN_STT_MODEL", "small"))
    fallback_model_size: str = field(default_factory=lambda: os.environ.get("AMAN_STT_FALLBACK_MODEL", "base"))
    cpu_threads: int = field(default_factory=lambda: _env_int("AMAN_STT_CPU_THREADS", 4))
    max_body_bytes: int = field(default_factory=lambda: _env_int("AMAN_STT_MAX_BODY_BYTES", 30 * 1024 * 1024))
    model_dir: str | None = field(default_factory=lambda: os.environ.get("AMAN_STT_MODEL_DIR") or None)


class ModelVerificationError(Exception):
    """A pinned model could not be verified; it must not load."""


@dataclass(frozen=True)
class PinnedModel:
    """One pinned model: exact repository, exact commit, and file hashes."""

    repo: str
    revision: str  # full commit hash, never a branch name
    files: dict[str, str]  # snapshot-relative path -> expected SHA-256 hex digest


# Every model the sidecar may load, pinned in one place. The primary and
# the fallback go through the same verify-before-load path; a size with no
# entry here is refused rather than downloaded unpinned.
#
# The loader (faster-whisper) also reads `preprocessor_config.json` when it
# exists in the model directory. The pinned revisions below do not ship that
# file, so its presence in a snapshot is treated as a verification failure
# (fail closed): see LOADER_READ_FILES and verify_model_files.
PINNED_MODELS: dict[str, PinnedModel] = {
    "small": PinnedModel(
        repo="Systran/faster-whisper-small",
        revision="536b0662742c02347bc0e980a01041f333bce120",
        files={
            "config.json": "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
            "model.bin": "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
            "tokenizer.json": "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
            "vocabulary.txt": "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
        },
    ),
    "base": PinnedModel(
        repo="Systran/faster-whisper-base",
        revision="ebe41f70d5b6dfa9166e2c581c45c9c0cfc57b66",
        files={
            "config.json": "56a6d8110d311f19c8f0471e562832c7527f146b567275bfca59fcf7c184da9a",
            "model.bin": "d01c3014881c9c6f3133c182f3d2887eb6ca1c789a7538c5c007196857a0a6a9",
            "tokenizer.json": "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
            "vocabulary.txt": "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
        },
    ),
}

# Download seam: (pinned_model, cache_dir) -> snapshot directory holding the
# revision's files. Injected in tests so they never touch the network.
Downloader = Callable[[PinnedModel, str], str]


# Files the faster-whisper loader may read from the model directory.
# `preprocessor_config.json` is optional for the loader (it is only read when
# present), but the pinned revisions do not ship it. If it appears in a
# snapshot, that is unexpected and the snapshot is refused: the loader would
# trust it, so an unpinned copy must never load.
LOADER_READ_FILES: frozenset[str] = frozenset(
    {
        "config.json",
        "model.bin",
        "tokenizer.json",
        "vocabulary.txt",
        "preprocessor_config.json",
    }
)


def _sha256_file(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for chunk in iter(lambda: fh.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_files(snapshot_dir: str, expected_files: dict[str, str]) -> None:
    """Check every pinned file exists and matches its SHA-256.

    Raises ModelVerificationError on the first missing or mismatched file.
    Extra files in the directory are ignored, except for files the loader
    may read (LOADER_READ_FILES): an unpinned loader-read file (for example
    a `preprocessor_config.json` the pinned revision does not ship) is
    refused, because the loader would trust it.
    """
    for name, expected in expected_files.items():
        path = os.path.join(snapshot_dir, name)
        if not os.path.isfile(path):
            raise ModelVerificationError(f"pinned file missing from snapshot: {name}")
        actual = _sha256_file(path)
        if actual != expected:
            raise ModelVerificationError(
                f"SHA-256 mismatch for {name}: expected {expected[:16]}..., "
                f"got {actual[:16]}..."
            )
    try:
        present = set(os.listdir(snapshot_dir))
    except OSError as exc:
        raise ModelVerificationError(f"cannot list snapshot directory: {exc}") from exc
    for name in sorted(present & LOADER_READ_FILES):
        if name not in expected_files:
            raise ModelVerificationError(
                f"unpinned loader-read file present in snapshot: {name}; refusing"
            )


def _offline_snapshot_dir(pinned: PinnedModel, cache_dir: str) -> str | None:
    """Return the cached snapshot dir for the pinned revision, or None.

    Mirrors the huggingface_hub cache layout, so a warm cache starts with no
    network access. Pure local check.
    """
    snapshot_dir = os.path.join(
        cache_dir,
        "models--" + pinned.repo.replace("/", "--"),
        "snapshots",
        pinned.revision,
    )
    return snapshot_dir if os.path.isdir(snapshot_dir) else None


def _default_downloader(pinned: PinnedModel, cache_dir: str) -> str:
    """Download the pinned revision from the model hub (network)."""
    from huggingface_hub import snapshot_download

    try:
        return snapshot_download(
            repo_id=pinned.repo, revision=pinned.revision, cache_dir=cache_dir
        )
    except Exception as exc:
        raise ModelVerificationError(
            f"could not download pinned {pinned.repo}@{pinned.revision[:12]}: {exc}"
        ) from exc


def ensure_verified_model_dir(
    *,
    model_size: str,
    cache_dir: str,
    downloader: Downloader | None = None,
) -> str:
    """Return a local directory holding the verified pinned model files.

    Uses the warm cache when present (no network); otherwise downloads the
    pinned revision and verifies every file hash before returning. Raises
    ModelVerificationError when the size is not pinned, the revision does
    not match, or any file is missing or tampered. Never downloads unpinned.

    A warm cache with a missing file (for example an interrupted first
    download) is removed and downloaded again, once. A hash mismatch is
    always a hard refusal and is never retried.
    """
    pinned = PINNED_MODELS.get(model_size)
    if pinned is None:
        raise ModelVerificationError(
            f"model size {model_size!r} has no pinned revision; refusing "
            f"unpinned download (pinned sizes: {sorted(PINNED_MODELS)})"
        )
    resolve = downloader or _default_downloader
    snapshot_dir = _offline_snapshot_dir(pinned, cache_dir)
    downloaded = False
    if snapshot_dir is None:
        snapshot_dir = resolve(pinned, cache_dir)
        downloaded = True
    _check_revision_dir(snapshot_dir, pinned)
    try:
        verify_model_files(snapshot_dir, pinned.files)
    except ModelVerificationError as exc:
        if downloaded or "pinned file missing from snapshot" not in str(exc):
            raise
        # Partial snapshot from an interrupted download: drop it and fetch
        # the pinned revision again, exactly once.
        LOGGER.warning(
            "Partial snapshot for %s (%s); removing and re-downloading once",
            pinned.repo,
            exc,
        )
        shutil.rmtree(snapshot_dir, ignore_errors=True)
        snapshot_dir = resolve(pinned, cache_dir)
        _check_revision_dir(snapshot_dir, pinned)
        verify_model_files(snapshot_dir, pinned.files)
    LOGGER.info(
        "model verified: %s@%s (%d files)",
        pinned.repo,
        pinned.revision[:12],
        len(pinned.files),
    )
    return snapshot_dir


def _check_revision_dir(snapshot_dir: str, pinned: PinnedModel) -> None:
    """Raise unless the snapshot directory is for the pinned revision."""
    revision_dir = os.path.basename(os.path.normpath(snapshot_dir))
    if revision_dir != pinned.revision:
        raise ModelVerificationError(
            f"revision mismatch for {pinned.repo}: downloader returned "
            f"{revision_dir!r}, pinned revision is {pinned.revision!r}"
        )


def _default_cache_dir() -> str:
    from huggingface_hub import constants

    return constants.HF_HUB_CACHE


def _load_first_verified(
    sizes: tuple[str, ...],
    cache_dir: str,
    downloader: Downloader | None,
    model_factory: Callable[[str], object],
) -> tuple[object, str, str | None]:
    """Load the first size whose pinned files verify; raise if none do.

    Returns (model, size, primary_error): primary_error is the failure
    reason for sizes[0] when it failed but a later size loaded, else None.
    Callers surface it so a fallback load does not hide the primary's
    verification failure.
    """
    failures: list[str] = []
    for size in sizes:
        try:
            snapshot_dir = ensure_verified_model_dir(
                model_size=size, cache_dir=cache_dir, downloader=downloader
            )
            primary_error = failures[0] if failures else None
            return model_factory(snapshot_dir), size, primary_error
        except Exception as exc:
            failures.append(f"{size}: {exc}")
            LOGGER.warning("Model load failed for %r: %s", size, exc)
    raise ModelVerificationError(
        "no pinned model could be verified and loaded: " + "; ".join(failures)
    )


class Transcriber(Protocol):
    model_label: str
    # Verification failure of the primary model when a fallback loaded
    # instead; surfaced on /healthz so the primary failure is not hidden.
    primary_error: str | None

    def warmup(self) -> None:
        """Run one inference pass so the first real request is fast."""
        ...

    def transcribe(self, audio: np.ndarray, language: str | None) -> tuple[str, str]:
        """Return (text, language_code) for 16 kHz mono float32 audio."""
        ...


class FasterWhisperTranscriber:
    """faster-whisper backend. Imported lazily so tests can inject a fake."""

    def __init__(
        self,
        settings: Settings,
        downloader: Downloader | None = None,
    ) -> None:
        from faster_whisper import WhisperModel

        cache_dir = settings.model_dir or _default_cache_dir()

        def _factory(snapshot_dir: str) -> object:
            return WhisperModel(
                snapshot_dir,
                device="cpu",
                compute_type="int8",
                cpu_threads=settings.cpu_threads,
            )

        self._model, self._size, self.primary_error = _load_first_verified(
            (settings.model_size, settings.fallback_model_size),
            cache_dir,
            downloader,
            _factory,
        )
        self.model_label = f"whisper-{self._size}-int8"

    def warmup(self) -> None:
        silence = np.zeros(SAMPLE_RATE, dtype=np.float32)
        self.transcribe(silence, None)

    def transcribe(self, audio: np.ndarray, language: str | None) -> tuple[str, str]:
        segments, info = self._model.transcribe(audio, language=language)
        text = "".join(segment.text for segment in segments).strip()
        return text, info.language


class MalformedAudio(Exception):
    pass


def decode_wav(body: bytes) -> np.ndarray:
    try:
        with wave.open(io.BytesIO(body), "rb") as wav:
            if (
                wav.getnchannels() != CHANNELS
                or wav.getsampwidth() != SAMPLE_WIDTH_BYTES
                or wav.getframerate() != SAMPLE_RATE
                or wav.getcomptype() != "NONE"
            ):
                raise MalformedAudio(
                    "WAV must be 16 kHz mono 16-bit PCM; got "
                    f"{wav.getframerate()} Hz, {wav.getnchannels()} ch, "
                    f"{wav.getsampwidth() * 8}-bit, {wav.getcomptype()}"
                )
            frames = wav.readframes(wav.getnframes())
    except (wave.Error, EOFError) as exc:
        raise MalformedAudio(f"Unparseable WAV data: {exc}") from exc
    if len(frames) == 0:
        raise MalformedAudio("WAV contains no audio frames")
    return np.frombuffer(frames, dtype=np.int16).astype(np.float32) / 32768.0


def decode_raw_pcm(body: bytes, sample_rate: int, channels: int, sample_width: int) -> np.ndarray:
    if sample_rate != SAMPLE_RATE or channels != CHANNELS or sample_width != SAMPLE_WIDTH_BYTES:
        raise MalformedAudio(
            "Raw PCM must be 16 kHz mono 16-bit; got "
            f"{sample_rate} Hz, {channels} ch, {sample_width * 8}-bit"
        )
    if len(body) == 0 or len(body) % sample_width != 0:
        raise MalformedAudio("Raw PCM body is empty or not frame-aligned")
    return np.frombuffer(body, dtype=np.int16).astype(np.float32) / 32768.0


@dataclass
class ServiceState:
    transcriber: Transcriber | None = None
    # Set when the model fails to load; surfaced on /healthz.
    model_error: str | None = None
    # One transcription at a time: the 4 pinned cores are fully used by a single decode.
    in_flight: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))


def create_app(
    settings: Settings | None = None,
    transcriber_factory: "type[Transcriber] | None" = None,
) -> FastAPI:
    settings = settings or Settings()
    state = ServiceState()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        factory = transcriber_factory or FasterWhisperTranscriber
        try:
            transcriber = factory(settings)
            await asyncio.to_thread(transcriber.warmup)
            state.transcriber = transcriber
            # A fallback load still reports the primary's verification
            # failure; the primary problem must not be hidden.
            state.model_error = transcriber.primary_error
            LOGGER.info("Model warm: %s", transcriber.model_label)
        except Exception as exc:
            state.model_error = f"{type(exc).__name__}: {exc}"
            LOGGER.exception("Model failed to load; /v1/transcribe will return 503")
        yield

    app = FastAPI(title="aman-stt", lifespan=lifespan)

    @app.get("/healthz")
    def healthz() -> dict:
        return {
            "status": "ok",
            "model_loaded": state.transcriber is not None,
            "model_error": state.model_error,
        }

    @app.post("/v1/transcribe")
    async def transcribe(
        request: Request,
        language: str | None = Query(default=None, description="Optional language hint, e.g. 'en'"),
        sample_rate: int = Query(default=SAMPLE_RATE),
        channels: int = Query(default=CHANNELS),
        sample_width: int = Query(default=SAMPLE_WIDTH_BYTES),
    ) -> Response:
        started = time.monotonic()
        if state.transcriber is None:
            LOGGER.warning("transcribe rejected: model not warm")
            raise HTTPException(status_code=503, detail="Model is not warm yet")
        content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type not in (WAV_CONTENT_TYPE, RAW_PCM_CONTENT_TYPE):
            raise HTTPException(
                status_code=400,
                detail=f"Content-Type must be {WAV_CONTENT_TYPE} or {RAW_PCM_CONTENT_TYPE}",
            )
        body = await _read_bounded_body(request, settings.max_body_bytes)
        try:
            if content_type == WAV_CONTENT_TYPE:
                audio = decode_wav(body)
            else:
                audio = decode_raw_pcm(body, sample_rate, channels, sample_width)
        except MalformedAudio as exc:
            LOGGER.info("transcribe rejected: malformed audio (%s)", exc)
            raise HTTPException(status_code=400, detail=str(exc)) from exc

        transcriber = state.transcriber
        async with state.in_flight:
            try:
                text, detected_language = await asyncio.to_thread(transcriber.transcribe, audio, language)
            except ValueError as exc:
                # e.g. unknown language hint from the underlying model.
                LOGGER.info("transcribe rejected: bad parameter (%s)", exc)
                raise HTTPException(status_code=400, detail=str(exc)) from exc
            except Exception as exc:
                LOGGER.exception("transcribe failed")
                raise HTTPException(status_code=500, detail="Transcription failed") from exc

        duration_ms = int((time.monotonic() - started) * 1000)
        LOGGER.info(
            "transcribe ok: audio_s=%.1f duration_ms=%d language=%s model=%s",
            len(audio) / SAMPLE_RATE,
            duration_ms,
            detected_language,
            transcriber.model_label,
        )
        return JSONResponse(
            {
                "text": text,
                "language": detected_language,
                "duration_ms": duration_ms,
                "model": transcriber.model_label,
            }
        )

    return app


async def _read_bounded_body(request: Request, max_bytes: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None:
        try:
            if int(declared) > max_bytes:
                raise HTTPException(
                    status_code=413,
                    detail=f"Audio body exceeds {max_bytes} byte limit",
                )
        except ValueError:
            pass
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(
                status_code=413,
                detail=f"Audio body exceeds {max_bytes} byte limit",
            )
        chunks.append(chunk)
    return b"".join(chunks)


app = create_app()
