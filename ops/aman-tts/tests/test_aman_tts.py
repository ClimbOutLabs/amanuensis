import hashlib
import io
import json
import logging
import os
import sys
import tempfile
import unittest
import wave
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import aman_tts  # noqa: E402
import build_assets  # noqa: E402
from aman_tts import AssetVerificationError, Settings, create_app, encode_wav, verify_model_file  # noqa: E402
from phonemes import Lexicon, number_words, ordinal_words, normalize, split_chunks, to_phonemes  # noqa: E402
from pins import PinnedAsset  # noqa: E402

SECRET_TEXT = "my bank password is hunter two"


class FakeSynthesizer:
    """Returns a short tone; never touches a real model."""

    model_label = "kokoro-82m-v1.0-int8"
    voices = ("af_heart", "am_michael")
    calls: list[tuple[str, str]] = []

    def __init__(self, settings: Settings) -> None:
        FakeSynthesizer.calls = []

    def speak(self, text: str, voice: str) -> np.ndarray:
        FakeSynthesizer.calls.append((text, voice))
        return np.sin(np.linspace(0, 100, 2400, dtype=np.float32)) * 0.5


class SilentSynthesizer(FakeSynthesizer):
    def speak(self, text: str, voice: str) -> np.ndarray:
        return np.zeros(0, dtype=np.float32)


class BrokenSynthesizer:
    def __init__(self, settings: Settings) -> None:
        raise AssetVerificationError("SHA-256 mismatch for model.onnx")


def client_for(factory, **settings) -> TestClient:
    return TestClient(create_app(Settings(**settings), synthesizer_factory=factory))


class HealthTest(unittest.TestCase):
    def test_reports_loaded_model_and_voices(self):
        with client_for(FakeSynthesizer) as client:
            body = client.get("/healthz").json()
        self.assertEqual(
            body,
            {
                "status": "ok",
                "model_loaded": True,
                "model_error": None,
                "voices": ["af_heart", "am_michael"],
                "default_voice": "af_heart",
            },
        )

    def test_reports_load_failure(self):
        with client_for(BrokenSynthesizer) as client:
            body = client.get("/healthz").json()
            speak = client.post("/v1/speak", json={"text": "hello"})
        self.assertFalse(body["model_loaded"])
        self.assertIn("SHA-256 mismatch", body["model_error"])
        self.assertEqual(speak.status_code, 503)

    def test_default_voice_must_be_baked(self):
        with client_for(FakeSynthesizer, default_voice="zz_missing") as client:
            body = client.get("/healthz").json()
        self.assertFalse(body["model_loaded"])
        self.assertIn("zz_missing", body["model_error"])


class SpeakTest(unittest.TestCase):
    def test_returns_wav(self):
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "Hello there.", "voice": "am_michael"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "audio/wav")
        self.assertEqual(res.headers["x-voice"], "am_michael")
        with wave.open(io.BytesIO(res.content)) as wav:
            self.assertEqual((wav.getnchannels(), wav.getsampwidth(), wav.getframerate()), (1, 2, 24000))
            self.assertEqual(wav.getnframes(), 2400)
        self.assertEqual(FakeSynthesizer.calls[-1], ("Hello there.", "am_michael"))

    def test_uses_default_voice(self):
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "Hi."})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(FakeSynthesizer.calls[-1][1], "af_heart")

    def test_refuses_text_over_the_cap(self):
        with client_for(FakeSynthesizer, max_text_chars=10) as client:
            res = client.post("/v1/speak", json={"text": "x" * 11})
        self.assertEqual(res.status_code, 413)

    def test_refuses_oversized_body_before_parsing(self):
        with client_for(FakeSynthesizer, max_text_chars=10) as client:
            res = client.post(
                "/v1/speak", content=json.dumps({"text": "x" * 5000}), headers={"content-type": "application/json"}
            )
        self.assertEqual(res.status_code, 413)

    def test_rejects_bad_requests(self):
        with client_for(FakeSynthesizer) as client:
            cases = [
                client.post("/v1/speak", content=b"hello", headers={"content-type": "text/plain"}),
                client.post("/v1/speak", content=b"{", headers={"content-type": "application/json"}),
                client.post("/v1/speak", json=["hello"]),
                client.post("/v1/speak", json={"text": 5}),
                client.post("/v1/speak", json={"text": "   "}),
                client.post("/v1/speak", json={"text": "hi", "voice": "nobody"}),
                client.post("/v1/speak", json={"text": "hi", "voice": 3}),
            ]
        self.assertEqual([res.status_code for res in cases], [400] * len(cases))

    def test_nothing_to_say_is_a_bad_request(self):
        with client_for(SilentSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "```code only```"})
        self.assertEqual(res.status_code, 400)


class PrivacyTest(unittest.TestCase):
    def test_text_never_logged(self):
        with self.assertLogs("aman_tts", level=logging.DEBUG) as logs:
            with client_for(FakeSynthesizer) as client:
                client.post("/v1/speak", json={"text": SECRET_TEXT})
        joined = "\n".join(logs.output)
        self.assertIn("speak ok", joined)
        self.assertNotIn("hunter", joined)


class EncodeWavTest(unittest.TestCase):
    def test_clips_out_of_range_samples(self):
        data = encode_wav(np.array([2.0, -2.0, 0.0], dtype=np.float32))
        with wave.open(io.BytesIO(data)) as wav:
            frames = np.frombuffer(wav.readframes(3), dtype="<i2")
        self.assertEqual(frames.tolist(), [32767, -32767, 0])


