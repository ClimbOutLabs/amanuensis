"""Evaluation-only HTTP sidecar for Llama Prompt Guard 2."""

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import math
import os
import threading
from collections import OrderedDict
from dataclasses import dataclass
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Callable, Protocol, Sequence


LOGGER = logging.getLogger("prompt_guard")

# ONNX backend (default): a third-party quantized mirror. Evaluated but not
# adopted as a production security control; see ADR.md.
ONNX_MODEL_ID = "gravitee-io/Llama-Prompt-Guard-2-86M-onnx"
ONNX_MODEL_REVISION = "45a05fbd5337a864edc608f994911f009c37ca57"
ONNX_MODEL_FILE = "model.quant.onnx"
ONNX_MODEL_FILES_SHA256 = {
    "config.json": "a39ae60b9b718b72bbe3f359ad07ddf6909dcb09ccff936c00a488ceb4e983a6",
    "tokenizer.json": "870798f0e3bb05c636bf62be904b2d8f48ace4785e9c1d71a8a67bd0586c941d",
    "tokenizer_config.json": "d5cff0d149f1084504aa8cbdd941289a011ec7f027519feb49e397c58b564398",
    "special_tokens_map.json": "b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21",
    ONNX_MODEL_FILE: "3ca25030566076c92c19168a64d6e203e4397cd936f55dd0345b4d3c6fbd9744",
}

# torch backend: Meta's official fp32 weights, downloaded once by the operator
# from https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M outside
# huggingface-cli (a manual, gated download has no recorded HF revision hash),
# so these content hashes are the provenance guarantee for this backend.
TORCH_MODEL_ID = "meta-llama/Llama-Prompt-Guard-2-86M"
TORCH_MODEL_REVISION = "operator-downloaded (no huggingface-cli revision recorded)"
TORCH_MODEL_FILE = "model.safetensors"
TORCH_MODEL_FILES_SHA256 = {
    "config.json": "cd54ac39a1f2c3c5146bd5295b34038f8b4d9069e2f844450da014a523bb7653",
    "tokenizer.json": "3e7e96867c2acdd575f0862c74822e05d1d15b93d9d9a4a2144b1ce83ae3339f",
    "tokenizer_config.json": "fa09cf22b9d723377f95706967f789ca1a8267e1412385705e1ed51ce0559189",
    "special_tokens_map.json": "9463f61e1b109a8eb4688b829260d7c6b1e6dff04c98ff7269bb89e2b92369b9",
    TORCH_MODEL_FILE: "e72017dbbe89c1232dcbc4a74ce0c389db5b468c42afd05850347b2a8c5f6b09",
}

WINDOW_SIZE = 512
DEFAULT_WINDOW_STRIDE = 256
DEFAULT_MAX_BODY_BYTES = 1_048_576
# Matches the host screens' MEMORY_SCREEN_MAX_CONCURRENCY default of 8.
TOKENIZER_POOL_SIZE = 8


class TokenizerLike(Protocol):
    def encode(
        self,
        text: str,
        *,
        add_special_tokens: bool,
        truncation: bool,
        max_length: int | None = None,
    ) -> list[int]: ...

    def decode(self, token_ids: Sequence[int], *, skip_special_tokens: bool) -> str: ...


class ScorerLike(Protocol):
    def score_windows(self, windows: Sequence[Sequence[int]]) -> list[float]: ...


class ServiceError(Exception):
    """An error that is safe to expose as a stable HTTP error class."""

    status_code: int = HTTPStatus.INTERNAL_SERVER_ERROR
    error_class = "internal_error"
    public_detail = "The service could not complete the request."

    def __init__(self, detail: str | None = None) -> None:
        super().__init__(detail or self.public_detail)
        self.detail = detail or self.public_detail


class BadRequest(ServiceError):
    status_code = HTTPStatus.BAD_REQUEST
    error_class = "bad_request"
    public_detail = "The request body must contain text and a threshold between 0 and 1."


