import io
import logging
import math
import os
import struct
import sys
import unittest
import wave


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np
from fastapi.testclient import TestClient

from aman_stt import (  # noqa: E402
    MalformedAudio,
    Settings,
    create_app,
    decode_raw_pcm,
    decode_wav,
)


def make_sine_wav(
    seconds: float = 1.0,
    freq: float = 440.0,
    sample_rate: int = 16000,
    channels: int = 1,
    sampwidth: int = 2,
) -> bytes:
    frames = bytearray()
    for i in range(int(seconds * sample_rate)):
        sample = int(16000 * math.sin(2 * math.pi * freq * i / sample_rate))
        for _ in range(channels):
            frames += struct.pack("<h" if sampwidth == 2 else "<i", sample)
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        wav.setnchannels(channels)
        wav.setsampwidth(sampwidth)
        wav.setframerate(sample_rate)
        wav.writeframes(bytes(frames))
    return buf.getvalue()


class FakeTranscriber:
    """A Transcriber that returns canned output; never touches a real model."""

    model_label = "whisper-small-int8"
    instances: list["FakeTranscriber"] = []

    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.calls: list[tuple[np.ndarray, str | None]] = []
        FakeTranscriber.instances.append(self)

    def warmup(self) -> None:
        pass

    def transcribe(self, audio: np.ndarray, language: str | None) -> tuple[str, str]:
        self.calls.append((audio, language))
        return "synthetic transcript", language or "en"


class BrokenTranscriber:
    def __init__(self, settings: Settings) -> None:
        raise RuntimeError("no model here")


def make_client(settings: Settings | None = None, factory=FakeTranscriber) -> TestClient:
    settings = settings or Settings()
    FakeTranscriber.instances.clear()
    app = create_app(settings=settings, transcriber_factory=factory)
    return TestClient(app)


class HealthzTest(unittest.TestCase):
    def test_model_loaded_when_warm(self):
        with make_client() as client:
            response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "model_loaded": True})

    def test_model_not_loaded_when_factory_fails(self):
        with make_client(factory=BrokenTranscriber) as client:
            response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok", "model_loaded": False})


class TranscribeTest(unittest.TestCase):
    def test_happy_path_wav(self):
        wav = make_sine_wav()
        with make_client() as client:
            response = client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["text"], "synthetic transcript")
        self.assertEqual(body["language"], "en")
        self.assertEqual(body["model"], "whisper-small-int8")
        self.assertIsInstance(body["duration_ms"], int)
        self.assertGreaterEqual(body["duration_ms"], 0)

    def test_language_hint_forwarded(self):
        wav = make_sine_wav()
        with make_client() as client:
            response = client.post(
                "/v1/transcribe?language=es", content=wav, headers={"Content-Type": "audio/wav"}
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["language"], "es")
        _, hint = FakeTranscriber.instances[0].calls[0]
        self.assertEqual(hint, "es")

    def test_audio_decoded_to_16k_mono_float32(self):
        wav = make_sine_wav(seconds=0.5)
        with make_client() as client:
            response = client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        self.assertEqual(response.status_code, 200)
        audio, _ = FakeTranscriber.instances[0].calls[0]
        self.assertEqual(audio.dtype, np.float32)
        self.assertEqual(len(audio), 8000)
        self.assertTrue(np.all(np.abs(audio) <= 1.0))

    def test_raw_pcm_path(self):
        wav = make_sine_wav()
        with wave.open(io.BytesIO(wav), "rb") as reader:
            pcm = reader.readframes(reader.getnframes())
        with make_client() as client:
            response = client.post(
                "/v1/transcribe",
                content=pcm,
                headers={"Content-Type": "audio/x-raw-pcm"},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["text"], "synthetic transcript")

    def test_rejects_oversized_body_with_413(self):
        settings = Settings()
        settings.max_body_bytes = 100
        wav = make_sine_wav()
        self.assertGreater(len(wav), 100)
        with make_client(settings=settings) as client:
            response = client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        self.assertEqual(response.status_code, 413)

    def test_rejects_malformed_audio_with_400(self):
        with make_client() as client:
            response = client.post(
                "/v1/transcribe",
                content=b"this is not a wav file at all",
                headers={"Content-Type": "audio/wav"},
            )
        self.assertEqual(response.status_code, 400)

    def test_rejects_wrong_sample_rate_with_400(self):
        wav = make_sine_wav(sample_rate=8000)
        with make_client() as client:
            response = client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        self.assertEqual(response.status_code, 400)

    def test_rejects_stereo_with_400(self):
        wav = make_sine_wav(channels=2)
        with make_client() as client:
            response = client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        self.assertEqual(response.status_code, 400)

    def test_rejects_unknown_content_type_with_400(self):
        with make_client() as client:
            response = client.post(
                "/v1/transcribe",
                content=b"\x00" * 64,
                headers={"Content-Type": "application/octet-stream"},
            )
        self.assertEqual(response.status_code, 400)

    def test_503_when_model_not_warm(self):
        wav = make_sine_wav()
        with make_client(factory=BrokenTranscriber) as client:
            response = client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        self.assertEqual(response.status_code, 503)


class DecodeUnitTest(unittest.TestCase):
    def test_decode_wav_rejects_empty_frames(self):
        buf = io.BytesIO()
        with wave.open(buf, "wb") as wav:
            wav.setnchannels(1)
            wav.setsampwidth(2)
            wav.setframerate(16000)
            wav.writeframes(b"")
        with self.assertRaises(MalformedAudio):
            decode_wav(buf.getvalue())

    def test_decode_raw_pcm_rejects_misaligned(self):
        with self.assertRaises(MalformedAudio):
            decode_raw_pcm(b"\x01\x02\x03", 16000, 1, 2)

    def test_decode_raw_pcm_rejects_wrong_rate(self):
        with self.assertRaises(MalformedAudio):
            decode_raw_pcm(b"\x01\x02" * 100, 8000, 1, 2)


class PrivacyTest(unittest.TestCase):
    def test_transcript_never_logged(self):
        wav = make_sine_wav()
        with self.assertLogs("aman_stt", level=logging.INFO) as captured:
            with make_client() as client:
                client.post("/v1/transcribe", content=wav, headers={"Content-Type": "audio/wav"})
        log_text = "\n".join(captured.output)
        self.assertNotIn("synthetic transcript", log_text)


if __name__ == "__main__":
    unittest.main()
