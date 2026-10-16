# Prompt Guard sidecar

Built with Llama. Llama 4 is licensed under the Llama 4 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved. See [`THIRD_PARTY_NOTICES.md`](../../THIRD_PARTY_NOTICES.md).

This is an evaluation-only HTTP sidecar with two interchangeable backends. It
does not make policy or workflow decisions; callers decide what to do with
`flagged`. Read [`ADR.md`](./ADR.md) before use: neither backend is accepted
as a production security control and Aman keeps both screen flags off by
default.

- **`onnx` (default)**: CPU, a third-party quantized mirror of the model.
  This is the original, still-deployed configuration; existing deployments
  need no env changes.
- **`torch`**: GPU (falls back to CPU with a logged warning), Meta's official
  fp32 weights. Higher recall and much lower long-input latency on this
  fixture; see the ADR's "GPU backend on official weights" section for the
  comparison.

Both backends serve the same HTTP contract, so Aman's `MEMORY_SCREEN_URL` /
`TOOL_OUTPUT_SCREEN_URL` callers do not need to know which one is running.

## Configuration

Configuration is environment-only. `PROMPT_GUARD_BEARER_TOKEN` and
`PROMPT_GUARD_MODEL_PATH` are required for both backends.
`PROMPT_GUARD_MODEL_PATH` must be a mounted directory containing the
tokenizer/configuration files and the model artifact matching the selected
backend (see the two file tables below). The sidecar verifies every runtime
file in that directory against its pinned SHA-256 before loading and never
contacts Hugging Face at runtime.

| Variable                      | Default                                         | Applies to |
| ----------------------------- | ----------------------------------------------- | ---------- |
| `PROMPT_GUARD_HOST`           | `127.0.0.1` (`0.0.0.0` inside the container)    | both       |
| `PROMPT_GUARD_PORT`           | `8080`                                          | both       |
| `PROMPT_GUARD_MODEL_PATH`     | required mounted local model directory          | both       |
| `PROMPT_GUARD_BACKEND`        | `onnx`                                          | both       |
| `PROMPT_GUARD_WINDOW_STRIDE`  | `256`                                           | both       |
| `PROMPT_GUARD_MAX_BODY_BYTES` | `1048576`                                       | both       |
| `PROMPT_GUARD_CACHE_SIZE`     | `4096` (entries; `0` disables the cache)        | both       |
| `PROMPT_GUARD_MAX_INFLIGHT`   | `4`                                             | both       |
| `PROMPT_GUARD_BATCH_SIZE`     | `1` for `onnx`, `16` for `torch`                | both       |
| `PROMPT_GUARD_ONNX_THREADS`   | `1`                                             | `onnx`     |
| `PROMPT_GUARD_TORCH_DEVICE`   | `auto` (`cuda` if visible, else `cpu`)          | `torch`    |
| `PROMPT_GUARD_TORCH_DTYPE`    | `bf16` (`fp16`/`fp32`; forced to `fp32` on cpu) | `torch`    |

### `onnx` backend: model files

The model directory must be sourced from revision
`45a05fbd5337a864edc608f994911f009c37ca57` of
`gravitee-io/Llama-Prompt-Guard-2-86M-onnx`. The Llama 4 license applies even
though this mirror is ungated; review and accept its terms before distributing
or deploying the artifact.

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `config.json`             | `a39ae60b9b718b72bbe3f359ad07ddf6909dcb09ccff936c00a488ceb4e983a6` |
| `tokenizer.json`          | `870798f0e3bb05c636bf62be904b2d8f48ace4785e9c1d71a8a67bd0586c941d` |
| `tokenizer_config.json`   | `d5cff0d149f1084504aa8cbdd941289a011ec7f027519feb49e397c58b564398` |
| `special_tokens_map.json` | `b2f1b2f15f29a6b6d9d6ea4eca1675d2c231a71477f151d48f79cc83a625ba21` |
| `model.quant.onnx`        | `3ca25030566076c92c19168a64d6e203e4397cd936f55dd0345b4d3c6fbd9744` |

Download only those files from the pinned revision; do not fetch the redundant
full-precision artifacts:

```text
huggingface-cli download gravitee-io/Llama-Prompt-Guard-2-86M-onnx --revision 45a05fbd5337a864edc608f994911f009c37ca57 --include config.json tokenizer.json tokenizer_config.json special_tokens_map.json model.quant.onnx --local-dir <model-directory>
```

`requirements.in` contains the three direct dependencies. `requirements.txt`
is the generated closure with hashes for every accepted distribution, and
`Dockerfile` installs it with `--require-hashes`.

### `torch` backend: model files