class PayloadTooLarge(ServiceError):
    status_code = HTTPStatus.REQUEST_ENTITY_TOO_LARGE
    error_class = "payload_too_large"
    public_detail = "The request body is too large."


class LengthRequired(ServiceError):
    status_code = HTTPStatus.LENGTH_REQUIRED
    error_class = "length_required"
    public_detail = "Content-Length is required."


class Unauthorized(ServiceError):
    status_code = HTTPStatus.UNAUTHORIZED
    error_class = "unauthorized"
    public_detail = "A valid bearer token is required."


class ModelError(ServiceError):
    status_code = HTTPStatus.INTERNAL_SERVER_ERROR
    error_class = "model_error"
    public_detail = "The prompt guard model is unavailable or failed to score the input."


@dataclass(frozen=True)
class Settings:
    bearer_token: str
    host: str
    port: int
    model_path: str
    window_stride: int
    max_body_bytes: int
    onnx_threads: int
    backend: str
    batch_size: int
    cache_size: int
    max_inflight: int
    torch_dtype: str
    torch_device: str

    @classmethod
    def from_env(cls) -> "Settings":
        token = os.environ.get("PROMPT_GUARD_BEARER_TOKEN", "")
        if not token:
            raise RuntimeError("PROMPT_GUARD_BEARER_TOKEN must be set")
        model_path = os.environ.get("PROMPT_GUARD_MODEL_PATH", "")
        if not model_path:
            raise RuntimeError("PROMPT_GUARD_MODEL_PATH must point to a mounted model directory")

        backend = os.environ.get("PROMPT_GUARD_BACKEND", "onnx").strip().lower()
        if backend not in ("onnx", "torch"):
            raise RuntimeError("PROMPT_GUARD_BACKEND must be 'onnx' or 'torch'")

        port = _positive_int_env("PROMPT_GUARD_PORT", 8080)
        max_body_bytes = _positive_int_env(
            "PROMPT_GUARD_MAX_BODY_BYTES", DEFAULT_MAX_BODY_BYTES
        )
        onnx_threads = _positive_int_env("PROMPT_GUARD_ONNX_THREADS", 1)
        window_stride = _nonnegative_int_env(
            "PROMPT_GUARD_WINDOW_STRIDE", DEFAULT_WINDOW_STRIDE
        )
        if window_stride >= WINDOW_SIZE:
            raise RuntimeError("PROMPT_GUARD_WINDOW_STRIDE must be less than 512")

        default_batch_size = 16 if backend == "torch" else 1
        batch_size = _positive_int_env("PROMPT_GUARD_BATCH_SIZE", default_batch_size)
        cache_size = _nonnegative_int_env("PROMPT_GUARD_CACHE_SIZE", 4096)
        max_inflight = _positive_int_env("PROMPT_GUARD_MAX_INFLIGHT", 4)
        torch_dtype = os.environ.get("PROMPT_GUARD_TORCH_DTYPE", "bf16").strip().lower()
        if torch_dtype not in ("bf16", "fp16", "fp32"):
            raise RuntimeError("PROMPT_GUARD_TORCH_DTYPE must be 'bf16', 'fp16', or 'fp32'")
        torch_device = os.environ.get("PROMPT_GUARD_TORCH_DEVICE", "auto").strip().lower()

        return cls(
            bearer_token=token,
            host=os.environ.get("PROMPT_GUARD_HOST", "127.0.0.1"),
            port=port,
            model_path=model_path,
            window_stride=window_stride,
            max_body_bytes=max_body_bytes,
            onnx_threads=onnx_threads,
            backend=backend,
            batch_size=batch_size,
            cache_size=cache_size,
            max_inflight=max_inflight,
            torch_dtype=torch_dtype,
            torch_device=torch_device,
        )


@dataclass(frozen=True)
class Classification:
    label: str
    score: float
    flagged: bool

    def as_dict(self) -> dict[str, Any]:
        return {"label": self.label, "score": self.score, "flagged": self.flagged}


