"""Standard-library evaluation runner for the Prompt Guard sidecar."""

from __future__ import annotations

import argparse
import json
import os
import statistics
import sys
import time
from pathlib import Path
from typing import Any, Callable, Iterable
from urllib import error as urllib_error
from urllib import request as urllib_request


DEFAULT_CASES = Path(__file__).with_name("cases-v1.json")
DEFAULT_URL = "http://127.0.0.1:8080/classify"


class EvaluationError(Exception):
    pass


def load_cases(path: Path) -> tuple[str, list[dict[str, Any]]]:
    with path.open("r", encoding="utf-8") as fixture_file:
        fixture = json.load(fixture_file)
    if not isinstance(fixture, dict) or not isinstance(fixture.get("cases"), list):
        raise EvaluationError("fixture must contain a cases array")
    version = fixture.get("schema_version")
    if version != "prompt-guard-eval/v1":
        raise EvaluationError("unsupported fixture schema version")

    cases = fixture["cases"]
    seen_ids: set[str] = set()
    for case in cases:
        validate_case(case, seen_ids)
    labels = [case["expected_label"] for case in cases]
    if labels.count("benign") != labels.count("malicious"):
        raise EvaluationError("fixture must be balanced")
    return version, cases


def validate_case(case: Any, seen_ids: set[str]) -> None:
    if not isinstance(case, dict):
        raise EvaluationError("each fixture case must be an object")
    case_id = case.get("id")
    if not isinstance(case_id, str) or not case_id or case_id in seen_ids:
        raise EvaluationError("case ids must be non-empty and unique")
    seen_ids.add(case_id)
    if case.get("expected_label") not in {"benign", "malicious"}:
        raise EvaluationError(f"invalid expected label for {case_id}")
    if not isinstance(case.get("tags"), list) or not case["tags"]:
        raise EvaluationError(f"tags are required for {case_id}")
    has_text = isinstance(case.get("text"), str)
    has_template = all(
        isinstance(case.get(field), str)
        for field in ("text_prefix", "text_suffix")
    ) and isinstance(case.get("repeat"), dict)
    if has_text == has_template:
        raise EvaluationError(f"case {case_id} must use text or a template")
    if has_template:
        repeat = case["repeat"]
        if not isinstance(repeat.get("text"), str) or not isinstance(
            repeat.get("count"), int
        ) or repeat["count"] < 0:
            raise EvaluationError(f"invalid repeat template for {case_id}")


def materialize_text(case: dict[str, Any]) -> str:
    if isinstance(case.get("text"), str):
        return case["text"]
    repeat = case["repeat"]
    return (
        case["text_prefix"]
        + repeat["text"] * repeat["count"]
        + case["text_suffix"]
    )


def request_payload(case: dict[str, Any], threshold: float) -> dict[str, Any]:
    """Keep fixture labels/tags out of the wire request by construction."""

    return {"text": materialize_text(case), "threshold": threshold}


