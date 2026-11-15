#!/usr/bin/env bash
# Runs every installer test file and fails if any of them does. With PART/PARTS (for example 2/4) it runs only every
# PARTS-th file starting at PART, so CI can split the files over several machines.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
part=1 parts=1
if [ "$#" -gt 0 ]; then
  if [[ ! $1 =~ ^([1-9][0-9]*)/([1-9][0-9]*)$ ]] || [ "${BASH_REMATCH[1]}" -gt "${BASH_REMATCH[2]}" ]; then
    echo "usage: run.sh [PART/PARTS], for example 2/4" >&2
    exit 2
  fi
  part=${BASH_REMATCH[1]}
  parts=${BASH_REMATCH[2]}
fi
failed=0 n=0
while IFS= read -r t; do
  n=$((n + 1))
  [ $(((n - 1) % parts + 1)) = "$part" ] || continue
  # Each file gets its own stdin, so a test that reads input cannot take the list of the files still to run.
  if ! bash "$t" </dev/null; then
    failed=1
  fi
done < <(find . -name '*.test.sh' | LC_ALL=C sort)
exit "$failed"
