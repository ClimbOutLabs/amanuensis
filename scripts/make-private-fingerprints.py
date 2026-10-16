#!/usr/bin/env python3
"""
Regenerates scripts/private-data-fingerprints.json from private words kept outside the repo.

Words come from the git-ignored file .private-words.local (one word or multi-word name per
line) or the PRIVATE_WORDS env var (comma-separated). Only salted hashes are written.

Usage:
  python3 scripts/make-private-fingerprints.py            # print the JSON
  python3 scripts/make-private-fingerprints.py --write    # update the committed file
"""

import importlib.util
import json
import os
import re
import secrets
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
OUT = os.path.join(HERE, "private-data-fingerprints.json")
LOCAL_FILE = os.path.join(ROOT, ".private-words.local")

spec = importlib.util.spec_from_file_location("scan", os.path.join(HERE, "private-data-scan.py"))
scan = importlib.util.module_from_spec(spec)
spec.loader.exec_module(scan)


def read_words():
    words = []
    if os.path.exists(LOCAL_FILE):
        with open(LOCAL_FILE, "r", encoding="utf-8") as f:
            words += [line for line in f.read().splitlines() if line.strip() and not line.startswith("#")]
    words += [w for w in os.environ.get("PRIVATE_WORDS", "").split(",") if w.strip()]
    return words


def main():
    words = read_words()
    if not words:
        print("No words: create .private-words.local or set PRIVATE_WORDS.", file=sys.stderr)
        sys.exit(2)
    try:
        with open(OUT, "r", encoding="utf-8") as f:
            salt = json.load(f)["salt"]
    except (FileNotFoundError, KeyError):
        salt = secrets.token_hex(16)
    hashes = set()
    for word in words:
        tokens = scan.TOKEN_RE.findall(word.lower())
        if not 1 <= len(tokens) <= 2:
            print("Each entry must be one or two words.", file=sys.stderr)
            sys.exit(2)
        hashes.add(scan.fingerprint(salt, " ".join(tokens)))
    text = json.dumps({"salt": salt, "hashes": sorted(hashes)}, indent=2) + "\n"
    if "--write" in sys.argv:
        with open(OUT, "w", encoding="utf-8") as f:
            f.write(text)
    else:
        print(text, end="")


if __name__ == "__main__":
    main()