def _positive_int_env(name: str, default: int) -> int:
    value = os.environ.get(name, str(default))
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if parsed <= 0:
        raise RuntimeError(f"{name} must be positive")
    return parsed


def _nonnegative_int_env(name: str, default: int) -> int:
    value = os.environ.get(name, str(default))
    try:
        parsed = int(value)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if parsed < 0:
        raise RuntimeError(f"{name} must not be negative")
    return parsed


def sliding_windows(
    input_ids: Sequence[int], *, window_size: int = WINDOW_SIZE, stride: int
) -> list[list[int]]:
    """Split complete tokenized input into overlapping, bounded model inputs."""

    if not input_ids:
        return []
    if window_size != WINDOW_SIZE:
        raise ValueError("Prompt Guard windows must be exactly 512 tokens")
    if stride < 0 or stride >= window_size:
        raise ValueError("stride must be nonnegative and less than the window size")

    step = window_size - stride
    windows: list[list[int]] = []
    for start in range(0, len(input_ids), step):
        window = list(input_ids[start : start + window_size])
        if not window:
            break
        windows.append(window)
        if start + window_size >= len(input_ids):
            break
    return windows


def classify_text(
    text: str,
    threshold: float,
    *,
    tokenizer: TokenizerLike,
    scorer: ScorerLike,
    window_stride: int,
    inflight_semaphore: "threading.Semaphore | None" = None,
) -> Classification:
    if not isinstance(text, str) or not text.strip():
        raise BadRequest("text must be a non-empty string")
    if isinstance(threshold, bool) or not isinstance(threshold, (int, float)):
        raise BadRequest("threshold must be a number between 0 and 1")
    if not math.isfinite(float(threshold)) or not 0 <= float(threshold) <= 1:
        raise BadRequest("threshold must be a number between 0 and 1")

    try:
        input_ids = tokenizer.encode(
            text, add_special_tokens=False, truncation=False
        )
        token_windows = sliding_windows(input_ids, stride=window_stride)
        windows = []
        for token_window in token_windows:
            chunk_text = tokenizer.decode(
                token_window, skip_special_tokens=True
            )
            model_window = tokenizer.encode(
                chunk_text,
                add_special_tokens=True,
                truncation=True,
                max_length=WINDOW_SIZE,
            )
            if not model_window or len(model_window) > WINDOW_SIZE:
                raise ModelError("tokenizer produced an invalid model window")
            windows.append(model_window)
        if not windows:
            raise ModelError("tokenizer produced no input tokens")

        if inflight_semaphore is not None:
            with inflight_semaphore:
                scores = scorer.score_windows(windows)
        else:
            scores = scorer.score_windows(windows)
        if len(scores) != len(windows):
            raise ModelError("scorer returned a different number of scores than windows")
        score = max(float(window_score) for window_score in scores)
    except ServiceError:
        raise
    except Exception as exc:
        LOGGER.exception("classification failed")
        raise ModelError() from exc

    if not math.isfinite(score) or not 0 <= score <= 1:
        raise ModelError("model returned a score outside the range 0..1")

    rounded_score = round(score, 6)
    label = "malicious" if score >= 0.5 else "benign"
    return Classification(
        label=label,
        score=rounded_score,
        flagged=score >= float(threshold),
    )


