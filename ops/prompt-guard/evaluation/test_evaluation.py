import json
import os
import sys
import unittest
from pathlib import Path


sys.path.insert(0, os.path.dirname(__file__))

from run_evaluation import (  # noqa: E402
    calculate_report,
    load_cases,
    materialize_text,
    request_payload,
)


FIXTURE = Path(__file__).with_name("cases-v1.json")


class FixtureTests(unittest.TestCase):
    def test_fixture_is_versioned_balanced_and_covers_required_shapes(self):
        version, cases = load_cases(FIXTURE)
        self.assertEqual(version, "prompt-guard-eval/v1")
        self.assertEqual(len(cases), 28)
        self.assertEqual(
            sum(case["expected_label"] == "benign" for case in cases), 14
        )
        self.assertEqual(
            sum(case["expected_label"] == "malicious" for case in cases), 14
        )
        tags = {tag for case in cases for tag in case["tags"]}
        self.assertTrue({"indirect_tool_output", "html", "code"} <= tags)
        long_late = next(case for case in cases if case["id"] == "M14")
        text = materialize_text(long_late)
        self.assertGreater(len(text), 20_000)
        self.assertIn("late_injection", long_late["tags"])

    def test_expected_labels_and_tags_never_enter_request_payload(self):
        _, cases = load_cases(FIXTURE)
        payload = request_payload(cases[0], 0.5)
        self.assertEqual(set(payload), {"text", "threshold"})
        self.assertNotIn("expected_label", json.dumps(payload))
        self.assertNotIn("tags", json.dumps(payload))


class ReportTests(unittest.TestCase):
    def test_metrics_and_latency_distribution_are_separate(self):
        results = [
            {"id": "B", "expected_label": "benign", "flagged": False, "latency_ms": 1.0},
            {"id": "B2", "expected_label": "benign", "flagged": True, "latency_ms": 2.0},
            {"id": "M", "expected_label": "malicious", "flagged": True, "latency_ms": 3.0},
            {"id": "M2", "expected_label": "malicious", "flagged": False, "latency_ms": 4.0},
        ]
        report = calculate_report(
            version="prompt-guard-eval/v1",
            results=results,
            errors=[],
            threshold=0.5,
        )

        self.assertEqual(report["metrics"], {"precision": 0.5, "recall": 0.5, "false_positive_rate": 0.5})
        self.assertEqual(report["latency_ms"]["count"], 4)
        self.assertEqual(report["latency_ms"]["p50"], 2.5)
        self.assertEqual(report["latency_ms"]["p95"], 3.85)


if __name__ == "__main__":
    unittest.main()
