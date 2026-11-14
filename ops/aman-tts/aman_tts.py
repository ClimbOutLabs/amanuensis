"""Local text-to-speech sidecar: Kokoro-82M (int8 ONNX) on CPU via onnxruntime.

The model, the baked voices and the English word lists are fetched and
hash-verified when the image is built (see pins.py and build_assets.py), so the
service needs no network access. The model file is verified again before it
loads.

HTTP contract:
  GET  /healthz   -> {"status": "ok", "model_loaded": bool, "model_error": str | None,
                      "voices": [str], "default_voice": str, "exact": true}
  POST /v1/speak  -> audio/wav (24 kHz mono 16-bit PCM) by default

Every call except `/healthz` must carry the shared secret from `SPEECH_SECRET`
in the `x-speech-secret` header, the same check the browser sidecar uses; a
missing or wrong value is refused with 401. Without a secret of at least 32
characters the service does not start. `/healthz` stays open because the
Docker health check carries no secret and the reply says only whether the
model loaded.

The speak body is JSON `{"text": str, "voice": str | null, "format": str | null,
"stream": bool | null, "exact": bool | null}`. `format` is `wav` (default), `pcm16` (24 kHz raw 16-bit
little-endian) or `mulaw8k` (8 kHz G.711 mu-law, for phone lines). With `stream`
true (`pcm16` or `mulaw8k` only) the audio is sent sentence by sentence, so the
first bytes arrive after the first sentence is made. Text over the
character cap is refused with 413. With `exact` true the whole text is first checked, with
the same code that speaks it: if the voice would say anything other than what is written
(numbers read another way, links, list marks, letters outside plain English) the request
is refused with 400 and `x-aman-reason: would_change_text` before any sound; otherwise
that same text is spoken. Text stays in memory; only character counts,
durations and error codes are logged, never the text or the audio.
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import io
import json
import logging
import os
import time
import wave
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import threading
from collections.abc import AsyncIterator, Callable, Iterator
from typing import Protocol

import numpy as np
from fastapi import Depends, FastAPI, HTTPException, Request, Response
from fastapi.responses import StreamingResponse
from starlette.background import BackgroundTask

from audio_formats import FORMATS, STREAMABLE, WAV, Encoder, encode_wav
from phonemes import Lexicon, reads_as_written, split_chunks, split_sentences, to_phonemes
from pins import MODEL_ASSET, MODEL_FILE, VOICE_IDS, VOICES_FILE

LOGGER = logging.getLogger("aman_tts")

SAMPLE_RATE = 24000
# The header the shared secret travels in, and the shortest secret accepted; both match the
# browser sidecar, so one value guards every sidecar the app talks to.
SECRET_HEADER = "x-speech-secret"
MIN_SECRET_LENGTH = 32
# Pause placed between model chunks, which always end at a sentence or word break.
CHUNK_GAP_SECONDS = 0.15
# How often a request being read checks that its caller is still there.
DISCONNECT_POLL_SECONDS = 0.1
VOCAB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kokoro_vocab.json")


REASON_HEADER = "x-aman-reason"
# Set on an exact speak that passed the check, so a caller can tell a service that checked from one that
# does not know `exact` and would speak anything.
EXACT_HEADER = "x-aman-exact"


def _nothing_to_say() -> HTTPException:
    """A 400 that callers can tell from a real fault by its header rather than by its wording."""
    return HTTPException(
        status_code=400, detail="text has nothing to say aloud", headers={REASON_HEADER: "nothing_to_say"}
    )


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
    # The cap that bounds memory: symbols and numbers grow when spelled out, so the work is measured
    # in sounds after expansion, not in characters typed.
    max_phonemes: int = field(default_factory=lambda: _env_int("AMAN_TTS_MAX_PHONEMES", 3000))
    # Requests allowed to wait while one is being read; more are turned away as busy.
    max_waiting: int = field(default_factory=lambda: _env_int("AMAN_TTS_MAX_WAITING", 2))
    asset_dir: str = field(default_factory=lambda: os.environ.get("AMAN_TTS_ASSET_DIR", "/opt/aman-tts/assets"))
    default_voice: str = field(default_factory=lambda: os.environ.get("AMAN_TTS_DEFAULT_VOICE", VOICE_IDS[0]))
    shared_secret: str | None = field(default_factory=lambda: os.environ.get("SPEECH_SECRET") or None)

    @property
    def max_body_bytes(self) -> int:
        # Four bytes per character covers any UTF-8 text plus the JSON wrapper.
        return self.max_text_chars * 4 + 1024


def secret_matches(given: str | None, secret: str) -> bool:
    """Checks a presented secret against the shared one in constant time, whatever their lengths."""
    if given is None:
        return False
    return hmac.compare_digest(
        hashlib.sha256(given.encode("utf-8")).digest(),
        hashlib.sha256(secret.encode("utf-8")).digest(),
    )


def require_usable_secret(settings: Settings) -> str:
    """No secret, or a short one, would leave the service open, so it refuses to start without a usable one."""
    secret = settings.shared_secret
    if secret is None or len(secret) < MIN_SECRET_LENGTH:
        raise ValueError(
            f"SPEECH_SECRET must be set to a random value of at least {MIN_SECRET_LENGTH} characters,"
            " the same value the app sends. Set it, then start the service again."
        )
    return secret


class AssetVerificationError(Exception):
    """The baked model file does not match its pin; it must not load."""


class TextTooLong(Exception):
    """The text spells out to more sounds than one request may make."""


class SpeechCancelled(Exception):
    """The caller went away, so the rest of the text is not read."""


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

    def speak(self, text: str, voice: str, cancelled: Callable[[], bool]) -> np.ndarray:
        """Return 24 kHz mono float32 audio for the text.

        Raises TextTooLong past the sound cap, and SpeechCancelled when `cancelled` turns true
        between pieces.
        """
        ...

    def speak_sentences(self, text: str, voice: str, cancelled: Callable[[], bool]) -> Iterator[np.ndarray]:
        """Yield 24 kHz mono float32 audio one sentence at a time, each as soon as it is made.

        Raises like `speak`, on the first `next()` for the sound cap.
        """
        ...


class KokoroSynthesizer:
    """Kokoro ONNX backend. onnxruntime is imported lazily so tests can inject a fake."""

    model_label = "kokoro-82m-v1.0-int8"

    def __init__(self, settings: Settings) -> None:
        import onnxruntime as rt

        self._max_phonemes = settings.max_phonemes
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

    def _pieces(self, text: str, voice: str, cancelled: Callable[[], bool], *, per_sentence: bool) -> Iterator[np.ndarray]:
        styles = self._styles[voice]
        phonemes = to_phonemes(text, self._lexicon)
        if len(phonemes) > self._max_phonemes:
            raise TextTooLong(f"{len(phonemes)} sounds is over the {self._max_phonemes} cap")
        gap = np.zeros(int(SAMPLE_RATE * CHUNK_GAP_SECONDS), dtype=np.float32)
        pieces = split_sentences(phonemes) if per_sentence else split_chunks(phonemes)
        started = False
        for chunk in pieces:
            if cancelled():
                raise SpeechCancelled()
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
            speech = np.asarray(audio, dtype=np.float32).ravel()
            yield np.concatenate([gap, speech]) if started else speech
            started = True

    def speak(self, text: str, voice: str, cancelled: Callable[[], bool]) -> np.ndarray:
        parts = list(self._pieces(text, voice, cancelled, per_sentence=False))
        return np.concatenate(parts) if parts else np.zeros(0, dtype=np.float32)

    def speak_sentences(self, text: str, voice: str, cancelled: Callable[[], bool]) -> Iterator[np.ndarray]:
        return self._pieces(text, voice, cancelled, per_sentence=True)


@dataclass
class ServiceState:
    synthesizer: Synthesizer | None = None
    model_error: str | None = None
    # One synthesis at a time: a single run already uses every configured thread.
    in_flight: asyncio.Semaphore = field(default_factory=lambda: asyncio.Semaphore(1))
    # Requests holding or waiting for the slot above.
    queued: int = 0


@dataclass(frozen=True)
class SpeakRequest:
    text: str
    voice: str | None
    format: str
    stream: bool
    exact: bool


def _would_read_as_written(text: str) -> bool:
    # A judge that fails is a refusal; the error is not logged because it may quote the card text.
    try:
        return reads_as_written(text)
    except Exception:
        LOGGER.warning("speak check failed: refusing the text")
        return False


def _parse_speak_body(body: bytes) -> SpeakRequest:
    try:
        payload = json.loads(body)
    except (ValueError, UnicodeDecodeError) as exc:
        raise HTTPException(status_code=400, detail="Body must be JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Body must be a JSON object")
    text = payload.get("text")
    voice = payload.get("voice")
    fmt = payload.get("format")
    stream = payload.get("stream")
    exact = payload.get("exact")
    if not isinstance(text, str):
        raise HTTPException(status_code=400, detail="text must be a string")
    if voice is not None and not isinstance(voice, str):
        raise HTTPException(status_code=400, detail="voice must be a string")
    if fmt is not None and fmt not in FORMATS:
        raise HTTPException(status_code=400, detail=f"format must be one of {', '.join(FORMATS)}")
    if stream is not None and not isinstance(stream, bool):
        raise HTTPException(status_code=400, detail="stream must be true or false")
    if exact is not None and not isinstance(exact, bool):
        raise HTTPException(status_code=400, detail="exact must be true or false")
    if stream and fmt not in STREAMABLE:
        raise HTTPException(status_code=400, detail=f"stream needs format {' or '.join(STREAMABLE)}")
    return SpeakRequest(text=text, voice=voice, format=fmt or WAV.name, stream=bool(stream), exact=bool(exact))


def create_app(
    settings: Settings | None = None,
    synthesizer_factory: "type[Synthesizer] | None" = None,
) -> FastAPI:
    settings = settings or Settings()
    shared_secret = require_usable_secret(settings)
    state = ServiceState()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        factory = synthesizer_factory or KokoroSynthesizer
        try:
            synthesizer = factory(settings)
            if settings.default_voice not in synthesizer.voices:
                raise AssetVerificationError(f"default voice {settings.default_voice!r} is not baked into the image")
            # Warm the kernels so the first real reply is not slow.
            await asyncio.to_thread(synthesizer.speak, "Hello.", settings.default_voice, lambda: False)
            state.synthesizer = synthesizer
            LOGGER.info("Model warm: %s (%d voices)", synthesizer.model_label, len(synthesizer.voices))
        except Exception as exc:
            state.model_error = f"{type(exc).__name__}: {exc}"
            LOGGER.exception("Model failed to load; /v1/speak will return 503")
        yield

    app = FastAPI(title="aman-tts", lifespan=lifespan)

    def require_shared_secret(request: Request) -> None:
        # A route dependency rather than middleware, so the request stream and its
        # disconnect watching reach the handler exactly as before.
        if not secret_matches(request.headers.get(SECRET_HEADER), shared_secret):
            raise HTTPException(status_code=401, detail="Wrong or missing secret")

    @app.get("/healthz")
    def healthz() -> dict:
        synthesizer = state.synthesizer
        return {
            "status": "ok",
            "model_loaded": synthesizer is not None,
            "model_error": state.model_error,
            "voices": list(synthesizer.voices) if synthesizer else [],
            "default_voice": settings.default_voice,
            # Callers that must speak a text only as written check this before relying on `exact`.
            "exact": True,
        }

    @app.post("/v1/speak", dependencies=[Depends(require_shared_secret)])
    async def speak(request: Request) -> Response:
        started = time.monotonic()
        content_type = (request.headers.get("content-type") or "").split(";")[0].strip().lower()
        if content_type != "application/json":
            raise HTTPException(status_code=400, detail="Content-Type must be application/json")
        body = await _read_bounded_body(request, settings.max_body_bytes)
        speak_request = _parse_speak_body(body)
        text = speak_request.text
        if len(text) > settings.max_text_chars:
            raise HTTPException(status_code=413, detail=f"Text exceeds {settings.max_text_chars} characters")
        if text.strip() == "":
            raise HTTPException(status_code=400, detail="text is empty")
        # The same whole text is judged here and then spoken below, so what was checked is what is heard.
        if speak_request.exact and not _would_read_as_written(text):
            LOGGER.info("speak refused: would change text, chars=%d", len(text))
            raise HTTPException(
                status_code=400,
                detail="the voice would not say this text as it is written",
                headers={REASON_HEADER: "would_change_text"},
            )
        synthesizer = state.synthesizer
        if synthesizer is None:
            LOGGER.warning("speak rejected: model not warm")
            raise HTTPException(status_code=503, detail="Model is not warm yet")
        voice_id = speak_request.voice or settings.default_voice
        if voice_id not in synthesizer.voices:
            raise HTTPException(status_code=400, detail=f"Unknown voice; choose one of {', '.join(synthesizer.voices)}")

        if state.queued > settings.max_waiting:
            LOGGER.info("speak rejected: busy")
            raise HTTPException(status_code=429, detail="Busy reading other text", headers={"Retry-After": "2"})
        fmt = FORMATS[speak_request.format]
        headers = {"x-voice": voice_id, "x-model": synthesizer.model_label, "x-sample-rate": str(fmt.sample_rate)}
        if speak_request.exact:
            headers[EXACT_HEADER] = "checked"
        state.queued += 1
        if speak_request.stream:
            return await _stream_speech(
                request, state, synthesizer, SpeechJob(text, voice_id, Encoder(fmt), headers, started)
            )
        try:
            if await _wait_for_slot(request, state.in_flight):
                try:
                    audio = await _speak_until_disconnect(request, synthesizer, text, voice_id)
                finally:
                    state.in_flight.release()
            else:
                audio = None
        finally:
            state.queued -= 1
        if audio is None:
            LOGGER.info("speak cancelled: caller went away")
            return Response(status_code=499)
        if audio.size == 0:
            raise _nothing_to_say()

        LOGGER.info(
            "speak ok: chars=%d audio_s=%.1f duration_ms=%d voice=%s format=%s",
            len(text),
            audio.size / SAMPLE_RATE,
            int((time.monotonic() - started) * 1000),
            voice_id,
            fmt.name,
        )
        if fmt is WAV:
            content = encode_wav(audio)
        else:
            content = Encoder(fmt).feed(audio)
        return Response(content=content, media_type=fmt.content_type, headers=headers)

    return app


@dataclass(frozen=True)
class SpeechJob:
    text: str
    voice_id: str
    encoder: Encoder
    headers: dict[str, str]
    started: float


async def _stream_speech(request: Request, state: ServiceState, synthesizer: Synthesizer, job: SpeechJob) -> Response:
    """Sends audio sentence by sentence; the caller already counted itself in `state.queued`.

    The first sentence is awaited here, so a text that cannot be read still gets a proper error status.
    The synthesis slot is handed back only when the worker thread has really stopped, whatever
    happens to the response.
    """
    loop = asyncio.get_running_loop()
    pieces: asyncio.Queue[np.ndarray | Exception | None] = asyncio.Queue()
    cancel = threading.Event()

    def push(item: np.ndarray | Exception | None) -> None:
        try:
            loop.call_soon_threadsafe(pieces.put_nowait, item)
        except RuntimeError:
            # The server is shutting down; nobody is left to hear this.
            cancel.set()

    def produce() -> None:
        try:
            for piece in synthesizer.speak_sentences(job.text, job.voice_id, cancel.is_set):
                if cancel.is_set():
                    return
                push(piece)
            push(None)
        except Exception as exc:
            push(exc)

    def finish() -> None:
        cancel.set()
        state.in_flight.release()
        state.queued -= 1

    async def watch_for_hang_up() -> None:
        while not cancel.is_set():
            if await request.is_disconnected():
                cancel.set()
                return
            await asyncio.sleep(DISCONNECT_POLL_SECONDS)

    try:
        acquired = await _wait_for_slot(request, state.in_flight)
    except BaseException:
        state.queued -= 1
        raise
    if not acquired:
        state.queued -= 1
        LOGGER.info("speak cancelled: caller went away")
        return Response(status_code=499)
    worker = loop.run_in_executor(None, produce)
    worker.add_done_callback(lambda _: finish())
    watcher = asyncio.create_task(watch_for_hang_up())
    try:
        first = await pieces.get()
    except BaseException:
        cancel.set()
        raise
    finally:
        watcher.cancel()
    if isinstance(first, TextTooLong):
        raise HTTPException(status_code=413, detail="Text is too long to read at once") from first
    if isinstance(first, Exception):
        LOGGER.error("speak failed", exc_info=first)
        raise HTTPException(status_code=500, detail="Speech synthesis failed") from first
    if first is None:
        raise _nothing_to_say()

    async def body() -> AsyncIterator[bytes]:
        sent = 0
        try:
            item: np.ndarray | Exception | None = first
            while isinstance(item, np.ndarray):
                data = job.encoder.feed(item)
                sent += len(data)
                yield data
                item = await pieces.get()
            if isinstance(item, Exception):
                # The status line is already sent; breaking the connection is how the caller learns the audio is cut short.
                LOGGER.error("speak failed mid-stream", exc_info=item)
                raise RuntimeError("speech stopped part way") from item
            LOGGER.info(
                "speak ok: streamed bytes=%d duration_ms=%d voice=%s format=%s",
                sent,
                int((time.monotonic() - job.started) * 1000),
                job.voice_id,
                job.encoder.format.name,
            )
        finally:
            cancel.set()

    # Also runs when the body is never started, so a caller who left early does not keep the slot busy.
    return StreamingResponse(
        body(), media_type=job.encoder.format.content_type, headers=job.headers, background=BackgroundTask(cancel.set)
    )


async def _wait_for_slot(request: Request, slot: asyncio.Semaphore) -> bool:
    """Waits for the synthesis slot, giving up once the caller hangs up so a gone caller does not hold a place in line."""
    acquire = asyncio.ensure_future(slot.acquire())
    acquired = False
    try:
        while not acquired:
            done, _ = await asyncio.wait({acquire}, timeout=DISCONNECT_POLL_SECONDS)
            if done:
                acquired = True
            elif await request.is_disconnected():
                break
    finally:
        if not acquired:
            # Not awaited, so a cancel of this request still reaches its caller.
            acquire.cancel()
            acquire.add_done_callback(_pass_on_slot(slot))
    return acquired


def _pass_on_slot(slot: asyncio.Semaphore) -> Callable[[asyncio.Future], None]:
    """Gives the slot back when it was handed over just as the wait ended."""

    def done(acquire: asyncio.Future) -> None:
        if not acquire.cancelled() and acquire.exception() is None:
            slot.release()

    return done


async def _speak_until_disconnect(
    request: Request, synthesizer: Synthesizer, text: str, voice_id: str
) -> np.ndarray | None:
    """Reads the text aloud, stopping between pieces once the caller hangs up; None when it did."""
    if await request.is_disconnected():
        return None
    cancel = threading.Event()

    async def watch() -> None:
        while not cancel.is_set():
            if await request.is_disconnected():
                cancel.set()
                return
            await asyncio.sleep(DISCONNECT_POLL_SECONDS)

    watcher = asyncio.create_task(watch())
    try:
        return await asyncio.to_thread(synthesizer.speak, text, voice_id, cancel.is_set)
    except SpeechCancelled:
        return None
    except TextTooLong as exc:
        raise HTTPException(status_code=413, detail="Text is too long to read at once") from exc
    except Exception as exc:
        LOGGER.exception("speak failed")
        raise HTTPException(status_code=500, detail="Speech synthesis failed") from exc
    finally:
        cancel.set()
        watcher.cancel()


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
