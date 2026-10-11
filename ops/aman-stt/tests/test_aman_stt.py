import io
import logging
import math
import os
import struct
import sys
import tempfile
import unittest
import wave
from unittest import mock


sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import hashlib  # noqa: E402

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import aman_stt  # noqa: E402
from aman_stt import (  # noqa: E402
    MalformedAudio,
    ModelVerificationError,
    PinnedModel,
    Settings,
    _load_first_verified,
    create_app,
    decode_raw_pcm,
    decode_wav,
    ensure_verified_model_dir,
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
    primary_error: str | None = None
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
        self.assertEqual(
            response.json(),
            {"status": "ok", "model_loaded": True, "model_error": None},
        )

    def test_model_not_loaded_when_factory_fails(self):
        with make_client(factory=BrokenTranscriber) as client:
            response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        body = response.json()
        self.assertEqual(body["status"], "ok")
        self.assertFalse(body["model_loaded"])
        self.assertIn("no model here", body["model_error"])


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


class PinnedModelTest(unittest.TestCase):
    """Model weight pinning: synthetic files and a fake downloader only.

    Never touches the network or real weights. Each test fails if the
    check it covers is removed from the implementation.
    """

    FAKE_FILES = {
        "config.json": b'{"fake": true}',
        "model.bin": b"\x00\x01\x02" * 64,
        "tokenizer.json": b"{}",
        "vocabulary.txt": b"a\nb\n",
    }

    def _fake_pinned(self, repo="FakeOrg/fake-model", revision="a" * 40, files=None):
        contents = files if files is not None else self.FAKE_FILES
        return PinnedModel(
            repo=repo,
            revision=revision,
            files={
                name: hashlib.sha256(data).hexdigest()
                for name, data in contents.items()
            },
        )

    def _write_snapshot(self, repo, revision, files):
        snap = os.path.join(
            self.cache_dir,
            "models--" + repo.replace("/", "--"),
            "snapshots",
            revision,
        )
        os.makedirs(snap, exist_ok=True)
        for name, data in files.items():
            with open(os.path.join(snap, name), "wb") as fh:
                fh.write(data)
        return snap

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.cache_dir = os.path.join(self.tmp.name, "cache")
        self.pinned = self._fake_pinned()
        patcher = mock.patch.dict(aman_stt.PINNED_MODELS, {"t": self.pinned})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.downloads = []

        def fake_downloader(pinned, cache_dir):
            self.downloads.append((pinned.repo, pinned.revision))
            return self._write_snapshot(pinned.repo, pinned.revision, self.FAKE_FILES)

        self.fake_downloader = fake_downloader

    def _ensure(self, size="t", downloader=None):
        return ensure_verified_model_dir(
            model_size=size,
            cache_dir=self.cache_dir,
            downloader=downloader or self.fake_downloader,
        )

    def test_good_cache_loads(self):
        snapshot = self._ensure()
        self.assertTrue(os.path.isdir(snapshot))
        self.assertEqual(self.downloads, [(self.pinned.repo, self.pinned.revision)])

    def test_unpinned_size_is_refused_without_download(self):
        with self.assertRaisesRegex(ModelVerificationError, "no pinned revision"):
            self._ensure(size="tiny")
        self.assertEqual(self.downloads, [])

    def test_tampered_file_is_refused(self):
        tampered = dict(self.FAKE_FILES)
        tampered["model.bin"] = b"tampered!"

        def dl(pinned, cache_dir):
            return self._write_snapshot(pinned.repo, pinned.revision, tampered)

        with self.assertRaisesRegex(ModelVerificationError, "mismatch"):
            self._ensure(downloader=dl)

    def test_missing_file_is_refused(self):
        short = {k: v for k, v in self.FAKE_FILES.items() if k != "tokenizer.json"}

        def dl(pinned, cache_dir):
            return self._write_snapshot(pinned.repo, pinned.revision, short)

        with self.assertRaisesRegex(ModelVerificationError, "missing"):
            self._ensure(downloader=dl)

    def test_wrong_revision_is_refused(self):
        other_revision = "b" * 40

        def dl(pinned, cache_dir):
            return self._write_snapshot(pinned.repo, other_revision, self.FAKE_FILES)

        with self.assertRaisesRegex(ModelVerificationError, "revision mismatch"):
            self._ensure(downloader=dl)

    def test_offline_start_loads_from_verified_cache(self):
        self._write_snapshot(self.pinned.repo, self.pinned.revision, self.FAKE_FILES)

        def no_network(pinned, cache_dir):
            raise AssertionError("network must not be touched on a warm cache")

        snapshot = self._ensure(downloader=no_network)
        self.assertTrue(os.path.isdir(snapshot))

    def test_offline_cache_with_tampered_file_is_still_refused(self):
        tampered = dict(self.FAKE_FILES)
        tampered["config.json"] = b"{}"
        self._write_snapshot(self.pinned.repo, self.pinned.revision, tampered)

        def no_network(pinned, cache_dir):
            raise AssertionError("network must not be touched")

        with self.assertRaisesRegex(ModelVerificationError, "mismatch"):
            self._ensure(downloader=no_network)

    def test_fallback_model_follows_same_rules(self):
        primary = self._fake_pinned(repo="FakeOrg/fake-primary")
        fallback = self._fake_pinned(repo="FakeOrg/fake-fallback")
        with mock.patch.dict(aman_stt.PINNED_MODELS, {"t": primary, "f": fallback}):
            tampered = dict(self.FAKE_FILES)
            tampered["model.bin"] = b"tampered!"
            self._write_snapshot(primary.repo, primary.revision, tampered)
            self._write_snapshot(fallback.repo, fallback.revision, self.FAKE_FILES)

            def no_network(pinned, cache_dir):
                raise AssertionError("network must not be touched")

            loaded = []

            def fake_factory(snapshot_dir):
                loaded.append(snapshot_dir)
                return object()

            model, size, primary_error = _load_first_verified(
                ("t", "f"), self.cache_dir, no_network, fake_factory
            )
            self.assertEqual(size, "f")
            self.assertEqual(len(loaded), 1)
            self.assertIn("fake-fallback", loaded[0])

    def test_all_models_failing_raises(self):
        def dl(pinned, cache_dir):
            return self._write_snapshot(pinned.repo, pinned.revision, {})

        with self.assertRaises(ModelVerificationError):
            _load_first_verified(("t",), self.cache_dir, dl, lambda d: object())

    def test_missing_file_retries_download_once(self):
        # Warm cache with a missing file (interrupted download): the
        # snapshot is removed and downloaded again, exactly once.
        short = {k: v for k, v in self.FAKE_FILES.items() if k != "tokenizer.json"}
        self._write_snapshot(self.pinned.repo, self.pinned.revision, short)
        calls = []

        def dl(pinned, cache_dir):
            calls.append((pinned.repo, pinned.revision))
            return self._write_snapshot(pinned.repo, pinned.revision, self.FAKE_FILES)

        snapshot = self._ensure(downloader=dl)
        self.assertTrue(os.path.isdir(snapshot))
        self.assertEqual(len(calls), 1)
        # All files are present after the retry.
        for name in self.FAKE_FILES:
            self.assertTrue(os.path.isfile(os.path.join(snapshot, name)))

    def test_missing_file_after_download_is_hard_failure(self):
        # If the download itself leaves a file missing, there is no second retry.
        short = {k: v for k, v in self.FAKE_FILES.items() if k != "tokenizer.json"}
        calls = []

        def dl(pinned, cache_dir):
            calls.append((pinned.repo, pinned.revision))
            return self._write_snapshot(pinned.repo, pinned.revision, short)

        with self.assertRaisesRegex(ModelVerificationError, "missing"):
            self._ensure(downloader=dl)
        self.assertEqual(len(calls), 1)

    def test_unpinned_preprocessor_config_is_refused(self):
        # faster-whisper reads preprocessor_config.json when present; the
        # pinned revisions do not ship it, so its presence is refused.
        extra = dict(self.FAKE_FILES)
        extra["preprocessor_config.json"] = b'{"fake": true}'

        def dl(pinned, cache_dir):
            return self._write_snapshot(pinned.repo, pinned.revision, extra)

        with self.assertRaisesRegex(ModelVerificationError, "unpinned loader-read file"):
            self._ensure(downloader=dl)

    def test_primary_error_returned_when_fallback_loads(self):
        primary = self._fake_pinned(repo="FakeOrg/fake-primary")
        fallback = self._fake_pinned(repo="FakeOrg/fake-fallback")
        with mock.patch.dict(aman_stt.PINNED_MODELS, {"t": primary, "f": fallback}):
            tampered = dict(self.FAKE_FILES)
            tampered["model.bin"] = b"tampered!"
            self._write_snapshot(primary.repo, primary.revision, tampered)
            self._write_snapshot(fallback.repo, fallback.revision, self.FAKE_FILES)

            def no_network(pinned, cache_dir):
                raise AssertionError("network must not be touched")

            loaded = []

            def fake_factory(snapshot_dir):
                loaded.append(snapshot_dir)
                return object()

            _model, size, primary_error = _load_first_verified(
                ("t", "f"), self.cache_dir, no_network, fake_factory
            )
            self.assertEqual(size, "f")
            self.assertIsNotNone(primary_error)
            self.assertIn("t", primary_error)
            self.assertIn("mismatch", primary_error)


class PinnedModelsShapeTest(unittest.TestCase):
    """The real PINNED_MODELS table has the shape the loader requires."""

    REQUIRED_FILES = frozenset(
        {"config.json", "model.bin", "tokenizer.json", "vocabulary.txt"}
    )

    def test_revisions_are_40_hex(self):
        import re

        for size, pinned in aman_stt.PINNED_MODELS.items():
            self.assertRegex(
                pinned.revision,
                r"^[0-9a-f]{40}$",
                f"revision for {size!r} must be a 40-char hex commit hash",
            )

    def test_hashes_are_64_hex(self):
        import re

        for size, pinned in aman_stt.PINNED_MODELS.items():
            for name, digest in pinned.files.items():
                self.assertRegex(
                    digest,
                    r"^[0-9a-f]{64}$",
                    f"hash for {size!r}/{name} must be a 64-char hex SHA-256",
                )

    def test_full_required_file_set(self):
        for size, pinned in aman_stt.PINNED_MODELS.items():
            self.assertEqual(
                set(pinned.files),
                self.REQUIRED_FILES,
                f"pinned files for {size!r} must be exactly the loader-required set",
            )

    def test_loader_read_files_covered(self):
        # Every file the loader may read is either pinned or fail-closed.
        for size, pinned in aman_stt.PINNED_MODELS.items():
            for name in aman_stt.LOADER_READ_FILES:
                if name not in pinned.files:
                    # Unpinned loader-read files must be refused when present;
                    # verify_model_files enforces this.
                    self.assertIn(name, {"preprocessor_config.json"})


class HealthzPrimaryErrorTest(unittest.TestCase):
    """A fallback load still reports the primary's verification error."""

    def test_healthz_reports_primary_error_when_fallback_loads(self):
        class PrimaryFailsFallbackLoads:
            model_label = "whisper-base-int8"
            primary_error = "small: SHA-256 mismatch for model.bin"

            def __init__(self, settings):
                pass

            def warmup(self):
                pass

            def transcribe(self, audio, language):
                return "x", "en"

        settings = Settings()
        FakeTranscriber.instances.clear()
        app = create_app(settings=settings, transcriber_factory=PrimaryFailsFallbackLoads)
        with TestClient(app) as client:
            response = client.get("/healthz")
        body = response.json()
        self.assertTrue(body["model_loaded"])
        self.assertIsNotNone(body["model_error"])
        self.assertIn("small", body["model_error"])


if __name__ == "__main__":
    unittest.main()
