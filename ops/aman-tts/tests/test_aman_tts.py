import hashlib
import io
import json
import logging
import os
import asyncio
import contextlib
import sys
import tempfile
import threading
import time
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
from phonemes import Lexicon, number_words, ordinal_words, normalize, split_chunks, to_phonemes, whole_words  # noqa: E402
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


class SilentSynthesizer(FakeSynthesizer):
    def speak(self, text: str, voice: str, cancelled) -> np.ndarray:
        return np.zeros(0, dtype=np.float32)


class LongTextSynthesizer(FakeSynthesizer):
    def speak(self, text: str, voice: str, cancelled) -> np.ndarray:
        if text != "Hello.":
            raise aman_tts.TextTooLong("too many sounds")
        return super().speak(text, voice, cancelled)


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

    def test_a_caller_who_hangs_up_while_waiting_gives_up_its_place(self):
        BlockingSynthesizer.started.clear()
        BlockingSynthesizer.release.clear()
        with client_for(BlockingSynthesizer, max_waiting=1) as client:
            statuses: list[int] = []

            def post(text: str) -> None:
                statuses.append(client.post("/v1/speak", json={"text": text}).status_code)

            holder = threading.Thread(target=post, args=("One.",))
            holder.start()
            self.assertTrue(BlockingSynthesizer.started.wait(5))

            async def hang_up_while_waiting() -> None:
                body = json.dumps({"text": "Two."}).encode()
                sent = False
                hang_up_at = time.monotonic() + 0.3

                # Like a real server: the disconnect is ready at once after the caller has gone.
                async def receive() -> dict:
                    nonlocal sent
                    if not sent:
                        sent = True
                        return {"type": "http.request", "body": body, "more_body": False}
                    if time.monotonic() < hang_up_at:
                        await asyncio.sleep(hang_up_at - time.monotonic())
                    return {"type": "http.disconnect"}

                async def send(message: dict) -> None:
                    pass

                scope = {
                    "type": "http",
                    "asgi": {"version": "3.0"},
                    "http_version": "1.1",
                    "method": "POST",
                    "scheme": "http",
                    "path": "/v1/speak",
                    "raw_path": b"/v1/speak",
                    "query_string": b"",
                    "root_path": "",
                    "headers": [(b"content-type", b"application/json"), (b"host", b"testserver")],
                    "client": ("testclient", 50000),
                    "server": ("testserver", 80),
                }
                await client.app(scope, receive, send)

            gone = threading.Thread(target=client.portal.call, args=(hang_up_while_waiting,), daemon=True)
            gone.start()
            gone.join(3)
            # Before the holder finishes, the gone caller has already left the line.
            left_the_line = not gone.is_alive()
            if left_the_line:
                third = threading.Thread(target=post, args=("Three.",))
                third.start()
                third.join(0.5)
            BlockingSynthesizer.release.set()
            holder.join(5)
            if left_the_line:
                third.join(5)
        self.assertTrue(left_the_line)
        self.assertEqual(sorted(statuses), [200, 200])

    def test_nothing_to_say_is_a_bad_request(self):
        with client_for(SilentSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "```code only```"})
        self.assertEqual(res.status_code, 400)


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


class WaitForSlotTest(unittest.TestCase):
    class Caller:
        def __init__(self) -> None:
            self.gone = False

        async def is_disconnected(self) -> bool:
            return self.gone

    def test_a_release_and_a_hang_up_together_never_leave_the_slot_held(self):
        async def scenario() -> tuple[bool, bool]:
            slot = asyncio.Semaphore(1)
            await slot.acquire()
            caller = self.Caller()
            waiter = asyncio.create_task(aman_tts._wait_for_slot(caller, slot))
            await asyncio.sleep(0)
            # Both happen before the waiter looks again.
            slot.release()
            caller.gone = True
            got = await waiter
            await asyncio.sleep(0)
            return got, slot.locked()

        got, locked = asyncio.run(scenario())
        # Held only by a waiter that went on to use it; never left held by one that left. The exact hand-over
        # race is covered by the cancel test below.
        self.assertEqual(locked, got)

    def test_a_cancelled_wait_reaches_the_caller_and_frees_its_place(self):
        async def scenario() -> tuple[bool, bool]:
            slot = asyncio.Semaphore(1)
            await slot.acquire()
            waiter = asyncio.create_task(aman_tts._wait_for_slot(self.Caller(), slot))
            await asyncio.sleep(0.05)
            waiter.cancel()
            cancelled = False
            try:
                await waiter
            except asyncio.CancelledError:
                cancelled = True
            slot.release()
            await asyncio.sleep(0)
            return cancelled, slot.locked()

        cancelled, locked = asyncio.run(scenario())
        self.assertTrue(cancelled)
        self.assertFalse(locked)

    def test_a_cancel_as_the_slot_is_handed_over_does_not_keep_it(self):
        async def scenario() -> bool:
            slot = asyncio.Semaphore(1)
            await slot.acquire()
            waiter = asyncio.create_task(aman_tts._wait_for_slot(self.Caller(), slot))
            await asyncio.sleep(0.05)
            slot.release()
            waiter.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await waiter
            await asyncio.sleep(0)
            return slot.locked()

        self.assertFalse(asyncio.run(scenario()))


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
