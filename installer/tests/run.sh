#!/usr/bin/env bash
# Runs every installer test file and fails if any of them does.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
failed=0
while IFS= read -r t; do
  # Each file gets its own stdin, so a test that reads input cannot take the list of the files still to run.
  if ! bash "$t" </dev/null; then
    failed=1
  fi
done < <(find . -name '*.test.sh' | sort)
exit "$failed"