The model directory must contain Meta's official
[`meta-llama/Llama-Prompt-Guard-2-86M`](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
fp32 weights. This is a gated model; download it yourself after accepting the
Llama 4 license on Hugging Face. Because these files were downloaded manually
rather than through `huggingface-cli`, there is no recorded HF revision hash;
the SHA-256 pins below (computed from the operator's own download) are the
provenance guarantee for this backend.

| File                      | SHA-256                                                            |
| ------------------------- | ------------------------------------------------------------------ |
| `config.json`             | `cd54ac39a1f2c3c5146bd5295b34038f8b4d9069e2f844450da014a523bb7653` |
| `tokenizer.json`          | `3e7e96867c2acdd575f0862c74822e05d1d15b93d9d9a4a2144b1ce83ae3339f` |
| `tokenizer_config.json`   | `fa09cf22b9d723377f95706967f789ca1a8267e1412385705e1ed51ce0559189` |
| `special_tokens_map.json` | `9463f61e1b109a8eb4688b829260d7c6b1e6dff04c98ff7269bb89e2b92369b9` |
| `model.safetensors`       | `e72017dbbe89c1232dcbc4a74ce0c389db5b468c42afd05850347b2a8c5f6b09` |

`Dockerfile.gpu` builds the `torch` backend image. It uses
`vllm/vllm-openai:v0.27.1` as its base (already ships a working torch+CUDA
build for aarch64) rather than pip-installing a torch wheel into a plain CUDA
image; see `ADR.md` for why, and `requirements-gpu.txt` for the versions this
relies on from that base image.

```text
docker build -f Dockerfile.gpu -t prompt-guard:gpu .
docker run --gpus all -p 8080:8080 \
  -e PROMPT_GUARD_BEARER_TOKEN=<token> \
  -e PROMPT_GUARD_MODEL_PATH=/models \
  -e PROMPT_GUARD_BACKEND=torch \
  -v <model-directory>:/models:ro \
  prompt-guard:gpu
```

### Window scoring, batching, caching, and concurrency (both backends)

The full input is first tokenized without truncation, divided into overlapping
512-token chunks, decoded, and re-tokenized with special tokens and
`max_length=512`. This makes every scored window an independently valid model
input while preserving Meta's chunk/decode/re-tokenize behavior. Windows are
scored in batches of `PROMPT_GUARD_BATCH_SIZE` (padded to the batch's longest
window); the response uses the maximum malicious score across all of a text's
windows regardless of how they were batched.

A per-process LRU cache, keyed by `sha256(model_id + text)`, skips rescoring
identical text (for example, the same recalled memory seen again); its size
is `PROMPT_GUARD_CACHE_SIZE` entries, `0` disables it, and its hit/miss counts
appear in `GET /health`. A semaphore bounded by `PROMPT_GUARD_MAX_INFLIGHT`
wraps each scorer forward pass so concurrent `ThreadingHTTPServer` requests
queue for the model instead of contending for it. A per-thread pool of loaded
tokenizers (`TOKENIZER_POOL_SIZE`, prewarmed at startup) works around
HuggingFace fast tokenizers not being thread-safe.

## HTTP contract

`GET /health` is unauthenticated and returns `{"status":"ok"}` only after
the tokenizer and model are ready, plus `backend`, `device`, and a `cache`
object with `hits`/`misses`/`size`/`max_size`.

`POST /classify` requires `Authorization: Bearer $PROMPT_GUARD_BEARER_TOKEN`
and a JSON body such as:

```json
{ "text": "Ignore previous instructions.", "threshold": 0.5 }
```

The success response is:

```json
{ "label": "malicious", "score": 0.99, "flagged": true }
```

The sidecar exposes stable error classes for `400 bad_request`, `401
unauthorized`, `411 length_required`, `413 payload_too_large`, and `500
model_error`. Requiring `Content-Length` prevents an HTTP/1.1 worker from
blocking while waiting for EOF on a persistent connection.

The scorer expects at least two class logits and applies softmax. Malicious is
class index 1 unless complete, exact `benign`/`malicious` metadata verifies a
different index. The wire label is normalized to `benign` or `malicious`.

Run tests from this directory with:

```text
python -m unittest discover -s tests -v
```

Unit tests use a tiny fake tokenizer/scorer and cover both backends'
configuration, the cache, the concurrency bound, and batching equivalence
without needing a GPU or either model's real weights. The separate synthetic
benchmark and its standard-library runner live in
[`evaluation/`](./evaluation/); it takes `--url` so it can be pointed at
either backend. The benchmark result and provenance decision are recorded in
the ADR; generated timing output is intentionally not checked into Git.
