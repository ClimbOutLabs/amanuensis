#!/usr/bin/env python3
"""
Private data scanner for Amanuensis public repo pushes.
HARD RESTRICTION: Run this before any push to ClimbOutLabs/amanuensis.
Exit 0 = clean. Exit 1 = private data found (DO NOT PUSH).

Usage:
  python3 private-data-scan.py <directory>
  python3 private-data-scan.py --diff <git-diff-file>
"""

import re
import sys
import os

# Patterns that indicate private data. Each is (name, regex).
PATTERNS = [
    ("Tailscale hostname", r"[a-z0-9-]+\.ts\.net"),
    ("Tailscale IP", r"\b100\.\d{1,3}\.\d{1,3}\.\d{1,3}\b"),
    ("Private IPv4", r"\b(?:192\.168|10\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01]))\.\d{1,3}\.\d{1,3}\b"),
    ("AWS access key", r"\bAKIA[0-9A-Z]{16}\b"),
    ("GitHub PAT", r"\bghp_[A-Za-z0-9]{36}\b"),
    ("GitHub fine-grained PAT", r"\bgithub_pat_[A-Za-z0-9_]{22,}\b"),
    ("OpenAI API key", r"\bsk-[A-Za-z0-9]{20,}\b"),
    ("Anthropic API key", r"\bsk-ant-[A-Za-z0-9-]{20,}\b"),
    ("Generic API key assignment", r"(?i)(api[_-]?key|apikey)\s*[:=]\s*['\"][^'\"]{8,}['\"]"),
    ("Generic secret assignment", r"(?i)(secret|password|passwd|pwd|token)\s*[:=]\s*['\"][^'\"]{8,}['\"]"),
    ("Private key block", r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ("Bearer token", r"(?i)bearer\s+[A-Za-z0-9\-._~+/]{20,}"),
    ("Email address", r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b"),
    # Personal identifiers (Sidd's info - add more as needed)
    ("Personal full name", r"(?i)siddharth\s+choure"),
    ("Home path with username", r"/home/[a-z_][a-z0-9_-]*/"),
    ("macOS user path", r"/Users/[A-Z][a-z]+/"),
]

# File extensions to skip (binaries, lockfiles with hashes are OK)
SKIP_EXTENSIONS = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".webm"}
SKIP_FILES = {"package-lock.json", "pnpm-lock.yaml", "yarn.lock", "Cargo.lock", "poetry.lock"}

# Allowlist: (pattern_name, file_substring) - known false positives by file path
ALLOWLIST = [
    ("Email address", "test"),      # test fixtures
    ("Email address", "example"),   # example.com etc.
    ("Email address", "example.com"),
    ("Email address", "test.com"),
]

# Content allowlist: (pattern_name, content_substring) - known false positives by line content
CONTENT_ALLOWLIST = [
    ("Email address", "acme.com"),  # RFC example domain in docs
    ("Email address", "example.com"),
]

def scan_file(path):
    """Scan a single file. Returns list of (pattern_name, line_no, line_preview)."""
    findings = []
    ext = os.path.splitext(path)[1].lower()
    if ext in SKIP_EXTENSIONS:
        return findings
    if os.path.basename(path) in SKIP_FILES:
        return findings
    try:
        with open(path, "r", encoding="utf-8", errors="strict") as f:
            for i, line in enumerate(f, 1):
                for name, pattern in PATTERNS:
                    if re.search(pattern, line):
                        # Check path-based allowlist
                        allowed = any(
                            allow_name == name and allow_sub in path.lower()
                            for allow_name, allow_sub in ALLOWLIST
                        )
                        # Check content-based allowlist
                        if not allowed:
                            allowed = any(
                                allow_name == name and allow_sub in line.lower()
                                for allow_name, allow_sub in CONTENT_ALLOWLIST
                            )
                        if not allowed:
                            preview = line.strip()[:100]
                            findings.append((name, i, preview))
    except (UnicodeDecodeError, PermissionError, IsADirectoryError):
        pass
    return findings

def scan_directory(root):
    """Walk a directory and scan all files."""
    all_findings = {}
    for dirpath, dirnames, filenames in os.walk(root):
        # Skip node_modules, .git, build outputs
        dirnames[:] = [d for d in dirnames if d not in {".git", "node_modules", "dist", "build", ".next", "__pycache__"}]
        for fn in filenames:
            fp = os.path.join(dirpath, fn)
            findings = scan_file(fp)
            if findings:
                all_findings[fp] = findings
    return all_findings

def main():
    if len(sys.argv) < 2:
        print("Usage: python3 private-data-scan.py <directory>")
        sys.exit(2)
    target = sys.argv[1]
    if not os.path.isdir(target):
        print(f"Not a directory: {target}")
        sys.exit(2)

    findings = scan_directory(target)
    if not findings:
        print("CLEAN: no private data patterns found.")
        sys.exit(0)

    print(f"BLOCKED: private data found in {len(findings)} file(s). DO NOT PUSH.\n")
    for fp, hits in sorted(findings.items()):
        print(f"  {fp}")
        for name, line_no, preview in hits:
            print(f"    Line {line_no} [{name}]: {preview}")
        print()
    sys.exit(1)

if __name__ == "__main__":
    main()
