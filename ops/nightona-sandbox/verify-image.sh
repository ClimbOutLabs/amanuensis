#!/usr/bin/env bash
set -euo pipefail

image="${1:?usage: verify-image.sh IMAGE}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
tesseract_langs="${TESSERACT_LANGS:-eng}"

user="$(docker image inspect "$image" --format '{{.Config.User}}')"
workdir="$(docker image inspect "$image" --format '{{.Config.WorkingDir}}')"
entrypoint="$(docker image inspect "$image" --format '{{json .Config.Entrypoint}}')"
architecture="$(docker image inspect "$image" --format '{{.Architecture}}')"

case "$architecture" in
  amd64|arm64) ;;
  *) echo "Unsupported image architecture: $architecture" >&2; exit 1 ;;
esac
test "$user" = "nightona"
test "$workdir" = "/home/nightona"
case "$entrypoint" in
  *nats-server*) ;;
  *) echo "Nightona NATS entrypoint was not preserved: $entrypoint" >&2; exit 1 ;;
esac

lang_checks=""
for lang in $tesseract_langs; do
  lang_checks="$lang_checks"'
    tesseract --list-langs | grep -Fx '"'$lang'"' || exit 1'
done

docker run --rm \
  --entrypoint /bin/sh \
  -v "$script_dir/create-fixtures.py:/opt/aman/create-fixtures.py:ro" \
  "$image" \
  -lc '
    set -eu
    command -v pdfinfo
    command -v pdftotext
    command -v pdftoppm
    command -v tesseract
    python3 -c "import PIL; print(PIL.__version__)"
    tesseract --list-langs | grep -Fx eng'"$lang_checks"'
    command -v ffmpeg
    python3 /opt/aman/create-fixtures.py
    test "$(pdftotext /tmp/aman-pdf-ocr-smoke/scan.pdf - | tr -d "[:space:]")" = ""
    tesseract /tmp/aman-pdf-ocr-smoke/scan.png stdout --psm 6 | grep -F "AMAN OCR SMOKE 4827"
    pdftoppm -f 1 -l 1 -png -r 150 -singlefile \
      /tmp/aman-pdf-ocr-smoke/scan.pdf /tmp/aman-pdf-ocr-smoke/rendered
    tesseract /tmp/aman-pdf-ocr-smoke/rendered.png stdout --psm 6 | grep -F "AMAN OCR SMOKE 4827"
  '

printf 'Verified %s (%s): Nightona contract, native PDF tools, image OCR, scanned-PDF OCR, and FFmpeg.\n' \
  "$image" "$architecture"
