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

# The service does not start without a shared secret, so every test runs with this one and its
# clients present it, as the app does.
TEST_SECRET = "test-secret-value-with-more-than-32-chars"
os.environ["SPEECH_SECRET"] = TEST_SECRET
SECRET_HEADERS = {"x-speech-secret": TEST_SECRET}

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
    reads_as_written,
    spoken_words,
    split_chunks,
    split_sentences,
    _tokens,
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
    return TestClient(create_app(Settings(**settings), synthesizer_factory=factory), headers=SECRET_HEADERS)


class SpokenWordsTest(unittest.TestCase):
    """What the voice says is the one thing the server may read a card back by, so it is checked here, once."""

    def test_says_plain_writing_as_written(self) -> None:
        for text in (
            "Thursday at three works for me, bring the form (really) \"now\".",
            "It is fine; see you in the e-mail thread... later!",
            "It's fine. Don't be late, it's noon.",
            "Write to bob at example dot com about it.",
            "Costs $1,200 or 15%, about 3.5 hours, at 9:30. Pay $40.50 & bring 2 photos.",
            "Use 500. Then wait.",
            "Don\u2019t be late.",
        ):
            with self.subTest(text=text):
                self.assertTrue(reads_as_written(text))

    def test_refuses_what_it_would_say_differently(self) -> None:
        for text in (
            "Pay $1,5 now.",  # heard as fifteen dollars
            "Codes 1,2,3",  # one hundred twenty three
            "Pay 10,00",  # one thousand
            "Pay $1.999",  # cents cut to two digits
            "Pay $1.5",  # fifty cents
            "Server 10.0.0.1",
            "Due 11.06.2026",
            "10:30:15",
            "1. apples",
            "- apples",
            "Pay $ now.",
            "The balance is -40 now.",
            "Open 9-5 on weekdays.",
            "The total is\v500) not 50.",
            "The total is\f500) not 50.",
            "The total is\x85500) not 50.",
            "See you at the caf\u00e9.",
            "\u041f\u0440\u0438\u0432\u0435\u0442",
            "\u4f60\u597d",
            "See https://example.com/pay today.",
            "See www.example.com today.",
            "Open [the form](https://example.com/form) please.",
            "Run ```rm -rf data``` now.",
            "The file is in /etc/hosts.",
            "Great \U0001f44d",
            "Use **bold** text.",
            "Don't\u200b do it.",
            "Pay 007.",  # leading zeros are lost
            "Account 0042",
            "Account 0012345",
            "Pay 10 000.",  # a space inside a number
            "Pay 5\u2009000",
            "Pay 5\u00a0000",
            "Write to bob at example.com about it.",  # a dot between letters is silent: my.bank.com sounds like mybank.com
            "Mail me at my-bank.com today.",
            "Mail me at my.bank.com today.",
            "Pay 1000 500 dollars.",  # two numbers side by side
            "Wire 100 20 3.",
            "Wire $5\u2070\u2070\u2070",  # superscripts fold to digits
            "Wire 10\u2076",
            "Pay \uff15\uff10\uff10",  # full-width digits
            "Pay \U0001d7d1\U0001d7ce\U0001d7ce",  # maths bold digits
            "At 9:60",
            "At 25:99",
            "At 24:00",
            "Wire 1000 (500) dollars.",  # numbers joined by a sign that makes no sound
            "Wire 1000(500)",
            "Wire 1000) 500",
            'Wire 1000 "500"',
            "Wire 1000'500",
            "Wire 1000\u2014500",
            "Wire 1000;500",
            "Wire 1000!500",
            "Wire 1000?500",
            "Wire 1000, 500",
            "Wire 1,000 (500).",
            "Wire $1000 (500).",
            'Account 12"34"56',
            "PIN 1 (2) 3 (4)",
            "Code 5 (0)(0)(0)",
            "Wire 1000 & 500",
            "Wire 5: 3 items",
            "Pay twenty 5 dollars.",  # a spelled number next to a digit
            "Pay 5 twenty dollars.",
            "Wire 5 hundred 3.",
            "Wire 1000\u2026500",  # a pause-only mark between numbers
            "Wire 1000 \u2026 500",
            "Wire 1000.;500",
            "Wire 1000.\u2014500",
            "Wire 1000. (500)",
            "Wire 1000... 500",
            "Wire 1000 (five hundred) dollars.",  # a number word and a digit apart by a silent sign
            "Pay twenty (5) dollars.",
            "Pay twenty, 5 dollars.",
            "Pay twenty;5 dollars.",
            "Pay 5 (hundred) dollars.",
            "Pay $5 (thousand) dollars.",
            "Pay twenty\u20265 dollars.",
            "Wire 10, 500 now.",  # a comma is a pause only between small numbers, a date or a time
            "Wire $5, 20 now.",
            "Wire 1000, 2026 now.",
            "Pay 19, 99 dollars.",  # a comma between small numbers is no day, year or time
            "Wire 15, 30 dollars.",
            "Pay 2, 50 now.",
            "Wire 20, 26 dollars.",
            "Send 12, 2000 dollars and 5, 7 cents.",
            "On May 1, 10 people came.",
            "Items 1, 2 and 3.",
            "Pay one thousand (five hundred) dollars.",  # number words either side of a bracket or quote
            "Pay twenty-five (hundred) dollars.",
            'Pay one thousand "five hundred" dollars.',
            "Pay 5 (thousands) dollars.",  # forms of number words
            "Wire 1000 and 500 dollars.",
            "Wire 1000 and $500 today.",  # "and" inside a number, in every disguise
            "Wire 1000 (and 500) now.",
            'Wire 1000 "and" 500 now.',
            "Wire 1000\tand 500 now.",
            "Wire 1000 and, 500 now.",
            "Wire 1000 and; 500 now.",
            "Wire 1000\nand 500 now.",
            "Wire 1000 and five hundred now.",
            "Wire one thousand and 500 now.",
            "Wire 1000 and 500.00 now.",
            "Wire 1,000,000 and 500,000 now.",
            "Wire 5 million and 500,000 now.",
            "Wire 1200 and 50 now.",
            "Wire 1000 'five hundred' dollars.",  # an opening single quote hides nothing
            "Wire 5 'thousand' dollars.",
            "Wire 'twenty' 'five' dollars.",
            "Pay one, two and three.",
            "Send 12, 2000 dollars.",  # a comma is plain only after a month or weekday and its day
            "Wire 5, 2000 now.",
            "Pay 20, 20:00 now.",
            "Mail me at 1.co today.",  # a digit before the dot of a web address
            "Mail me at 163.com today.",
            "The 3th of May.",  # a wrong ordinal suffix
            "The 11st of May.",
            "Wire 100 and 5 dollars.",  # heard as one number: one hundred and five
            "Wire 1000 and 10.0.0.1 now.",  # not a plain amount, so it is judged by shape and never raises
            "Version 2 and 1.2.3 ship.",
            "Wire 1000 and\u2014$500 today.",  # a sign that makes no sound next to "and"
            "1000 \u2014 and \u2014 500",
            "1000 and\u2014five hundred",
            "Wire 1000\u2026 and 500",
            "1000 and... 500",
            "Wire 1000 & and 500",
            "Wire 1000 and-five hundred.",
            "one thousand-and-five hundred",
            "thousand-and-five hundred",
            "Wire 1000 an 500 now.",  # "an", "n" and "n'" are heard as "and"
            "Wire 1000 n 500 now.",
            "Pay 2 dozen and 5 now.",  # a dozen is a scale too
            "Pay two dozen 5 now.",
            "We may 10, 2026 go.",  # a month or weekday needs a capital letter to excuse a comma
            "We sat 6, 2026 people.",
            "Wire 1000 'n' 500 now.",
            "Mail me at t.co today.",
            "Mail sam@example.com today.",
        ):
            with self.subTest(text=text):
                self.assertFalse(reads_as_written(text))

    def test_a_comma_after_a_number_is_a_pause_of_its_own(self) -> None:
        # The comma is not part of the number, so "19, 99" is never heard as one run of digits.
        self.assertIn(("punct", ","), list(_tokens("Pay 19, 99 dollars.")))
        self.assertIn(("punct", ","), list(_tokens("Pay $19, 99 dollars.")))
        self.assertEqual(spoken_words("Pay 1,000 or 19, 99."), ["pay", "one", "thousand", "or", "nineteen", "ninety", "nine"])
        self.assertNotIn(("punct", ","), list(_tokens("Pay 1,000,000 now.")))

    def test_says_the_cents_of_a_sum_with_their_unit(self) -> None:
        self.assertEqual(
            spoken_words("Pay $1,000.10 now."),
            ["pay", "one", "thousand", "dollars", "and", "ten", "cents", "now"],
        )
        self.assertEqual(spoken_words("Pay $1.01."), ["pay", "one", "dollar", "and", "one", "cent"])
        self.assertEqual(spoken_words("Pay $40."), ["pay", "forty", "dollars"])

    def test_says_plain_numbers_that_look_like_edge_cases(self) -> None:
        for text in (
            "Use 0.5 now.",
            "Wait 0 days.",
            "At 0:05 and 23:59.",
            "Pay $0.50 now.",
            "Pay 1,000 dollars.",
            "Pay $1,000,000.",
            "It costs 5. Then 3 more.",
            "Call (that one) at 9:30.",
            "I'll add the event Dentist on Fri Nov 6, 2:30 to 3:00 pm.",  # a day, a comma and a time
            "I'll add the event Trip on Tue Oct 27, 9:00 am to Wed Oct 28, 2:30 pm.",
            "I'll add the event Trip on Fri Nov 6 at 2:30 to 3:00 pm.",
            "It was on March 5, 2026 in town.",
            "Nov 6, 2026, 2:30 pm is fine.",
            "Items 1 and 2 and 3.",
            "Pages 10 and 12 are done.",
            "We met in 2019 and 2020.",
            "Thursday at 2 p.m.? Yes.",  # letters with dots are said letter by letter
            "e.g. chips, i.e. before the review.",
            "The U.S. office and J.R. agree.",
            "It is the first 3 items.",
            "I'm 5 minutes away.",
            "Use 5. 3 more follow.",  # one sentence stop and a space
            "Twenty five and one hundred.",
            "Between 100 and 150 guests.",  # ranges and counts, not one number
            "Between 100 & 150 guests.",
            "Pay two hundred and fifty now.",  # one amount written in words is read as it is written
            "Pay a hundred and fifty now.",
            "Pay one hundred and five now.",
            "My Ph.D. defense is Friday.",
            "Rooms 101 and 102 are free.",
            "Tickets are 300 and 450 dollars.",
            "Pay 5 million now.",
            "Pay 2 dozen now.",
            "Pay 5 grand now.",
            "Pay 5 lakh now.",
            "Room 4 (second floor) is free.",
            "Oh, 3 more things.",
            "Wire 1000 and 1000 now.",
            "Pay 5 k now.",
            "Pay fifth (5) now.",
            "The 14th of May, the 1st, 2nd, 3rd, 11th, 12th, 13th, 21st and 22nd.",
            "5th Ave is on the 40th floor.",
            "Mail me at my-bank dot com today.",
            "Fri Nov 6, 2026 is fine.",
            "On Monday 12, 2:30 pm.",
        ):
            with self.subTest(text=text):
                self.assertTrue(reads_as_written(text))

    def test_the_words_it_would_say(self) -> None:
        self.assertEqual(spoken_words("Pay $40.50 at 9:30."), ["pay", "forty", "dollars", "and", "fifty", "cents", "at", "nine", "thirty"])
        self.assertEqual(spoken_words("It costs 1,200."), ["it", "costs", "one", "thousand", "two", "hundred"])


