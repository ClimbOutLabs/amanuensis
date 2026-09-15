import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from prompt_guard import (  # noqa: E402
    BadRequest,
    LengthRequired,
    ModelError,
    PayloadTooLarge,
    Settings,
    Unauthorized,
    classify_text,
    sha256_file,
    sliding_windows,
    verify_model_file,
)


class FakeTokenizer:
    def encode(self, text, *, add_special_tokens, truncation, max_length=None):
        self.last_call = (text, add_special_tokens, truncation, max_length)
        token_ids = list(range(len(text)))
        if add_special_tokens:
            token_ids = [-1, *token_ids, -2]
        if truncation and max_length is not None:
            token_ids = token_ids[:max_length]
        return token_ids

    def decode(self, token_ids, *, skip_special_tokens):
        return "x" * len(token_ids)


class FakeScorer:
    def __init__(self, scores):
        self.scores = list(scores)
        self.windows = []

    def score_window(self, input_ids, attention_mask):
        self.windows.append((list(input_ids), list(attention_mask)))
        return self.scores[len(self.windows) - 1]


class SlidingWindowTests(unittest.TestCase):
    def test_full_input_is_scanned_and_max_score_wins(self):
        tokenizer = FakeTokenizer()
        scorer = FakeScorer([0.1, 0.8, 0.2])

        result = classify_text(
            "x" * 1_000,
            0.75,
            tokenizer=tokenizer,
            scorer=scorer,
            window_stride=256,
        )

        self.assertEqual(result.as_dict(), {"label": "malicious", "score": 0.8, "flagged": True})
        self.assertEqual(len(scorer.windows), 3)
        self.assertEqual([len(window[0]) for window in scorer.windows], [512, 512, 490])
        self.assertTrue(all(mask == [1] * len(ids) for ids, mask in scorer.windows))

    def test_threshold_only_controls_flagged(self):
        result = classify_text(
            "safe",
            0.9,
            tokenizer=FakeTokenizer(),
            scorer=FakeScorer([0.8]),
            window_stride=256,
        )

        self.assertEqual(result.label, "malicious")
        self.assertFalse(result.flagged)

    def test_windows_are_bounded_and_overlap(self):
        windows = sliding_windows(list(range(700)), stride=256)

        self.assertEqual([len(window) for window in windows], [512, 444])
        self.assertEqual(windows[0][-256:], windows[1][:256])


class ValidationTests(unittest.TestCase):
    def test_http_error_classes_have_explicit_statuses(self):
        self.assertEqual(BadRequest.status_code, 400)
        self.assertEqual(PayloadTooLarge.status_code, 413)
        self.assertEqual(LengthRequired.status_code, 411)
        self.assertEqual(Unauthorized.status_code, 401)
        self.assertEqual(ModelError.status_code, 500)

    def test_invalid_threshold_is_a_bad_request(self):
        with self.assertRaises(BadRequest):
            classify_text(
                "text",
                1.1,
                tokenizer=FakeTokenizer(),
                scorer=FakeScorer([0.1]),
                window_stride=256,
            )

    def test_invalid_model_score_is_a_model_error(self):
        with self.assertRaises(ModelError):
            classify_text(
                "text",
                0.5,
                tokenizer=FakeTokenizer(),
                scorer=FakeScorer([1.1]),
                window_stride=256,
            )

    def test_settings_are_env_only(self):
        with tempfile.TemporaryDirectory() as model_dir:
            with patch.dict(
                os.environ,
                {
                    "PROMPT_GUARD_BEARER_TOKEN": "test-token",
                    "PROMPT_GUARD_MODEL_PATH": model_dir,
                },
                clear=True,
            ):
                settings = Settings.from_env()

        self.assertEqual(settings.bearer_token, "test-token")
        self.assertEqual(settings.model_path, model_dir)
        self.assertEqual(settings.window_stride, 256)

    def test_model_directory_is_required(self):
        with patch.dict(
            os.environ,
            {"PROMPT_GUARD_BEARER_TOKEN": "test-token"},
            clear=True,
        ):
            with self.assertRaises(RuntimeError):
                Settings.from_env()

    def test_model_hash_helper_is_deterministic(self):
        with tempfile.NamedTemporaryFile() as model_file:
            model_file.write(b"test model artifact")
            model_file.flush()
            self.assertEqual(
                sha256_file(Path(model_file.name)),
                "20c8a88612967a74a618fc3970a86fe1e665ef8786ecf990191865961d76e2ef",
            )

    def test_model_hash_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as model_dir:
            model_file = Path(model_dir) / "model.quant.onnx"
            model_file.write_bytes(b"not the pinned artifact")
            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                verify_model_file(model_file)


if __name__ == "__main__":
    unittest.main()