def classify_case(
    case: dict[str, Any],
    *,
    url: str,
    bearer_token: str,
    threshold: float,
    timeout: float,
    opener: Callable[..., Any] = urllib_request.urlopen,
) -> dict[str, Any]:
    payload = json.dumps(request_payload(case, threshold), separators=(",", ":")).encode(
        "utf-8"
    )
    request = urllib_request.Request(
        url,
        data=payload,
        headers={
            "Authorization": f"Bearer {bearer_token}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    started = time.perf_counter()
    try:
        with opener(request, timeout=timeout) as response:
            response_body = response.read()
            status = response.status
    except urllib_error.HTTPError as exc:
        response_body = exc.read()
        status = exc.code
    elapsed_ms = (time.perf_counter() - started) * 1_000
    if status != 200:
        raise EvaluationError(
            f"{case['id']} returned HTTP {status}: {response_body[:200]!r}"
        )
    try:
        result = json.loads(response_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise EvaluationError(f"{case['id']} returned invalid JSON") from exc
    if not isinstance(result, dict) or not isinstance(result.get("flagged"), bool):
        raise EvaluationError(f"{case['id']} returned an invalid classify response")
    if not isinstance(result.get("score"), (int, float)) or not isinstance(
        result.get("label"), str
    ):
        raise EvaluationError(f"{case['id']} returned an invalid classify response")
    return {
        "id": case["id"],
        "expected_label": case["expected_label"],
        "predicted_label": result["label"],
        "score": float(result["score"]),
        "flagged": result["flagged"],
        "latency_ms": round(elapsed_ms, 3),
        "tags": case["tags"],
    }


def percentile(values: list[float], percentile_value: float) -> float:
    if not values:
        return 0.0
    ordered = sorted(values)
    position = (len(ordered) - 1) * percentile_value / 100
    lower = int(position)
    upper = min(lower + 1, len(ordered) - 1)
    fraction = position - lower
    return ordered[lower] + (ordered[upper] - ordered[lower]) * fraction


def calculate_report(
    *, version: str, results: Iterable[dict[str, Any]], errors: list[str], threshold: float
) -> dict[str, Any]:
    result_list = list(results)
    true_positive = sum(
        result["expected_label"] == "malicious" and result["flagged"]
        for result in result_list
    )
    false_positive = sum(
        result["expected_label"] == "benign" and result["flagged"]
        for result in result_list
    )
    false_negative = sum(
        result["expected_label"] == "malicious" and not result["flagged"]
        for result in result_list
    )
    true_negative = sum(
        result["expected_label"] == "benign" and not result["flagged"]
        for result in result_list
    )
    latencies = [float(result["latency_ms"]) for result in result_list]
    positive_predictions = true_positive + false_positive
    actual_positives = true_positive + false_negative
    actual_negatives = true_negative + false_positive
    return {
        "schema_version": "prompt-guard-eval-report/v1",
        "fixture_version": version,
        "threshold": threshold,
        "cases_evaluated": len(result_list),
        "cases_failed": len(errors),
        "confusion_matrix": {
            "true_positive": true_positive,
            "false_positive": false_positive,
            "false_negative": false_negative,
            "true_negative": true_negative,
        },
        "metrics": {
            "precision": true_positive / positive_predictions if positive_predictions else 0.0,
            "recall": true_positive / actual_positives if actual_positives else 0.0,
            "false_positive_rate": false_positive / actual_negatives if actual_negatives else 0.0,
        },
        "latency_ms": {
            "count": len(latencies),
            "min": min(latencies) if latencies else 0.0,
            "mean": statistics.fmean(latencies) if latencies else 0.0,
            "p50": percentile(latencies, 50),
            "p95": percentile(latencies, 95),
            "max": max(latencies) if latencies else 0.0,
        },
        "errors": errors,
        "results": result_list,
    }


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", default=os.environ.get("PROMPT_GUARD_URL", DEFAULT_URL))
    parser.add_argument("--token", default=os.environ.get("PROMPT_GUARD_BEARER_TOKEN"))
    parser.add_argument("--cases", type=Path, default=DEFAULT_CASES)
    parser.add_argument("--threshold", type=float, default=0.5)
    parser.add_argument("--timeout", type=float, default=30.0)
    parser.add_argument("--output", type=Path)
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(sys.argv[1:] if argv is None else argv)
    if not args.token:
        print("PROMPT_GUARD_BEARER_TOKEN or --token is required", file=sys.stderr)
        return 2
    version, cases = load_cases(args.cases)
    results: list[dict[str, Any]] = []
    errors: list[str] = []
    for case in cases:
        try:
            results.append(
                classify_case(
                    case,
                    url=args.url,
                    bearer_token=args.token,
                    threshold=args.threshold,
                    timeout=args.timeout,
                )
            )
        except (EvaluationError, OSError) as exc:
            errors.append(str(exc))

    report = calculate_report(
        version=version, results=results, errors=errors, threshold=args.threshold
    )
    serialized = json.dumps(report, indent=2, sort_keys=True) + "\n"
    if args.output:
        args.output.write_text(serialized, encoding="utf-8")
    else:
        print(serialized, end="")
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
