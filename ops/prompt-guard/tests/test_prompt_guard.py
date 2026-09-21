import os
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch


sys.path.insert(0, os.path.dirname(os.path.dirname(__file__)))

from prompt_guard import (  # noqa: E402
    BadRequest,
    BatchScoringScorer,
    Classification,
    ContentCache,
    LengthRequired,
    ModelError,
    PayloadTooLarge,
    Runtime,
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
    """A ScorerLike that scores one window per call, in order."""

    def __init__(self, scores):
        self.scores = list(scores)
        self.windows = []

    def score_windows(self, windows):
        results = []
        for window in windows:
            self.windows.append(list(window))
            results.append(self.scores[len(self.windows) - 1])
        return results


class FakeBatchedScorer:
    """A ScorerLike returning a fixed, ordered score list regardless of batch size."""

    def __init__(self, batch_size, scores):
        self.batch_size = batch_size
        self._scores = list(scores)

    def score_windows(self, windows):
        assert len(windows) == len(self._scores)
        return list(self._scores)


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
        self.assertEqual([len(window) for window in scorer.windows], [512, 512, 490])

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
        self.assertEqual(settings.backend, "onnx")
        self.assertEqual(settings.batch_size, 1)
        self.assertEqual(settings.cache_size, 4096)
        self.assertEqual(settings.max_inflight, 4)

    def test_model_directory_is_required(self):
        with patch.dict(
            os.environ,
            {"PROMPT_GUARD_BEARER_TOKEN": "test-token"},
            clear=True,
        ):
            with self.assertRaises(RuntimeError):
                Settings.from_env()

    def test_model_hash_helper_is_deterministic(self):
        with tempfile.TemporaryDirectory() as model_dir:
            model_file = Path(model_dir) / "artifact.bin"
            model_file.write_bytes(b"test model artifact")
            self.assertEqual(
                sha256_file(model_file),
                "20c8a88612967a74a618fc3970a86fe1e665ef8786ecf990191865961d76e2ef",
            )

    def test_model_hash_mismatch_is_rejected(self):
        with tempfile.TemporaryDirectory() as model_dir:
            model_file = Path(model_dir) / "model.quant.onnx"
            model_file.write_bytes(b"not the pinned artifact")
            with self.assertRaisesRegex(RuntimeError, "SHA-256 mismatch"):
                verify_model_file(model_file)


class BackendSelectionTests(unittest.TestCase):
    def test_default_backend_is_onnx(self):
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
        self.assertEqual(settings.backend, "onnx")

    def test_torch_backend_defaults_batch_size_16(self):
        with tempfile.TemporaryDirectory() as model_dir:
            with patch.dict(
                os.environ,
                {
                    "PROMPT_GUARD_BEARER_TOKEN": "test-token",
                    "PROMPT_GUARD_MODEL_PATH": model_dir,
                    "PROMPT_GUARD_BACKEND": "torch",
                },
                clear=True,
            ):
                settings = Settings.from_env()
        self.assertEqual(settings.backend, "torch")
        self.assertEqual(settings.batch_size, 16)

    def test_invalid_backend_is_rejected(self):
        with tempfile.TemporaryDirectory() as model_dir:
            with patch.dict(
                os.environ,
                {
                    "PROMPT_GUARD_BEARER_TOKEN": "test-token",
                    "PROMPT_GUARD_MODEL_PATH": model_dir,
                    "PROMPT_GUARD_BACKEND": "gemini",
                },
                clear=True,
            ):
                with self.assertRaises(RuntimeError):
                    Settings.from_env()

    def test_explicit_batch_size_overrides_default(self):
        with tempfile.TemporaryDirectory() as model_dir:
            with patch.dict(
                os.environ,
                {
                    "PROMPT_GUARD_BEARER_TOKEN": "test-token",
                    "PROMPT_GUARD_MODEL_PATH": model_dir,
                    "PROMPT_GUARD_BATCH_SIZE": "32",
                },
                clear=True,
            ):
                settings = Settings.from_env()
        self.assertEqual(settings.batch_size, 32)


class ContentCacheTests(unittest.TestCase):
    def test_hit_after_miss_returns_same_value_without_recompute(self):
        cache = ContentCache(size=4)
        key = ContentCache.key_for("model-a", "hello world")

        self.assertIsNone(cache.get(key))
        cache.put(key, Classification(label="benign", score=0.1, flagged=False))
        cached = cache.get(key)

        self.assertIsNotNone(cached)
        self.assertEqual(cached.score, 0.1)
        self.assertEqual(cache.stats()["hits"], 1)
        self.assertEqual(cache.stats()["misses"], 1)

    def test_evicts_least_recently_used_beyond_size(self):
        cache = ContentCache(size=2)
        keys = [ContentCache.key_for("model-a", text) for text in ("a", "b", "c")]
        for index, key in enumerate(keys):
            cache.put(key, Classification(label="benign", score=0.1 * index, flagged=False))

        self.assertIsNone(cache.get(keys[0]))
        self.assertIsNotNone(cache.get(keys[1]))
        self.assertIsNotNone(cache.get(keys[2]))

    def test_different_model_id_is_a_different_key(self):
        key_a = ContentCache.key_for("model-a", "same text")
        key_b = ContentCache.key_for("model-b", "same text")
        self.assertNotEqual(key_a, key_b)

    def test_size_zero_disables_caching(self):
        cache = ContentCache(size=0)
        key = ContentCache.key_for("model-a", "text")
        cache.put(key, Classification(label="benign", score=0.1, flagged=False))
        self.assertIsNone(cache.get(key))

    def test_runtime_classify_does_not_rescore_a_cache_hit(self):
        tokenizer = FakeTokenizer()
        scorer = FakeScorer([0.9])
        runtime = Runtime(
            bearer_token="token",
            tokenizer=tokenizer,
            scorer=scorer,
            window_stride=256,
            max_body_bytes=1024,
            cache=ContentCache(size=8),
            model_id="test-model",
            max_inflight=4,
        )

        first = runtime.classify("some recalled memory text", 0.5)
        second = runtime.classify("some recalled memory text", 0.5)

        self.assertEqual(first.score, second.score)
        self.assertEqual(len(scorer.windows), 1)  # scored once, not twice
        self.assertEqual(runtime.cache.stats()["hits"], 1)
        self.assertEqual(runtime.cache.stats()["misses"], 1)


class SemaphoreTests(unittest.TestCase):
    def test_bounds_concurrent_scorer_calls(self):
        max_inflight = 2
        current = 0
        peak = 0
        lock = threading.Lock()

        class SlowScorer:
            def score_windows(self, windows):
                nonlocal current, peak
                with lock:
                    current += 1
                    peak = max(peak, current)
                time.sleep(0.05)
                with lock:
                    current -= 1
                return [0.1 for _ in windows]

        runtime = Runtime(
            bearer_token="token",
            tokenizer=FakeTokenizer(),
            scorer=SlowScorer(),
            window_stride=256,
            max_body_bytes=1024,
            cache=ContentCache(size=0),
            model_id="test-model",
            max_inflight=max_inflight,
        )

        threads = [
            threading.Thread(target=runtime.classify, args=(f"text {i}", 0.5))
            for i in range(6)
        ]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)

        self.assertLessEqual(peak, max_inflight)


