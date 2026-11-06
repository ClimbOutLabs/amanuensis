#!/usr/bin/env bash
# Runs every installer test file and fails if any of them does.
# INSTALLER_TEST_SHARD=k/n runs only the k-th of n equal slices of the sorted file list, so CI can
# spread the suite over several machines; together the n slices run every file exactly once.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
shard=${INSTALLER_TEST_SHARD:-1/1}
case "$shard" in
  */*) shard_index=${shard%/*} shard_count=${shard#*/} ;;
  *) shard_index='' shard_count='' ;;
esac
if ! [[ "$shard_index" =~ ^[1-9][0-9]*$ && "$shard_count" =~ ^[1-9][0-9]*$ ]] || [ "$shard_index" -gt "$shard_count" ]; then
  echo "INSTALLER_TEST_SHARD must look like 2/4 (slice 2 of 4). It was: $shard" >&2
  exit 2
fi
failed=0
position=0
while IFS= read -r t; do
  position=$((position + 1))
  [ $(((position - 1) % shard_count + 1)) -eq "$shard_index" ] || continue
  # Each file gets its own stdin, so a test that reads input cannot take the list of the files still to run.
  if ! bash "$t" </dev/null; then
    failed=1
  fi
done < <(find . -name '*.test.sh' | sort)
exit "$failed"