class ContentCache:
    """A thread-safe LRU cache keyed by sha256(model_id + text).

    Keeps repeated recalled memories or tool outputs from being rescored on
    every turn. `size == 0` disables caching entirely (get always misses).
    """

    def __init__(self, size: int) -> None:
        self._size = size
        self._lock = threading.Lock()
        self._entries: "OrderedDict[str, Classification]" = OrderedDict()
        self.hits = 0
        self.misses = 0

    @staticmethod
    def key_for(model_id: str, text: str) -> str:
        digest = hashlib.sha256()
        digest.update(model_id.encode("utf-8"))
        digest.update(b"\0")
        digest.update(text.encode("utf-8"))
        return digest.hexdigest()

    def get(self, key: str) -> Classification | None:
        if self._size <= 0:
            return None
        with self._lock:
            entry = self._entries.get(key)
            if entry is None:
                self.misses += 1
                return None
            self._entries.move_to_end(key)
            self.hits += 1
            return entry

    def put(self, key: str, value: Classification) -> None:
        if self._size <= 0:
            return
        with self._lock:
            self._entries[key] = value
            self._entries.move_to_end(key)
            while len(self._entries) > self._size:
                self._entries.popitem(last=False)

    def stats(self) -> dict[str, int]:
        with self._lock:
            return {
                "hits": self.hits,
                "misses": self.misses,
                "size": len(self._entries),
                "max_size": self._size,
            }


class Runtime:
    def __init__(
        self,
        *,
        bearer_token: str,
        tokenizer: TokenizerLike | None,
        scorer: ScorerLike | None,
        window_stride: int,
        max_body_bytes: int,
        model_error: Exception | None = None,
        tokenizer_factory: Callable[[], TokenizerLike] | None = None,
        cache: ContentCache | None = None,
        model_id: str = "",
        max_inflight: int = 4,
        backend: str = "onnx",
        device: str = "cpu",
    ) -> None:
        self.bearer_token = bearer_token
        self.tokenizer = tokenizer
        self.scorer = scorer
        self.window_stride = window_stride
        self.max_body_bytes = max_body_bytes
        self.model_error = model_error
        self.backend = backend
        self.device = device
        # The HuggingFace fast tokenizer keeps mutable truncation state and raises
        # "Already borrowed" when two threads use one instance at once. Each server thread
        # gets its own copy, loaded from the same verified files, so requests stay parallel.
        self._tokenizer_factory = tokenizer_factory
        # The HTTP server runs one thread per connection, so a per-thread cache would reload on
        # every request; a pool of loaded tokenizers is borrowed and returned instead.
        self._tokenizer_pool: list[TokenizerLike] = []
        self._pool_lock = threading.Lock()
        self.cache = cache if cache is not None else ContentCache(0)
        self.model_id = model_id
        self._inflight_semaphore = threading.Semaphore(max(1, max_inflight))

    @classmethod
    def from_settings(cls, settings: Settings) -> "Runtime":
        try:
            scorer: ScorerLike
            model_id: str
            if settings.backend == "torch":
                scorer = TorchPromptGuardScorer(settings)
                model_id = TORCH_MODEL_ID
            else:
                scorer = OnnxPromptGuardScorer(settings)
                model_id = ONNX_MODEL_ID
            runtime = cls(
                bearer_token=settings.bearer_token,
                tokenizer=scorer.tokenizer,
                scorer=scorer,
                window_stride=settings.window_stride,
                max_body_bytes=settings.max_body_bytes,
                tokenizer_factory=scorer.new_tokenizer,
                cache=ContentCache(settings.cache_size),
                model_id=model_id,
                max_inflight=settings.max_inflight,
                backend=settings.backend,
                device=getattr(scorer, "device", "cpu"),
            )
            runtime.prewarm_tokenizers(TOKENIZER_POOL_SIZE)
            return runtime
        except Exception as exc:
            LOGGER.exception("Prompt Guard model failed to load")
            return cls(
                bearer_token=settings.bearer_token,
                tokenizer=None,
                scorer=None,
                window_stride=settings.window_stride,
                max_body_bytes=settings.max_body_bytes,
                model_error=exc,
                cache=ContentCache(settings.cache_size),
                max_inflight=settings.max_inflight,
                backend=settings.backend,
            )

    @property
    def ready(self) -> bool:
        return self.tokenizer is not None and self.scorer is not None

    def prewarm_tokenizers(self, count: int) -> None:
        """Load tokenizers ahead of the first burst so no request pays the load cost."""
        if self._tokenizer_factory is None:
            return
        with self._pool_lock:
            while len(self._tokenizer_pool) < count:
                self._tokenizer_pool.append(self._tokenizer_factory())

    def _borrow_tokenizer(self) -> TokenizerLike | None:
        if self._tokenizer_factory is None:
            return self.tokenizer
        with self._pool_lock:
            if self._tokenizer_pool:
                return self._tokenizer_pool.pop()
        return self._tokenizer_factory()

    def _return_tokenizer(self, tokenizer: TokenizerLike) -> None:
        if self._tokenizer_factory is None:
            return
        with self._pool_lock:
            self._tokenizer_pool.append(tokenizer)

    def classify(self, text: str, threshold: float) -> Classification:
        if not self.ready:
            raise ModelError() from self.model_error

        cache_key = None
        if isinstance(text, str):
            cache_key = ContentCache.key_for(self.model_id, text)
            cached = self.cache.get(cache_key)
            if cached is not None:
                label = "malicious" if cached.score >= 0.5 else "benign"
                return Classification(
                    label=label, score=cached.score, flagged=cached.score >= float(threshold)
                )

        tokenizer = self._borrow_tokenizer()
        scorer = self.scorer
        if tokenizer is None or scorer is None:
            raise ModelError() from self.model_error
        try:
            result = classify_text(
                text,
                threshold,
                tokenizer=tokenizer,
                scorer=scorer,
                window_stride=self.window_stride,
                inflight_semaphore=self._inflight_semaphore,
            )
        finally:
            self._return_tokenizer(tokenizer)

        if cache_key is not None:
            self.cache.put(cache_key, result)
        return result