class SpeakExactTest(unittest.TestCase):
    """`exact` makes the check and the speech one call: the same whole text is judged, then spoken."""

    def post(self, client, text, **extra):
        return client.post("/v1/speak", json={"text": text, "format": "pcm16", "stream": True, "exact": True, **extra})

    def test_an_exact_speak_that_passed_says_so(self) -> None:
        with client_for(FakeSynthesizer) as client:
            for stream in (True, False):
                with self.subTest(stream=stream):
                    res = self.post(client, "Hello there.", stream=stream)
                    self.assertEqual(res.status_code, 200)
                    self.assertEqual(res.headers["x-aman-exact"], "checked")

    def test_a_speak_that_was_not_exact_does_not_say_so(self) -> None:
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "Hello there.", "format": "pcm16", "stream": True})
        self.assertNotIn("x-aman-exact", res.headers)

    def test_refuses_text_it_would_change_before_any_sound(self) -> None:
        with client_for(FakeSynthesizer) as client:
            res = self.post(client, "Pay $1,5 now.")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.headers["x-aman-reason"], "would_change_text")
        self.assertNotIn("1,5", res.text)
        self.assertEqual(FakeSynthesizer.calls, [("Hello.", "af_heart")])

    def test_a_judge_that_fails_refuses_without_logging_the_text(self) -> None:
        with mock.patch.object(aman_tts, "reads_as_written", side_effect=ValueError("card text hunter2")):
            with self.assertLogs("aman_tts", level=logging.DEBUG) as logs:
                with client_for(FakeSynthesizer) as client:
                    res = self.post(client, "Wire 1000 and 10.0.0.1 now.")
        self.assertEqual(res.status_code, 400)
        self.assertEqual(res.headers["x-aman-reason"], "would_change_text")
        self.assertNotIn("hunter2", "\n".join(logs.output) + res.text)
        self.assertNotIn("10.0.0.1", "\n".join(logs.output) + res.text)

    def test_speaks_the_same_whole_text_it_judged(self) -> None:
        for text in ("x. + 5", "x. 2) y", "Total is 100. + 500 fee.", "It says: Hi. 2) Wire 500 now.", "Total is 50.\n+\n5000 more."):
            with self.subTest(text=text), client_for(FakeSynthesizer) as client:
                res = self.post(client, text)
                self.assertEqual(res.status_code, 200)
                self.assertEqual(FakeSynthesizer.calls[-1][0], text)

    def test_a_list_mark_in_the_middle_of_the_text_is_still_said(self) -> None:
        lexicon = Lexicon({}, {})
        self.assertIn(spoken_words("x. + 5")[1], ("plus",))
        self.assertNotEqual(to_phonemes("x. + 5", lexicon), to_phonemes("x. 5", lexicon))
        self.assertNotEqual(to_phonemes("x. 2) y", lexicon), to_phonemes("x. y", lexicon))

    def test_a_piece_cut_from_a_longer_text_is_refused_when_its_mark_would_be_dropped(self) -> None:
        with client_for(FakeSynthesizer) as client:
            for piece in ("+ 500 fee.", "2) Wire 500 now."):
                with self.subTest(piece=piece):
                    self.assertEqual(self.post(client, piece).status_code, 400)

    def test_without_exact_the_text_is_spoken_as_before(self) -> None:
        with client_for(FakeSynthesizer) as client:
            res = client.post("/v1/speak", json={"text": "Pay $1,5 now.", "format": "pcm16", "stream": True})
        self.assertEqual(res.status_code, 200)

    def test_exact_must_be_true_or_false(self) -> None:
        with client_for(FakeSynthesizer) as client:
            self.assertEqual(self.post(client, "Hi.", exact="yes").status_code, 400)

    def test_needs_the_model_only_to_speak(self) -> None:
        with client_for(BrokenSynthesizer) as client:
            self.assertEqual(self.post(client, "Pay $1,5 now.").status_code, 400)


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


