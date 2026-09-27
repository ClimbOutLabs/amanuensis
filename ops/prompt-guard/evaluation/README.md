# Prompt Guard evaluation harness

`cases-v1.json` is a compact, synthetic, balanced 28-case fixture. Expected
labels and tags are evaluator metadata only; they are never included in the
`/classify` request. The long cases use a repeat template so the fixture stays
small while still exercising late content beyond the model window.

Set `PROMPT_GUARD_BEARER_TOKEN` in the process environment, then run against
an already-running sidecar with:

```text
python run_evaluation.py
```

The runner uses only the Python standard library. It records each response's
score, `flagged` value, label, and latency, then reports precision, recall,
false-positive rate, and latency count/min/mean/p50/p95/max. Metrics use the
sidecar's boolean `flagged` result at the requested threshold. The runner does
not start a service or load a model.

The fixture includes 14 benign and 14 malicious cases, direct jailbreak and
override attempts, indirect HTML/JSON/code/calendar/webpage tool-output
injections, benign HTML/code/security discussion, and a late long-input
injection.