class ModelVerificationTest(unittest.TestCase):
    def test_refuses_a_tampered_model(self):
        with tempfile.NamedTemporaryFile() as fh:
            fh.write(b"not the model")
            fh.flush()
            with self.assertRaises(AssetVerificationError):
                verify_model_file(fh.name)

    def test_accepts_the_pinned_hash(self):
        with tempfile.NamedTemporaryFile() as fh:
            fh.write(b"model bytes")
            fh.flush()
            pinned = mock.Mock(sha256=hashlib.sha256(b"model bytes").hexdigest())
            with mock.patch.object(aman_tts, "MODEL_ASSET", pinned):
                verify_model_file(fh.name)

    def test_missing_model_is_a_verification_error(self):
        with self.assertRaises(AssetVerificationError):
            verify_model_file("/nonexistent/model.onnx")


class BuildAssetsTest(unittest.TestCase):
    def asset(self, data: bytes) -> PinnedAsset:
        return PinnedAsset("x", "https://example.invalid/x", len(data), hashlib.sha256(data).hexdigest(), "MIT")

    def test_verify_bytes(self):
        build_assets.verify_bytes(self.asset(b"abc"), b"abc")
        with self.assertRaises(build_assets.AssetVerificationError):
            build_assets.verify_bytes(self.asset(b"abc"), b"abd")
        with self.assertRaises(build_assets.AssetVerificationError):
            build_assets.verify_bytes(self.asset(b"abc"), b"abcd")

    def test_select_voices_keeps_only_baked_voices(self):
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w") as archive:
            for name in ("af_heart", "af_bella", "bf_emma"):
                archive.writestr(f"{name}.npy", name)
        out = build_assets.select_voices(buf.getvalue(), ("af_heart", "af_bella"))
        with zipfile.ZipFile(io.BytesIO(out)) as archive:
            self.assertEqual(sorted(archive.namelist()), ["af_bella.npy", "af_heart.npy"])
        with self.assertRaises(build_assets.AssetVerificationError):
            build_assets.select_voices(buf.getvalue(), ("am_nobody",))


LEXICON = Lexicon(
    {
        "hello": "həlˈO",
        "world": "wˈɜɹld",
        "the": "ði",
        "read": {"DEFAULT": "ɹˈid", "VBD": "ɹˈɛd"},
        "cat": "kˈæt",
        "bus": "bˈʌs",
        "walk": "wˈɔk",
        "jump": "ʤˈʌmp",
        "quick": "kwˈɪk",
        "a": "A",
        "link": "lˈɪŋk",
        "G": "ʤˈi",
        "P": "pˈi",
        "U": "jˈu",
    },
    {"twelve": "twˈɛlv", "dollars": "dˈɑləɹz", "fifty": "fˈɪfti"},
)


class PhonemesTest(unittest.TestCase):
    def test_numbers(self):
        self.assertEqual(number_words(0), ["zero"])
        self.assertEqual(number_words(15), ["fifteen"])
        self.assertEqual(number_words(2026), ["two", "thousand", "twenty", "six"])
        self.assertEqual(number_words(1_000_001), ["one", "million", "one"])
        self.assertEqual(ordinal_words(2), ["second"])
        self.assertEqual(ordinal_words(20), ["twentieth"])
        self.assertEqual(ordinal_words(21), ["twenty", "first"])

    def test_normalize_strips_markdown(self):
        text = "# Plan\n- **Buy** milk\n- See [the docs](https://x.io)\n```\ncode()\n```\nDone"
        self.assertEqual(normalize(text), "Plan. Buy milk. See the docs. Done.")
        self.assertEqual(normalize("Go to https://x.io now"), "Go to a link now.")

    def test_words_and_punctuation(self):
        self.assertEqual(to_phonemes("Hello, world!", LEXICON), "həlˈO, wˈɜɹld!")
        self.assertEqual(to_phonemes("Read the link.", LEXICON), "ɹˈid ði lˈɪŋk.")

    def test_endings_from_the_base_word(self):
        self.assertEqual(to_phonemes("cats buses walked jumping quickly", LEXICON), "kˈæts bˈʌsɪz wˈɔkt ʤˈʌmpɪŋ kwˈɪkli.")

    def test_short_capitals_are_spelled(self):
        self.assertEqual(to_phonemes("GPU", LEXICON), "ʤˈi pˈi jˈu.")

    def test_money(self):
        self.assertEqual(to_phonemes("$12.50", LEXICON), "twˈɛlv dˈɑləɹz fˈɪfti.")

    def test_unknown_words_are_sounded_out(self):
        self.assertEqual(to_phonemes("Zorp", LEXICON), "ˈzɔɹp.")

    def test_split_chunks_respects_the_limit(self):
        sentence = "wˈʌn tˈu θɹˈi."
        chunks = split_chunks(" ".join([sentence] * 20), limit=40)
        self.assertTrue(all(len(chunk) <= 40 for chunk in chunks))
        self.assertEqual(" ".join(chunks), " ".join([sentence] * 20))
        long_word_chunks = split_chunks("a" * 100, limit=40)
        self.assertEqual([len(chunk) for chunk in long_word_chunks], [40, 40, 20])


if __name__ == "__main__":
    unittest.main()