class BatchScoringScorer:
    """Shared batching and padding for window-level scoring.

    Subclasses implement `_score_batch`, which receives windows already
    padded to a common length within the batch plus their attention masks,
    and returns one malicious-probability float per row in the same order.
    """

    def __init__(self, batch_size: int, pad_token_id: int) -> None:
        self.batch_size = max(1, batch_size)
        self.pad_token_id = pad_token_id

    def score_windows(self, windows: Sequence[Sequence[int]]) -> list[float]:
        results: list[float] = []
        windows = list(windows)
        for start in range(0, len(windows), self.batch_size):
            batch = windows[start : start + self.batch_size]
            padded, masks = self._pad_batch(batch)
            results.extend(self._score_batch(padded, masks))
        return results

    def _pad_batch(
        self, batch: Sequence[Sequence[int]]
    ) -> tuple[list[list[int]], list[list[int]]]:
        max_length = max(len(window) for window in batch)
        padded: list[list[int]] = []
        masks: list[list[int]] = []
        for window in batch:
            pad_count = max_length - len(window)
            padded.append(list(window) + [self.pad_token_id] * pad_count)
            masks.append([1] * len(window) + [0] * pad_count)
        return padded, masks

    def _score_batch(
        self, padded_windows: list[list[int]], attention_masks: list[list[int]]
    ) -> list[float]:
        raise NotImplementedError


