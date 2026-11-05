import hashlib
import io
import json
import logging
import os
import asyncio
import sys
import tempfile
import threading
import unittest
import wave
import zipfile
from unittest import mock

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import numpy as np  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

import aman_tts  # noqa: E402
import build_assets  # noqa: E402
from aman_tts import AssetVerificationError, Settings, create_app, verify_model_file  # noqa: E402
from audio_formats import MULAW8K, PCM16, Encoder, encode_wav, mulaw_encode  # noqa: E402
from phonemes import (  # noqa: E402
    Lexicon,
    normalize,
    number_words,
    ordinal_words,
    split_chunks,
    split_sentences,
    to_phonemes,
    whole_words,
)
from pins import PinnedAsset  # noqa: E402

SECRET_TEXT = "my bank password is hunter two"


class FakeSynthesizer:
    """Returns a short tone; never touches a real model."""

    model_label = "kokoro-82m-v1.0-int8"
    voices = ("af_heart", "am_michael")
    calls: list[tuple[str, str]] = []

    def __init__(self, settings: Settings) -> None:
        FakeSynthesizer.calls = []

    def speak(self, text: str, voice: str, cancelled) -> np.ndarray:
        FakeSynthesizer.calls.append((text, voice))
        return np.sin(np.linspace(0, 100, 2400, dtype=np.float32)) * 0.5

    def speak_sentences(self, text: str, voice: str, cancelled):
        FakeSynthesizer.calls.append((text, voice))
        for _ in range(3):
            yield np.sin(np.linspace(0, 100, 2400, dtype=np.float32)) * 0.5


class SilentSynthesizer(FakeSynthesizer):
    def speak(self, text: str, voice: str, cancelled) -> np.ndarray:
        return np.zeros(0, dtype=np.float32)

    def speak_sentences(self, text: str, voice: str, cancelled):
        return iter(())


class LongTextSynthesizer(FakeSynthesizer):
    def speak(self, text: str, voice: str, cancelled) -> np.ndarray:
        if text != "Hello.":
            raise aman_tts.TextTooLong("too many sounds")
        return super().speak(text, voice, cancelled)

    def speak_sentences(self, text: str, voice: str, cancelled):
        raise aman_tts.TextTooLong("too many sounds")
        yield  # pragma: no cover


class BlockingSynthesizer(FakeSynthesizer):
    """Holds the one synthesis slot until released, so other requests have to wait."""

    started = threading.Event()
    release = threading.Event()

    def speak(self, text: str, voice: str, cancelled) -> np.ndarray:
        if text != "Hello.":
            BlockingSynthesizer.started.set()
            BlockingSynthesizer.release.wait(5)
        return super().speak(text, voice, cancelled)


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

    def test_too_many_sounds_after_spelling_out_is_413(self):
        with client_for(LongTextSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "%" * 600})
        self.assertEqual(res.status_code, 413)

    def test_busy_when_the_queue_is_full(self):
        BlockingSynthesizer.started.clear()
        BlockingSynthesizer.release.clear()
        with client_for(BlockingSynthesizer, max_waiting=0) as client:
            first: list[int] = []
            holder = threading.Thread(
                target=lambda: first.append(client.post("/v1/speak", json={"text": "One."}).status_code)
            )
            holder.start()
            self.assertTrue(BlockingSynthesizer.started.wait(5))
            busy = client.post("/v1/speak", json={"text": "Two."})
            BlockingSynthesizer.release.set()
            holder.join(5)
        self.assertEqual(busy.status_code, 429)
        self.assertEqual(busy.headers["retry-after"], "2")
        self.assertEqual(first, [200])

    def test_nothing_to_say_is_a_bad_request(self):
        with client_for(SilentSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "```code only```"})
        self.assertEqual(res.status_code, 400)


class FormatTest(unittest.TestCase):
    def test_pcm16_is_raw_24khz_samples(self):
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "Hi.", "format": "pcm16"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "audio/L16")
        self.assertEqual(res.headers["x-sample-rate"], "24000")
        self.assertEqual(len(res.content), 2400 * 2)

    def test_mulaw8k_is_one_byte_per_8khz_sample(self):
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "Hi.", "format": "mulaw8k"})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(res.headers["content-type"], "audio/basic")
        self.assertEqual(res.headers["x-sample-rate"], "8000")
        self.assertEqual(len(res.content), 800)

    def test_wav_stays_the_default_and_can_be_named(self):
        with client_for(FakeSynthesizer) as client:
            plain = client.post("/v1/speak", json={"text": "Hi."})
            named = client.post("/v1/speak", json={"text": "Hi.", "format": "wav"})
        self.assertEqual(plain.content, named.content)
        self.assertEqual(plain.headers["content-type"], "audio/wav")

    def test_bad_format_options_are_refused(self):
        with client_for(FakeSynthesizer) as client:
            cases = [
                client.post("/v1/speak", json={"text": "Hi.", "format": "mp3"}),
                client.post("/v1/speak", json={"text": "Hi.", "format": 3}),
                client.post("/v1/speak", json={"text": "Hi.", "stream": "yes"}),
                client.post("/v1/speak", json={"text": "Hi.", "stream": True}),
                client.post("/v1/speak", json={"text": "Hi.", "stream": True, "format": "wav"}),
            ]
        self.assertEqual([res.status_code for res in cases], [400] * len(cases))