class BatchingEquivalenceTests(unittest.TestCase):
    """Batched window scoring must aggregate identically to sequential scoring."""

    class StubBatchScorer(BatchScoringScorer):
        def __init__(self, batch_size, window_scores):
            super().__init__(batch_size, pad_token_id=0)
            # window_scores maps a window's first token id to its score.
            self._window_scores = window_scores
            self.batch_calls = []

        def _score_batch(self, padded_windows, attention_masks):
            self.batch_calls.append(len(padded_windows))
            return [self._window_scores[window[0]] for window in padded_windows]

    def test_batch_size_does_not_change_per_window_scores(self):
        # Distinguishable synthetic windows (unique leading token id per window) so
        # batching/padding cannot be mistaken for changing which score goes where.
        windows = [[10, 1, 2], [20, 3], [30, 4, 5, 6]]
        window_scores = {10: 0.1, 20: 0.9, 30: 0.4}

        results_by_batch_size = {}
        for batch_size in (1, 2, 3, 16):
            scorer = self.StubBatchScorer(batch_size, window_scores)
            scores = scorer.score_windows(windows)
            results_by_batch_size[batch_size] = scores
            # Sequential (batch=1) issues one batch call per window; larger batch
            # sizes must still visit every window exactly once, just grouped.
            self.assertEqual(sum(scorer.batch_calls), len(windows))

        expected = [0.1, 0.9, 0.4]
        for batch_size, scores in results_by_batch_size.items():
            self.assertEqual(scores, expected, msg=f"batch_size={batch_size}")

    def test_batch_size_does_not_change_classify_text_aggregate(self):
        tokenizer = FakeTokenizer()
        text = "x" * 1_000  # produces 3 windows, as in the sliding-window test above
        input_ids = tokenizer.encode(text, add_special_tokens=False, truncation=False)
        window_count = len(sliding_windows(input_ids, stride=256))

        results = {}
        for batch_size in (1, 2, window_count, 16):
            scores = [0.1, 0.9, 0.4][:window_count]
            scorer = FakeBatchedScorer(batch_size, scores)
            result = classify_text(
                text, 0.5, tokenizer=tokenizer, scorer=scorer, window_stride=256
            )
            results[batch_size] = result.score

        self.assertEqual(len(set(results.values())), 1)
        self.assertEqual(results[1], 0.9)

    def test_pad_batch_masks_shorter_windows(self):
        scorer = self.StubBatchScorer(batch_size=4, window_scores={})
        padded, masks = scorer._pad_batch([[1, 2, 3], [1, 2]])
        self.assertEqual(padded, [[1, 2, 3], [1, 2, 0]])
        self.assertEqual(masks, [[1, 1, 1], [1, 1, 0]])


if __name__ == "__main__":
    unittest.main()
