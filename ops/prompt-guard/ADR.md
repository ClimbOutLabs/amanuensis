# Prompt Guard 2 evaluation decision

**Status:** evaluated; not adopted or enabled
**Date:** 2026-09-04

## Context

A synthetic LAN web page demonstrated that same-turn tool output could replace
the assistant's reply and cause in-context values to be repeated. PermissionGate
still prevented unapproved actions, but memory recall screening could not help:
the hostile output reached the model before it could ever be retained and
recalled.

The narrow host seam added by this change screens structurally open-world tool
results after dispatch and before model-context append. It does not alter
PermissionGate admission. Exact raw output remains visible on the terminal tool
event while flagged or unknown content is replaced only in the model-facing tool
message.

## Candidate

The evaluated artifact is the third-party quantized ONNX conversion
[`gravitee-io/Llama-Prompt-Guard-2-86M-onnx`](https://huggingface.co/gravitee-io/Llama-Prompt-Guard-2-86M-onnx)
at revision `45a05fbd5337a864edc608f994911f009c37ca57`. The service pins and checks all
runtime files; `model.quant.onnx` has SHA-256
`3ca25030566076c92c19168a64d6e203e4397cd936f55dd0345b4d3c6fbd9744`.
The Llama 4 license still applies even though this mirror is ungated.

Meta's [official model card](https://huggingface.co/meta-llama/Llama-Prompt-Guard-2-86M)
defines binary malicious/benign classification, a 512-token context, and reports
97.5% English recall at 1% false-positive rate plus 81.2% AgentDojo attack
prevention at 3% utility reduction. Meta also warns that adaptive attacks and
application-specific input distributions affect performance. The
[official inference helper](https://github.com/meta-llama/llama-cookbook/blob/main/getting-started/responsible_ai/prompt_guard/inference.py)
scores long text in 512-token chunks and takes the maximum malicious score.

The conversion author's own benchmark reports recall falling from 0.9625 for
the 86M full-precision model to 0.8018 for the quantized artifact. Those numbers
come from the conversion author's dataset and are not a substitute for a local
paired comparison.

## Local evaluation

The committed `prompt-guard-eval/v1` fixture contains 28 synthetic cases: 14
malicious and 14 benign. It includes the demonstrated HTML attack shape,
indirect JSON/code/calendar/Markdown injections, direct overrides, benign HTML
and code, security discussion hard negatives, and benign/malicious long inputs
with a late injection. Labels and tags never enter classifier requests.

Environment: Docker Desktop on the Windows development host, one CPU, sequential
ONNX window scoring, 512-token windows with 256-token overlap, threshold 0.5.

| Measure                        |               Result |
| ------------------------------ | -------------------: |
| Cases completed                |              28 / 28 |
| True positive / false negative |               12 / 2 |
| True negative / false positive |               14 / 0 |
| Precision                      |                 100% |
| Recall                         |                85.7% |
| False-positive rate            |                   0% |
| Overall latency p50 / p95      | 26.3 ms / 7,470.6 ms |
| Overall latency maximum        |          11,527.6 ms |

The red-team HTML shape was flagged at 0.994431. One direct role-play override
missed narrowly at 0.459802. More importantly, the long late-injection case
missed at 0.009594. The long benign and malicious cases took 11.5 and 11.3
seconds respectively. With Aman's 1.5-second screen timeout both would fail
closed, preventing injection but also withholding a benign long result.

A bounded-batching trial was rejected rather than retained: batch 16 was killed
by the 1 GiB container limit; batch 4 raised steady memory to about 1.2 GiB and
did not improve long-input latency. The final sidecar keeps the simpler
sequential path.

## Decision

Keep the host screening seam and sidecar as evaluation-only assets, with
`TOOL_OUTPUT_SCREEN_ENABLED=false` by default. Do not treat this quantized model
or threshold as an adopted production security control.

The required local quantized-versus-official full-precision comparison could not
be performed because the official weights are gated and no authorized official
artifact was available on this host. Bypassing that gate or silently treating a
third-party full-precision file as official would make the provenance claim
false. This unmet provenance check, the known published recall loss, the late
injection miss, and unacceptable long-input latency are each independently
sufficient to keep the feature off.

Reconsider adoption only after an authorized official artifact is compared on
the same inputs, a larger production-shaped benign/attack set establishes an
acceptable threshold, and long tool outputs can be screened within the chosen
latency budget without truncating content or causing false withholding.

## Boundary limitations

- Eligibility is structural: only completed results with
  `open_world_hint: true` are screened. Unannotated external MCP tools are not.
- The screen protects the next model-context append. It does not sanitize the
  raw event, change approval, or evaluate ordinary user messages.
- A subagent receives the same tool-output screen, but its generated summary is
  not classified a second time when returned to its parent.
- Prompt Guard is defense in depth, not proof that admitted content is safe.