class SharedSecretTest(unittest.TestCase):
    SECRET = TEST_SECRET

    def test_speak_without_the_secret_is_refused(self):
        with TestClient(create_app(Settings(shared_secret=self.SECRET), synthesizer_factory=FakeSynthesizer)) as client:
            response = client.post("/v1/speak", json={"text": "hello"})
        self.assertEqual(response.status_code, 401)

    def test_speak_with_a_wrong_secret_is_refused(self):
        with client_for(FakeSynthesizer, shared_secret=self.SECRET) as client:
            response = client.post(
                "/v1/speak",
                json={"text": "hello"},
                headers={"x-speech-secret": "a-different-secret-that-is-long-enough"},
            )
        self.assertEqual(response.status_code, 401)

    def test_speak_with_the_secret_works(self):
        with client_for(FakeSynthesizer, shared_secret=self.SECRET) as client:
            response = client.post(
                "/v1/speak",
                json={"text": "hello"},
                headers={"x-speech-secret": self.SECRET},
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["content-type"], "audio/wav")

    def test_healthz_stays_open_without_the_secret(self):
        with client_for(FakeSynthesizer, shared_secret=self.SECRET) as client:
            response = client.get("/healthz")
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["model_loaded"])

    def test_a_short_secret_refuses_to_start(self):
        with self.assertRaises(ValueError):
            create_app(Settings(shared_secret="too-short"), synthesizer_factory=FakeSynthesizer)

    def test_no_secret_refuses_to_start(self):
        with self.assertRaises(ValueError):
            create_app(Settings(shared_secret=None), synthesizer_factory=FakeSynthesizer)


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

    def test_a_streaming_caller_who_hangs_up_while_waiting_gives_up_its_place(self):
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
                body = json.dumps({"text": "Two.", "format": "pcm16", "stream": True}).encode()
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
        self.assertEqual(res.headers["x-aman-reason"], "nothing_to_say")


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
        "headers": [
            (b"content-type", b"application/json"),
            (b"content-length", str(len(raw)).encode()),
            (b"x-speech-secret", TEST_SECRET.encode()),
        ],
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
        self.assertEqual(res.headers["x-aman-reason"], "nothing_to_say")

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