class AudioFormatsTest(unittest.TestCase):
    def test_mulaw_matches_the_g711_reference_values(self):
        pcm = np.array([0, 32767, -32768, 1000, -1000], dtype="<i2")
        self.assertEqual(list(mulaw_encode(pcm)), [0xFF, 0x80, 0x00, 0xCE, 0x4E])

    def tone_power(self, data: np.ndarray, hz: float, rate: int) -> float:
        t = np.arange(len(data)) / rate
        return abs(np.sum(data * np.exp(-2j * np.pi * hz * t))) / len(data)

    def decode(self, data: bytes) -> np.ndarray:
        raw = (~np.frombuffer(data, dtype=np.uint8) & 0xFF).astype(np.int32)
        sign = np.where(raw & 0x80, -1.0, 1.0)
        exponent = (raw >> 4) & 0x07
        mantissa = raw & 0x0F
        return sign * (((mantissa << 3) + 0x84) * (1 << exponent) - 0x84) / 32768.0

    def test_a_voice_band_tone_survives_and_one_above_the_phone_band_does_not(self):
        t = np.arange(24000) / 24000
        voice = Encoder(MULAW8K).feed((0.5 * np.sin(2 * np.pi * 1000 * t)).astype(np.float32))
        high = Encoder(MULAW8K).feed((0.5 * np.sin(2 * np.pi * 7000 * t)).astype(np.float32))
        self.assertEqual(len(voice), 8000)
        self.assertGreater(self.tone_power(self.decode(voice), 1000, 8000), 0.2)
        self.assertLess(self.tone_power(self.decode(high), 1000, 8000), 0.02)
        self.assertLess(np.sqrt(np.mean(self.decode(high) ** 2)), 0.03)

    def test_pieces_join_without_a_seam(self):
        t = np.arange(24000) / 24000
        tone = (0.5 * np.sin(2 * np.pi * 440 * t)).astype(np.float32)
        whole = Encoder(MULAW8K)
        pieces = Encoder(MULAW8K)
        expected = whole.feed(tone)
        got = b"".join(pieces.feed(tone[i : i + 1999]) for i in range(0, len(tone), 1999))
        self.assertEqual(got, expected)

    def test_pcm16_pieces_are_plain_samples(self):
        data = Encoder(PCM16).feed(np.array([0.5, -0.5], dtype=np.float32))
        self.assertEqual(np.frombuffer(data, dtype="<i2").tolist(), [16383, -16383])

    def test_one_piece_per_sentence_when_streaming(self):
        self.assertEqual(split_sentences("a. b! c?"), ["a.", "b!", "c?"])


def asgi_post(app, body: dict):
    """Runs one request straight against the app and records each sent message as it happens."""
    raw = json.dumps(body).encode()
    sent: list[dict] = []
    scope = {
        "type": "http",
        "asgi": {"version": "3.0", "spec_version": "2.3"},
        "http_version": "1.1",
        "method": "POST",
        "path": "/v1/speak",
        "raw_path": b"/v1/speak",
        "query_string": b"",
        "headers": [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())],
        "client": ("test", 1),
        "server": ("test", 80),
        "scheme": "http",
    }
    delivered = False
    hang_up = asyncio.Event()

    async def receive():
        nonlocal delivered
        if not delivered:
            delivered = True
            return {"type": "http.request", "body": raw, "more_body": False}
        await hang_up.wait()
        return {"type": "http.disconnect"}

    async def send(message):
        sent.append(message)

    return scope, receive, send, sent, hang_up


