#!/usr/bin/env bash
# Builds, scans, signs, and pushes the run_code sandbox image.
#
# BUILD-START GATE: before running this script for a release, scan the recent
# build transcripts and logs for anomalies (failed layers retried silently,
# unexpected base-image pulls, hash mismatches, signer warnings). A build that
# starts from a dirty or surprising log state is not a release build — stop and
# investigate first. This gate is manual and must clear before every release.
#
# What this script does:
#   1. Fails closed unless the committed requirements.lock is hash-locked
#      (--hash entries present): the lock file is the single source of truth
#      and the build never re-resolves against PyPI (plan S7/D2, §2.9). To
#      change the set, run with --refresh-lock first (explicit, reviewable).
#   2. Builds multi-arch (linux/amd64, linux/arm64) with buildx from the pinned
#      base digests in packages/trueforge-core/scripts/sandbox-run-code/Dockerfile.
#   3. Generates an SBOM (syft) and attaches it to the image.
#   4. Runs trivy AND grype; any CRITICAL CVE fails the build (gate).
#   5. Signs the pushed manifest with cosign (keyless or key-based).
#   6. Prints the resulting tag@sha256: digest — that digest is what the release
#      stamps into SANDBOX_IMAGE (see scripts/changeset-sandbox-image.sh: the pin
#      lands on a separate pin PR; pending main files may be consumed first).
#
# Weekly rebuild: the image is rebuilt weekly even with no dependency changes,
# so the base OS layer never goes stale. The weekly job runs with
# --repin-bases first (fresh base digests), then a normal build.
#
# Manifest parity: amd64 and arm64 manifests must expose the same tool surface
# (python3.13, node 22, identical pip set). After push, the script inspects both
# arch manifests and diffs their config env/labels; a parity mismatch fails.
#
# Requirements: docker with buildx, syft, trivy, grype, cosign, crane (for
# --repin-bases). COSIGN_* env per your signing setup. Not runnable on machines
# without a Docker daemon — this script is authored, not executed, there.
set -euo pipefail

cd "$(dirname "$0")/.."

IMAGE_NAME="${SANDBOX_IMAGE_NAME:-ghcr.io/climboutlabs/amanuensis-sandbox}"
VERSION="${SANDBOX_IMAGE_VERSION:-0.1.0}"
CONTEXT_DIR="packages/trueforge-core/scripts/sandbox-run-code"
PLATFORMS="linux/amd64,linux/arm64"

if [[ "${1:-}" == "--refresh-lock" ]]; then
  # Maintainer-only: regenerate the hash-locked requirements.lock from the
  # current pin set, then exit (review the diff and commit — the build never
  # runs this implicitly). The pip-tools container is digest-pinned to the
  # same python base the Dockerfile builds from, so cp313 wheel hashes match
  # what the image will install. A PyPI union step then adds any cp313 linux
  # aarch64 wheel hashes pip-compile's x86_64 environment did not emit, so
  # both build arches stay hash-covered.
  PYTHON_DIGEST='sha256:2325bb286ec344af3e5898cc224b5844e2707ac6e26b1632516fd3edc84a5e26'
  REFRESH_TMP="$(mktemp -d)/requirements.lock"
  docker run --rm \
    -v "${PWD}/${CONTEXT_DIR}:/work" -w /work \
    "python:3.13-slim-bookworm@${PYTHON_DIGEST}" \
    sh -c 'pip install -q "pip-tools==7.6.1" && pip-compile --generate-hashes --allow-unsafe --output-file=/tmp/refreshed.lock requirements.lock && cat /tmp/refreshed.lock' \
    > "${REFRESH_TMP}"
  python3 - "${REFRESH_TMP}" "${CONTEXT_DIR}/requirements.lock" <<'PYEOF'
import json, sys, urllib.request
refreshed_path, lock_path = sys.argv[1], sys.argv[2]
text = open(refreshed_path).read()
pins = {}
for line in text.splitlines():
    line = line.strip().rstrip('\\').strip()
    if '==' in line and '--hash' not in line and not line.startswith('#'):
        name, ver = line.split('==', 1)
        pins[name.strip().lower()] = ver.strip()
def usable(fn):
    if fn.endswith('.tar.gz'):
        return True
    if not fn.endswith('.whl'):
        return False
    parts = fn[:-4].split('-')
    pytag, abitag, plat = parts[-3], parts[-2], parts[-1]
    py_ok = ('cp313' in pytag) or ('abi3' in abitag) or ('py3' in pytag) or ('py2.py3' in pytag)
    return py_ok and (('linux' in plat) or (plat == 'any'))
have_hashes = set()
for line in text.splitlines():
    line = line.strip()
    if line.startswith('--hash=sha256:'):
        have_hashes.add(line.split(':', 1)[1].rstrip('\\').strip())
extra = []
for name, ver in pins.items():
    req = urllib.request.Request(f'https://pypi.org/pypi/{name}/{ver}/json')
    with urllib.request.urlopen(req, timeout=30) as resp:
        d = json.load(resp)
    for fn, sha in ((u['filename'], u['digests']['sha256']) for u in d['urls'] if not u.get('yanked')):
        if usable(fn) and sha not in have_hashes and 'aarch64' in fn:
            extra.append((name, sha))
