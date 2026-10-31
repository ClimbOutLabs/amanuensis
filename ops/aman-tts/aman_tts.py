"""Local text-to-speech sidecar: Kokoro-82M (int8 ONNX) on CPU via onnxruntime.

The model, the baked voices and the English word lists are fetched and
hash-verified when the image is built (see pins.py and build_assets.py), so the
service needs no network access. The model file is verified again before it
loads.

HTTP contract:
  GET  /healthz   -> {"status": "ok", "model_loaded": bool, "model_error": str | None,
                      "voices": [str], "default_voice": str}
  POST /v1/speak  -> audio/wav (24 kHz mono 16-bit PCM)

The speak body is JSON `{"text": str, "voice": str | null}`. Text over the
character cap is refused with 413. Text stays in memory; only character counts,
durations and error codes are logged, never the text or the audio.
"""

from __future__ import annotations

import asyncio
import hashlib
import io
import json
import logging
import os
import time
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
from typing import Protocol

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response

from phonemes import Lexicon, split_chunks, to_phonemes
from pins import MODEL_ASSET, MODEL_FILE, VOICE_IDS, VOICES_FILE

LOGGER = logging.getLogger("aman_tts")

SAMPLE_RATE = 24000
WAV_CONTENT_TYPE = "audio/wav"
# Pause placed between model chunks, which always end at a sentence or word break.
CHUNK_GAP_SECONDS = 0.15
VOCAB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kokoro_vocab.json")


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
    cpu_threads: int = field(default_factory=lambda: _env_int("AMAN_TTS_CPU_THREADS", 4))
    max_text_chars: int = field(default_factory=lambda: _env_int("AMAN_TTS_MAX_TEXT_CHARS", 5000))
    asset_dir: str = field(default_factory=lambda: os.environ.get("AMAN_TTS_ASSET_DIR", "/opt/aman-tts/assets"))
    default_voice: str = field(default_factory=lambda: os.environ.get("AMAN_TTS_DEFAULT_VOICE", VOICE_IDS[0]))

    @property
    def max_body_bytes(self) -> int:
        # Four bytes per character covers any UTF-8 text plus the JSON wrapper.
        return self.max_text_chars * 4 + 1024


class AssetVerificationError(Exception):
    """The baked model file does not match its pin; it must not load."""


def verify_model_file(path: str) -> None:
    digest = hashlib.sha256()
    try:
        with open(path, "rb") as fh:
            for chunk in iter(lambda: fh.read(8 * 1024 * 1024), b""):
                digest.update(chunk)
    except OSError as exc:
        raise AssetVerificationError(f"model file cannot be read: {exc}") from exc
    if digest.hexdigest() != MODEL_ASSET.sha256:
        raise AssetVerificationError(
            f"SHA-256 mismatch for {MODEL_FILE}: expected {MODEL_ASSET.sha256[:16]}..., got {digest.hexdigest()[:16]}..."
        )


class Synthesizer(Protocol):
    model_label: str
    voices: tuple[str, ...]

    def speak(self, text: str, voice: str) -> np.ndarray:
        """Return 24 kHz mono float32 audio for the text."""
        ...


class KokoroSynthesizer:
    """Kokoro ONNX backend. onnxruntime is imported lazily so tests can inject a fake."""

    model_label = "kokoro-82m-v1.0-int8"

    def __init__(self, settings: Settings) -> None:
        import onnxruntime as rt

        model_path = os.path.join(settings.asset_dir, MODEL_FILE)
        verify_model_file(model_path)
        options = rt.SessionOptions()
        options.intra_op_num_threads = settings.cpu_threads
        options.inter_op_num_threads = 1
        self._session = rt.InferenceSession(model_path, sess_options=options, providers=["CPUExecutionProvider"])
        with np.load(os.path.join(settings.asset_dir, VOICES_FILE)) as archive:
            self._styles = {voice_id: archive[voice_id] for voice_id in VOICE_IDS if voice_id in archive.files}
        self.voices = tuple(self._styles)
        with open(VOCAB_PATH, encoding="utf-8") as fh:
            self._vocab: dict[str, int] = json.load(fh)
        self._lexicon = Lexicon.load(settings.asset_dir)

    def _tokens(self, phonemes: str) -> list[int]:
        return [self._vocab[ch] for ch in phonemes if ch in self._vocab]

    def speak(self, text: str, voice: str) -> np.ndarray:
        styles = self._styles[voice]
        gap = np.zeros(int(SAMPLE_RATE * CHUNK_GAP_SECONDS), dtype=np.float32)
        parts: list[np.ndarray] = []
        for chunk in split_chunks(to_phonemes(text, self._lexicon)):
            tokens = self._tokens(chunk)
            if not tokens:
                continue
            # One style vector per token count, so n tokens use row n - 1.
            style = styles[min(len(tokens), len(styles)) - 1]
            audio = self._session.run(
                None,
                {
                    "tokens": np.array([[0, *tokens, 0]], dtype=np.int64),
                    "style": np.asarray(style, dtype=np.float32),
                    "speed": np.array([1.0], dtype=np.float32),
                },
            )[0]
            if parts:
                parts.append(gap)
            parts.append(np.asarray(audio, dtype=np.float32).ravel())
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)