def _config_labels(config: Any) -> list[str]:
    id2label = getattr(config, "id2label", {}) or {}
    labels: list[str] = []
    for index in sorted(id2label, key=lambda value: int(value)):
        labels.append(str(id2label[index]))
    return labels


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as file_handle:
        for chunk in iter(lambda: file_handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_model_file(path: Path, hashes: dict[str, str] | None = None) -> None:
    hash_map = hashes if hashes is not None else ONNX_MODEL_FILES_SHA256
    expected_sha256 = hash_map.get(path.name)
    if expected_sha256 is None:
        raise RuntimeError(f"unrecognized model file: {path.name}")
    if not path.is_file():
        raise RuntimeError(f"missing required model file: {path.name}")
    if sha256_file(path) != expected_sha256:
        raise RuntimeError(f"SHA-256 mismatch for {path.name}")


def verify_model_directory(model_dir: Path, hashes: dict[str, str] | None = None) -> None:
    hash_map = hashes if hashes is not None else ONNX_MODEL_FILES_SHA256
    for name in sorted(hash_map):
        verify_model_file(model_dir / name, hash_map)


def _malicious_probability(values: Any, labels: Sequence[str]) -> float:
    flat = values.reshape(-1)
    if flat.size < 2:
        raise ModelError("model must return at least two class logits")

    shifted = flat - flat.max()
    probabilities = _softmax(shifted)
    malicious_index = _malicious_label_index(labels, flat.size)
    return float(probabilities[malicious_index])


def _softmax(values: Any) -> Any:
    exponentials = [math.exp(float(value)) for value in values]
    denominator = sum(exponentials)
    return [value / denominator for value in exponentials]


def _malicious_label_index(labels: Sequence[str], output_count: int) -> int:
    normalized = [label.strip().lower() for label in labels[:output_count]]
    malicious = [
        index for index, label in enumerate(normalized) if label == "malicious"
    ]
    benign = [index for index, label in enumerate(normalized) if label == "benign"]
    if len(malicious) == 1 and benign:
        return malicious[0]
    return 1 if output_count > 1 else 0


class OnnxPromptGuardScorer(BatchScoringScorer):
    """Loads the quantized ONNX model and exposes malicious probability per window."""

    def __init__(self, settings: Settings) -> None:
        import numpy as np
        import onnxruntime as ort
        from transformers import AutoConfig, AutoTokenizer

        self._np = np
        model_dir = Path(settings.model_path)
        if not model_dir.is_dir():
            raise RuntimeError(
                f"{ONNX_MODEL_ID} requires PROMPT_GUARD_MODEL_PATH to be a directory"
            )
        model_path = model_dir / ONNX_MODEL_FILE
        verify_model_directory(model_dir, ONNX_MODEL_FILES_SHA256)

        self._model_dir = model_dir
        self.tokenizer = self.new_tokenizer()
        config = AutoConfig.from_pretrained(
            str(model_dir),
            local_files_only=True,
        )
        self._labels = _config_labels(config)
        self.device = "cpu"

        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = settings.onnx_threads
        session_options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            model_path,
            sess_options=session_options,
            providers=["CPUExecutionProvider"],
        )
        pad_token_id = getattr(self.tokenizer, "pad_token_id", None) or 0
        super().__init__(settings.batch_size, pad_token_id)

    def new_tokenizer(self) -> TokenizerLike:
        """A fresh tokenizer from the verified model files; one per server thread."""
        from transformers import AutoTokenizer

        return AutoTokenizer.from_pretrained(str(self._model_dir), local_files_only=True)

    def _score_batch(
        self, padded_windows: list[list[int]], attention_masks: list[list[int]]
    ) -> list[float]:
        np = self._np
        batch_size = len(padded_windows)
        length = len(padded_windows[0]) if padded_windows else 0
        feed: dict[str, Any] = {}
        for model_input in self.session.get_inputs():
            name = model_input.name
            if name == "input_ids":
                feed[name] = np.asarray(padded_windows, dtype=np.int64)
            elif name == "attention_mask":
                feed[name] = np.asarray(attention_masks, dtype=np.int64)
            elif name == "token_type_ids":
                feed[name] = np.zeros((batch_size, length), dtype=np.int64)
            elif name == "position_ids":
                feed[name] = np.asarray(
                    [list(range(length))] * batch_size, dtype=np.int64
                )
            else:
                raise ModelError(f"unsupported ONNX input: {name}")

        try:
            outputs = self.session.run(None, feed)
            if not outputs:
                raise ModelError("model returned no outputs")
            logits = np.asarray(outputs[0], dtype=np.float64)
            return [
                _malicious_probability(logits[row], self._labels)
                for row in range(batch_size)
            ]
        except ModelError:
            raise
        except Exception as exc:
            raise ModelError() from exc


