"""Local speech-to-text sidecar: Whisper `small` int8 via faster-whisper.

HTTP contract:
  GET  /healthz       -> {"status": "ok", "model_loaded": bool, "model": str}
  POST /v1/transcribe -> {"text", "language", "duration_ms", "model"}

When `STT_SHARED_SECRET` is set, `POST /v1/transcribe` requires a matching
`X-STT-Secret` header and rejects others with 401.

Accepts `audio/wav` (16 kHz mono 16-bit PCM) or `audio/x-raw-pcm` with
`sample_rate`/`channels`/`sample_width` query params (defaults 16000/1/2).
Body cap is 30 MB (413 above). Audio stays in memory; only durations and
error codes are logged, never transcripts or audio bytes.
"""

from __future__ import annotations

import asyncio
import io
import logging
import os
import time
import wave
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
    shared_secret: str = field(default_factory=lambda: os.environ.get("STT_SHARED_SECRET", ""))


class Transcriber(Protocol):
    model_label: str

    def warmup(self) -> None:
        """Run one inference pass so the first real request is fast."""
        ...

    def transcribe(self, audio: np.ndarray, language: str | None) -> tuple[str, str]:
        """Return (text, language_code) for 16 kHz mono float32 audio."""
        ...


class FasterWhisperTranscriber:
    """faster-whisper backend. Imported lazily so tests can inject a fake."""

    def __init__(self, settings: Settings) -> None:
        from faster_whisper import WhisperModel

        load_kwargs: dict = {
            "device": "cpu",
            "compute_type": "int8",
            "cpu_threads": settings.cpu_threads,
        }
        if settings.model_dir:
            load_kwargs["download_root"] = settings.model_dir
        try:
            self._model = WhisperModel(settings.model_size, **load_kwargs)
            self._size = settings.model_size
        except Exception as exc:
            LOGGER.warning(
                "Failed to load whisper model %r (%s); falling back to %r",
                settings.model_size,
                exc,
                settings.fallback_model_size,
            )
            self._model = WhisperModel(settings.fallback_model_size, **load_kwargs)
            self._size = settings.fallback_model_size
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
            LOGGER.info("Model warm: %s", transcriber.model_label)
        except Exception:
            LOGGER.exception("Model failed to load; /v1/transcribe will return 503")
        yield

    app = FastAPI(title="aman-stt", lifespan=lifespan)

    @app.get("/healthz")
    def healthz() -> dict:
        transcriber = state.transcriber
        return {
            "status": "ok",
            "model_loaded": transcriber is not None,
            "model": transcriber.model_label if transcriber is not None else "",
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
        if settings.shared_secret:
            presented = request.headers.get("x-stt-secret", "")
            if presented != settings.shared_secret:
                LOGGER.warning("transcribe rejected: bad or missing shared secret")
                raise HTTPException(status_code=401, detail="Unauthorized")
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