def encode_wav(audio: np.ndarray) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2")
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(1)
        wav.setsampwidth(2)
        wav.setframerate(SAMPLE_RATE)
        wav.writeframes(pcm.tobytes())
    return buf.getvalue()


@dataclass
class ServiceState:
    synthesizer: Synthesizer | None = None
    model_error: str | None = None
    # One synthesis at a time: a single run already uses every configured thread.
    in_flight: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))


def _parse_speak_body(body: bytes) -> tuple[str, str | None]:
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Body must be JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    text = payload.get("text")
    voice = payload.get("voice")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="text must be a string")
    if voice is not None and not isinstance(voice, str):
        raise HTTPException(status_code=400, detail="voice must be a string")
    return text, voice


def create_app(
    settings: Settings | None = None,
    synthesizer_factory: "type[Synthesizer] | None" = None,
) -> FastAPI:
    settings = settings or Settings()
    state = ServiceState()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        factory = synthesizer_factory or KokoroSynthesizer
        try:
            synthesizer = factory(settings)
            if settings.default_voice not in synthesizer.voices:
                raise AssetVerificationError(f"default voice {settings.default_voice!r} is not baked into the image")
            # Warm the kernels so the first real reply is not slow.
            await asyncio.to_thread(synthesizer.speak, "Hello.", settings.default_voice)
            state.synthesizer = synthesizer
            LOGGER.info("Model warm: %s (%d voices)", synthesizer.model_label, len(synthesizer.voices))
        except Exception as exc:
            state.model_error = f"{type(exc).__name__}: {exc}"
            LOGGER.exception("Model failed to load; /v1/speak will return 503")
        yield

    app = FastAPI(title="aman-tts", lifespan=lifespan)

    @app.get("/healthz")
    def healthz() -> dict:
        synthesizer = state.synthesizer
        return {
            "status": "ok",
            "model_loaded": synthesizer is not None,
            "model_error": state.model_error,
            "voices": list(synthesizer.voices) if synthesizer else [],
            "default_voice": settings.default_voice,
        }

    @app.post("/v1/speak")
    async def speak(request: Request) -> Response:
        started = time.monotonic()
        synthesizer = state.synthesizer
        if synthesizer is None:
            LOGGER.warning("speak rejected: model not warm")
            raise HTTPException(status_code=503, detail="Model is not warm yet")
        content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise HTTPException(status_code=400, detail="Content-Type must be application/json")
        body = await _read_bounded_body(request, settings.max_body_bytes)
        text, voice = _parse_speak_body(body)
        if len(text) > settings.max_text_chars:
            raise HTTPException(status_code=413, detail=f"Text exceeds {settings.max_text_chars} characters")
        if text.strip() == "":
            raise HTTPException(status_code=400, detail="text is empty")
        voice_id = voice or settings.default_voice
        if voice_id not in synthesizer.voices:
            raise HTTPException(status_code=400, detail=f"Unknown voice; choose one of {', '.join(synthesizer.voices)}")

        async with state.in_flight:
            try:
                audio = await asyncio.to_thread(synthesizer.speak, text, voice_id)
            except Exception as exc:
                LOGGER.exception("speak failed")
                raise HTTPException(status_code=500, detail="Speech synthesis failed") from exc
        if audio.size == 0:
            raise HTTPException(status_code=400, detail="text has nothing to say aloud")

        LOGGER.info(
            "speak ok: chars=%d audio_s=%.1f duration_ms=%d voice=%s",
            len(text),
            audio.size / SAMPLE_RATE,
            int((time.monotonic() - started) * 1000),
            voice_id,
        )
        return Response(
            content=encode_wav(audio),
            media_type=WAV_CONTENT_TYPE,
            headers={"x-voice": voice_id, "x-model": synthesizer.model_label},
        )

    return app


async def _read_bounded_body(request: Request, max_bytes: int) -> bytes:
    declared = request.headers.get("content-length")
    if declared is not None and declared.isdigit() and int(declared) > max_bytes:
        raise HTTPException(status_code=413, detail=f"Body exceeds {max_bytes} byte limit")
    chunks: list[bytes] = []
    total = 0
    async for chunk in request.stream():
        total += len(chunk)
        if total > max_bytes:
            raise HTTPException(status_code=413, detail=f"Body exceeds {max_bytes} byte limit")
        chunks.append(chunk)
    return b"".join(chunks)


app = create_app()