class TorchPromptGuardScorer(BatchScoringScorer):
    """Loads Meta's official fp32 safetensors and runs batched GPU (or CPU) inference."""

    def __init__(self, settings: Settings) -> None:
        import torch
        from transformers import AutoConfig, AutoModelForSequenceClassification, AutoTokenizer

        self._torch = torch
        model_dir = Path(settings.model_path)
        if not model_dir.is_dir():
            raise RuntimeError(
                f"{TORCH_MODEL_ID} requires PROMPT_GUARD_MODEL_PATH to be a directory"
            )
        verify_model_directory(model_dir, TORCH_MODEL_FILES_SHA256)

        self._model_dir = model_dir
        self.tokenizer = self.new_tokenizer()
        config = AutoConfig.from_pretrained(str(model_dir), local_files_only=True)
        self._labels = _config_labels(config)

        if settings.torch_device == "auto":
            self.device = "cuda" if torch.cuda.is_available() else "cpu"
        else:
            self.device = settings.torch_device
        if self.device.startswith("cuda") and not torch.cuda.is_available():
            LOGGER.warning(
                "PROMPT_GUARD_TORCH_DEVICE requested cuda but no GPU is visible; falling back to cpu"
            )
            self.device = "cpu"

        if self.device == "cpu" and settings.torch_dtype != "fp32":
            LOGGER.warning(
                "torch backend on cpu ignores PROMPT_GUARD_TORCH_DTYPE=%s and uses fp32",
                settings.torch_dtype,
            )
            self._dtype = torch.float32
        elif settings.torch_dtype == "bf16":
            self._dtype = torch.bfloat16
        elif settings.torch_dtype == "fp16":
            self._dtype = torch.float16
        else:
            self._dtype = torch.float32

        LOGGER.info(
            "Prompt Guard torch backend loading on device=%s dtype=%s", self.device, self._dtype
        )
        try:
            # transformers >= 4.56 renamed this kwarg from torch_dtype to dtype.
            self.model = AutoModelForSequenceClassification.from_pretrained(
                str(model_dir),
                local_files_only=True,
                dtype=self._dtype,
            )
        except TypeError:
            self.model = AutoModelForSequenceClassification.from_pretrained(
                str(model_dir),
                local_files_only=True,
                torch_dtype=self._dtype,
            )
        self.model.to(self.device)
        self.model.eval()
        LOGGER.info(
            "Prompt Guard torch backend ready: cuda_available=%s device=%s",
            torch.cuda.is_available(),
            self.device,
        )

        pad_token_id = getattr(self.tokenizer, "pad_token_id", None) or 0
        super().__init__(settings.batch_size, pad_token_id)

    def new_tokenizer(self) -> TokenizerLike:
        from transformers import AutoTokenizer

        return AutoTokenizer.from_pretrained(str(self._model_dir), local_files_only=True)

    def _score_batch(
        self, padded_windows: list[list[int]], attention_masks: list[list[int]]
    ) -> list[float]:
        torch = self._torch
        try:
            input_ids = torch.tensor(padded_windows, dtype=torch.long, device=self.device)
            attention_mask = torch.tensor(
                attention_masks, dtype=torch.long, device=self.device
            )
            with torch.no_grad():
                outputs = self.model(input_ids=input_ids, attention_mask=attention_mask)
            logits = outputs.logits.to(torch.float64).cpu().numpy()
            return [
                _malicious_probability(logits[row], self._labels)
                for row in range(logits.shape[0])
            ]
        except ModelError:
            raise
        except Exception as exc:
            raise ModelError() from exc


class PromptGuardHTTPServer(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, address: tuple[str, int], runtime: Runtime) -> None:
        self.runtime = runtime
        super().__init__(address, PromptGuardRequestHandler)


class PromptGuardRequestHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "PromptGuard/1.0"

    @property
    def runtime(self) -> Runtime:
        runtime = getattr(self.server, "runtime", None)
        if not isinstance(runtime, Runtime):
            raise RuntimeError("server runtime is not configured")
        return runtime

    def do_GET(self) -> None:
        if self.path != "/health":
            self._write_error(BadRequest("unknown endpoint"))
            return
        if not self.runtime.ready:
            self._write_error(ModelError())
            return
        payload: dict[str, Any] = {
            "status": "ok",
            "backend": self.runtime.backend,
            "device": self.runtime.device,
            "cache": self.runtime.cache.stats(),
        }
        self._write_json(HTTPStatus.OK, payload)

    def do_POST(self) -> None:
        if self.path != "/classify":
            self._write_error(BadRequest("unknown endpoint"))
            return
        try:
            self._require_bearer_token()
            payload = self._read_payload()
            result = self.runtime.classify(payload["text"], payload["threshold"])
            self._write_json(HTTPStatus.OK, result.as_dict())
        except ServiceError as exc:
            self._write_error(exc)
        except Exception:
            LOGGER.exception("Unexpected request failure")
            self._write_error(ModelError())

    def _require_bearer_token(self) -> None:
        authorization = self.headers.get("Authorization", "")
        expected = f"Bearer {self.runtime.bearer_token}"
        if not hmac.compare_digest(authorization, expected):
            raise Unauthorized()

    def _read_payload(self) -> dict[str, Any]:
        content_type = self.headers.get("Content-Type", "")
        if content_type and content_type.split(";", 1)[0].strip().lower() != "application/json":
            raise BadRequest("Content-Type must be application/json")

        content_length = self.headers.get("Content-Length")
        if content_length is None:
            # Reading until EOF on an HTTP/1.1 keep-alive connection can block the
            # worker indefinitely. The only production caller uses fetch(), which
            # always supplies the length for this JSON request.
            raise LengthRequired()
        try:
            length = int(content_length)
        except ValueError as exc:
            raise BadRequest("Content-Length must be an integer") from exc
        if length < 0:
            raise BadRequest("Content-Length must not be negative")
        if length > self.runtime.max_body_bytes:
            raise PayloadTooLarge()
        body = self.rfile.read(length)

        if len(body) > self.runtime.max_body_bytes:
            raise PayloadTooLarge()
        try:
            payload = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise BadRequest("request body must be valid JSON") from exc
        if not isinstance(payload, dict):
            raise BadRequest("request body must be a JSON object")
        if "text" not in payload or "threshold" not in payload:
            raise BadRequest("request body must contain text and threshold")
        return payload

    def _write_error(self, error: ServiceError) -> None:
        if error.status_code == HTTPStatus.UNAUTHORIZED:
            self.send_response(error.status_code)
            self.send_header("WWW-Authenticate", 'Bearer realm="prompt-guard"')
            self.send_header("Content-Type", "application/json")
            body = json.dumps({"error": error.error_class, "detail": error.public_detail}).encode(
                "utf-8"
            )
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self._write_json(
            error.status_code,
            {"error": error.error_class, "detail": error.public_detail},
        )

    def _write_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, format_string: str, *args: Any) -> None:
        LOGGER.info("%s - %s", self.address_string(), format_string % args)


def main() -> None:
    logging.basicConfig(level=os.environ.get("PROMPT_GUARD_LOG_LEVEL", "INFO"))
    try:
        settings = Settings.from_env()
    except RuntimeError as exc:
        LOGGER.error("Invalid configuration: %s", exc)
        raise SystemExit(2) from exc

    runtime = Runtime.from_settings(settings)
    with PromptGuardHTTPServer((settings.host, settings.port), runtime) as server:
        LOGGER.info(
            "Prompt Guard sidecar listening on %s:%s (backend=%s device=%s)",
            settings.host,
            settings.port,
            settings.backend,
            runtime.device,
        )
        server.serve_forever()


if __name__ == "__main__":
    main()
