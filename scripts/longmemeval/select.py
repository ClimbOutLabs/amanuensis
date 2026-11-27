"""Read the pinned LongMemEval-S release and emit a reproducible CI panel or the full split."""

import argparse
import hashlib
import json
from pathlib import Path

DIGEST = "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442"
GROUPS = {
    "single-session-user", "single-session-assistant", "single-session-preference",
    "temporal-reasoning", "knowledge-update", "multi-session", "abstention",
}

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("dataset", type=Path)
parser.add_argument("output", type=Path)
parser.add_argument("questions", type=Path)
parser.add_argument("--full", action="store_true")
options = parser.parse_args()
with options.dataset.open("rb") as source:
    if hashlib.file_digest(source, "sha256").hexdigest() != DIGEST:
        raise ValueError("Unexpected dataset checksum. Download the pinned LongMemEval-S release.")
    source.seek(0)
    rows = json.load(source)
if len({row["question_id"] for row in rows}) != 500 or len(rows) != 500:
    raise ValueError("Expected 500 distinct benchmark questions.")
seen = set()
with options.output.open("w", encoding="utf-8") as output, options.questions.open("w", encoding="utf-8") as questions:
    for row in sorted(rows, key=lambda item: item["question_id"]):
        group = "abstention" if row["question_id"].endswith("_abs") else row["question_type"]
        if options.full or group not in seen:
            print(json.dumps(row), file=output)
            print(json.dumps({key: row[key] for key in ("question", "question_date", "question_type", "question_id", "answer")}), file=questions)
        seen.add(group)
if seen != GROUPS:
    raise ValueError("Unexpected benchmark categories.")