class StreamingTest(unittest.TestCase):
    def test_streams_every_sentence_in_order_as_raw_audio(self):
        with client_for(FakeSynthesizer) as client:
            with client.stream("POST", "/v1/speak", json={"text": "One. Two. Three.", "format": "pcm16", "stream": True}) as res:
                body = b"".join(res.iter_raw())
            self.assertEqual(res.status_code, 200)
            self.assertEqual(res.headers["content-type"], "audio/L16")
        self.assertEqual(len(body), 3 * 2400 * 2)

    def test_streams_mulaw_for_a_phone_line(self):
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "One. Two.", "format": "mulaw8k", "stream": True})
        self.assertEqual(res.status_code, 200)
        self.assertEqual(len(res.content), 3 * 800)

    def test_first_audio_is_sent_before_the_second_sentence_is_made(self):
        first_sent = threading.Event()
        second_started_after_first_sent: list[bool] = []

        class TwoSentences(FakeSynthesizer):
            def speak_sentences(self, text, voice, cancelled):
                yield np.zeros(2400, dtype=np.float32)
                second_started_after_first_sent.append(first_sent.wait(5))
                yield np.zeros(2400, dtype=np.float32)

        app = create_app(Settings(), synthesizer_factory=TwoSentences)

        async def go():
            async with app.router.lifespan_context(app):
                scope, receive, send, sent, _ = asgi_post(app, {"text": "A. B.", "format": "pcm16", "stream": True})

                async def watching_send(message):
                    if message["type"] == "http.response.body" and message.get("body"):
                        first_sent.set()
                    await send(message)

                await app(scope, receive, watching_send)
                return sent

        sent = asyncio.run(go())
        self.assertEqual(second_started_after_first_sent, [True])
        bodies = [m["body"] for m in sent if m["type"] == "http.response.body" and m.get("body")]
        self.assertEqual(len(bodies), 2)

    def test_text_over_the_sound_cap_is_a_413_before_any_audio(self):
        with client_for(LongTextSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "%" * 600, "format": "pcm16", "stream": True})
        self.assertEqual(res.status_code, 413)

    def test_nothing_to_say_is_a_400(self):
        with client_for(SilentSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "```x```", "format": "pcm16", "stream": True})
        self.assertEqual(res.status_code, 400)

    def test_the_slot_comes_back_after_a_stream_so_the_next_request_is_served(self):
        with client_for(FakeSynthesizer, max_waiting=0) as client:
            for _ in range(3):
                res = client.post("/v1/speak", json={"text": "One.", "format": "pcm16", "stream": True})
                self.assertEqual(res.status_code, 200)

    def test_a_caller_that_hangs_up_stops_the_work(self):
        made: list[int] = []
        stopped = threading.Event()

        class Endless(FakeSynthesizer):
            def speak_sentences(self, text, voice, cancelled):
                for index in range(1000):
                    if cancelled():
                        stopped.set()
                        raise aman_tts.SpeechCancelled()
                    made.append(index)
                    yield np.zeros(2400, dtype=np.float32)
                    threading.Event().wait(0.01)

        app = create_app(Settings(), synthesizer_factory=Endless)

        async def go():
            async with app.router.lifespan_context(app):
                scope, receive, send, sent, hang_up = asgi_post(app, {"text": "Go.", "format": "pcm16", "stream": True})
                task = asyncio.create_task(app(scope, receive, send))
                await asyncio.sleep(0.2)
                hang_up.set()
                await asyncio.wait_for(task, 5)
                await asyncio.to_thread(stopped.wait, 5)

        asyncio.run(go())
        self.assertTrue(stopped.is_set())
        self.assertLess(len(made), 1000)


class CancelTest(unittest.TestCase):
    def test_reading_stops_between_pieces_once_the_caller_hangs_up(self):
        pieces: list[int] = []

        class Request:
            def __init__(self) -> None:
                self.checks = 0

            async def is_disconnected(self) -> bool:
                self.checks += 1
                return self.checks > 1

        class Slow(FakeSynthesizer):
            def speak(self, text, voice, cancelled):
                for piece in range(100):
                    if cancelled():
                        raise aman_tts.SpeechCancelled()
                    pieces.append(piece)
                    threading.Event().wait(0.05)
                return super().speak(text, voice, cancelled)

        result = asyncio.run(aman_tts._speak_until_disconnect(Request(), Slow(Settings()), "Long text.", "af_heart"))
        self.assertIsNone(result)
        self.assertLess(len(pieces), 100)

    def test_a_caller_gone_before_its_turn_is_never_read(self):
        class Gone:
            async def is_disconnected(self) -> bool:
                return True

        FakeSynthesizer.calls = []
        result = asyncio.run(aman_tts._speak_until_disconnect(Gone(), FakeSynthesizer(Settings()), "Hi.", "af_heart"))
        self.assertIsNone(result)
        self.assertEqual(FakeSynthesizer.calls, [])


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

    def test_long_digit_runs_are_read_one_by_one(self):
        digits = "7" * 5000
        self.assertEqual(whole_words(digits)[:3], ["seven", "seven", "seven"])
        self.assertEqual(whole_words("1000"), ["one", "thousand"])
        self.assertTrue(to_phonemes(f"Code {digits}.", LEXICON))
        self.assertTrue(to_phonemes(f"${digits}.50 and {digits}th", LEXICON))

    def test_split_chunks_respects_the_limit(self):
        sentence = "wˈʌn tˈu θɹˈi."
        chunks = split_chunks(" ".join([sentence] * 20), limit=40)
        self.assertTrue(all(len(chunk) <= 40 for chunk in chunks))
        self.assertEqual(" ".join(chunks), " ".join([sentence] * 20))
        long_word_chunks = split_chunks("a" * 100, limit=40)
        self.assertEqual([len(chunk) for chunk in long_word_chunks], [40, 40, 20])


if __name__ == "__main__":
    unittest.main()
