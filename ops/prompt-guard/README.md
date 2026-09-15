# Prompt Guard sidecar

This is an evaluation-only, CPU HTTP sidecar. It does not make policy or
workflow decisions; callers decide what to do with `flagged`. Read
[`ADR.md`](./ADR.md) before use: the evaluated quantized artifact was not
accepted as a production security control and Aman keeps both screen flags off
by default.

## Configuration

Configuration is environment-only. `PROMPT_GUARD_BEARER_TOKEN` and
`PROMPT_GUARD_MODEL_PATH` are required. `PROMPT_GUARD_MODEL_PATH` must be a
mounted directory containing the tokenizer/configuration files and the exact
`model.quant.onnx` artifact below. The sidecar verifies every runtime file in
that directory against its pinned SHA-256 before loading and never contacts
Hugging Face at runtime.

The model directory must be sourced from revision
`45a05fbd5337a864edc608f994911f009c37ca57` of
`gravitee-io/Llama-Prompt-Guard-2-86M-onnx`. The Llama 4 license applies even
though this mirror is ungated; review and accept its terms before distributing
or deploying the artifact.

The remaining settings are optional:

| Variable                      | Default                                      |
| ----------------------------- | -------------------------------------------- |
| `PROMPT_GUARD_HOST`           | `127.0.0.1` (`0.0.0.0` inside the container) |
| `PROMPT_GUARD_PORT`           | `8080`                                       |
| `PROMPT_GUARD_MODEL_PATH`     | required mounted local model directory       |
| `PROMPT_GUARD_WINDOW_STRIDE`  | `256`                                        |
| `PROMPT_GUARD_MAX_BODY_BYTES` | `1048576`                                    |
| `PROMPT_GUARD_ONNX_THREADS`   | `1`                                          |

At startup, these runtime files are checked before the ONNX session is created:

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
is the generated closure with hashes for every accepted distribution, and the
Docker build installs it with `--require-hashes`.

The full input is first tokenized without truncation, divided into overlapping
512-token chunks, decoded, and re-tokenized with special tokens and
`max_length=512`. This makes every scored window an independently valid model
input while preserving Meta's chunk/decode/re-tokenize behavior. The response
uses the maximum malicious score.

## HTTP contract

`GET /health` is unauthenticated and returns `{"status":"ok"}` only after
the tokenizer and ONNX session are ready.

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

The separate synthetic benchmark and its standard-library runner live in
[`evaluation/`](./evaluation/). The benchmark result and provenance decision
are recorded in the ADR; generated timing output is intentionally not checked
into Git.