if extra:
    by_pkg = {}
    for name, sha in extra:
        by_pkg.setdefault(name, []).append(sha)
    out = []
    for line in text.splitlines():
        out.append(line)
        stripped = line.strip()
        if stripped.startswith('--hash=sha256:') is False and '==' in stripped and '--hash' not in stripped and not stripped.startswith('#'):
            pkg = stripped.rstrip('\\').strip().split('==', 1)[0].strip().lower()
            if pkg in by_pkg:
                for sha in sorted(set(by_pkg[pkg])):
                    out.append(f'    --hash=sha256:{sha} \\')
                del by_pkg[pkg]
    # Inserted lines carry their own continuation; pip-compile's own output
    # stays well-formed, so no fixup pass is needed.
    text = '\n'.join(out)
open(lock_path, 'w').write(text if text.endswith('\n') else text + '\n')
print(f'refreshed {lock_path}: {len(pins)} packages, +{len(extra)} aarch64 hashes unioned in')
PYEOF
  rm -rf "$(dirname "${REFRESH_TMP}")"
  echo "Review the diff, then commit: git diff --stat ${CONTEXT_DIR}/requirements.lock"
  exit 0
fi

if [[ "${1:-}" == "--repin-bases" ]]; then
  # Prints fresh manifest-list digests for the two base tags. Paste them into
  # the Dockerfile's FROM lines (and the comment block above them) after the
  # transcript/log scan gate clears.
  for repo in library/python library/node; do
    case "$repo" in
      library/python) tag="3.13-slim-bookworm" ;;
      library/node) tag="22-bookworm-slim" ;;
    esac
    token="$(curl -fsS "https://auth.docker.io/token?service=registry.docker.io&scope=repository:${repo}:pull" | jq -r .token)"
    digest="$(curl -fsSI -H "Authorization: Bearer ${token}" -H 'Accept: application/vnd.oci.image.index.v1+json' \
      "https://registry-1.docker.io/v2/${repo}/manifests/${tag}" | grep -i '^docker-content-digest:' | awk '{print $2}' | tr -d '\r')"
    echo "${tag} @ ${digest}"
  done
  exit 0
fi

if ! docker buildx inspect >/dev/null 2>&1; then
  echo "docker buildx is required" >&2
  exit 1
fi

echo "==> verifying the committed requirements.lock is hash-locked"
# E9: the committed lock file is the hash-locked source of truth — the build
# never re-resolves against PyPI (that would let versions drift between the
# reviewed pin set and the built image). A lock without --hash entries fails
# the build instead of installing unpinned.
if ! grep -q '^[[:space:]]*--hash=sha256:' "${CONTEXT_DIR}/requirements.lock"; then
  echo "requirements.lock has no --hash entries: refusing to build an unpinned image." >&2
  echo "Regenerate it with: $0 --refresh-lock (then review the diff and commit)." >&2
  exit 1
fi

echo "==> building ${IMAGE_NAME}:${VERSION} for ${PLATFORMS}"
docker buildx build \
  --platform "${PLATFORMS}" \
  -t "${IMAGE_NAME}:${VERSION}" \
  --push \
  "${CONTEXT_DIR}"

DIGEST="$(crane digest "${IMAGE_NAME}:${VERSION}")"
echo "==> pushed ${IMAGE_NAME}:${VERSION}@${DIGEST}"

echo "==> SBOM (syft)"
# The SBOM is a build artifact, not a repo file: it lives in a temp dir so no
# sbom-*.spdx.json strays at the repo root (also gitignored as belt-and-braces).
SBOM_DIR="$(mktemp -d)"
trap 'rm -rf "${SBOM_DIR}"' EXIT
SBOM_FILE="${SBOM_DIR}/sbom-${VERSION}.spdx.json"
syft "${IMAGE_NAME}:${VERSION}@${DIGEST}" -o spdx-json > "${SBOM_FILE}"

echo "==> vulnerability gates (trivy + grype, critical = fail)"
trivy image --severity CRITICAL --exit-code 1 "${IMAGE_NAME}:${VERSION}@${DIGEST}"
grype "${IMAGE_NAME}:${VERSION}@${DIGEST}" --fail-on critical

echo "==> manifest parity (amd64 vs arm64)"
for arch in amd64 arm64; do
  crane manifest "${IMAGE_NAME}:${VERSION}@${DIGEST}" \
    | jq -r --arg arch "$arch" '.manifests[] | select(.platform.architecture==$arch) | .digest' \
    > "/tmp/sandbox-manifest-${arch}.txt"
  arch_digest="$(cat "/tmp/sandbox-manifest-${arch}.txt")"
  crane config "${IMAGE_NAME}@${arch_digest}" | jq -S '.config.Env, .config.Labels' > "/tmp/sandbox-config-${arch}.json"
done
if ! diff -u /tmp/sandbox-config-amd64.json /tmp/sandbox-config-arm64.json; then
  echo "manifest parity FAILED: arch configs differ" >&2
  exit 1
fi
echo "manifest parity ok"

echo "==> signing with cosign"
cosign sign --yes "${IMAGE_NAME}:${VERSION}@${DIGEST}"
cosign attest --yes --predicate "${SBOM_FILE}" --type spdxjson "${IMAGE_NAME}:${VERSION}@${DIGEST}"

cat <<EOF

Done. Stamp this digest into the release config / pin PR:
  SANDBOX_IMAGE=${IMAGE_NAME}:${VERSION}@${DIGEST}
SBOM: ${SBOM_FILE} (attested; removed on exit by trap)
EOF