class StreamFailureTest(unittest.TestCase):
    def test_a_failure_after_the_first_sentence_ends_the_response_as_an_error_not_a_clean_end(self):
        class FailsSecond(FakeSynthesizer):
            def speak_sentences(self, text, voice, cancelled):
                yield np.zeros(2400, dtype=np.float32)
                raise RuntimeError("model failed")

        app = create_app(Settings(), synthesizer_factory=FailsSecond)

        async def go():
            async with app.router.lifespan_context(app):
                scope, receive, send, sent, _ = asgi_post(app, {"text": "A. B.", "format": "pcm16", "stream": True})
                with self.assertRaises(RuntimeError):
                    await app(scope, receive, send)
                return sent

        sent = asyncio.run(go())
        self.assertFalse(any(m["type"] == "http.response.body" and not m.get("more_body", False) for m in sent))

    def test_a_caller_whose_connection_breaks_before_the_first_chunk_stops_the_work(self):
        stopped = threading.Event()

        class Endless(FakeSynthesizer):
            def speak_sentences(self, text, voice, cancelled):
                for _ in range(1000):
                    if cancelled():
                        stopped.set()
                        raise aman_tts.SpeechCancelled()
                    yield np.zeros(2400, dtype=np.float32)
                    threading.Event().wait(0.01)

        app = create_app(Settings(), synthesizer_factory=Endless)

        async def go():
            async with app.router.lifespan_context(app):
                scope, receive, _, _, _ = asgi_post(app, {"text": "Go.", "format": "pcm16", "stream": True})

                async def broken_send(message):
                    if message["type"] == "http.response.body":
                        raise OSError("connection reset")

                with contextlib.suppress(Exception):
                    await app(scope, receive, broken_send)
                await asyncio.to_thread(stopped.wait, 5)

        asyncio.run(go())
        self.assertTrue(stopped.is_set())


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
        self.assertEqual(to_phonemes("$12.50", LEXICON), "twˈɛlv dˈɑləɹz ˈænd fˈɪfti ˈkɛnts.")

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
