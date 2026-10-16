#!/usr/bin/env bash
# Runs the real https front end from the pinned image with the installer's own configuration and certificate, in front of a
# stand-in app, and checks what a device sees: https answers at two different addresses with only the authority trusted,
# the plain port redirects to https and serves the trust page, and a client without the authority is refused.
# Needs a running Docker, Node.js and curl.
set -euo pipefail

INSTALLER=$(cd -P -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
WORK=$(mktemp -d)
NAME=aman-tls-live-$$
HTTPS_PORT=${AMAN_TEST_HTTPS_PORT:-28443}
HTTP_PORT=${AMAN_TEST_HTTP_PORT:-28081}
SECOND=127.0.0.2

cleanup() {
  docker rm -f "$NAME-backend" "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK"
}
trap cleanup EXIT

fail() {
  printf 'FAIL: %s\n' "$1" >&2
  docker logs "$NAME" 2>&1 | tail -n 20 >&2 || true
  exit 1
}

IMAGE=$(sed -n 's/.*"caddy_image": *"\([^"]*\)".*/\1/p' "$INSTALLER/release.json")
[ -n "$IMAGE" ] || fail "release.json has no caddy_image"

mkdir -p "$WORK/tls/trust"
node "$INSTALLER/lib/pki.mjs" ensure-ca "$WORK/tls/ca" >/dev/null
node "$INSTALLER/lib/pki.mjs" issue "$WORK/tls/ca" "$WORK/tls/leaf/main" 127.0.0.1 "$SECOND" localhost >/dev/null
cp "$WORK/tls/ca/root.crt" "$WORK/tls/trust/ca.crt"
printf '<html>trust page</html>\n' >"$WORK/tls/trust/index.html"
# The same template and placeholders the installer fills in.
sed "s|@@NAME@@|main|; s|@@DEFAULT_NAME@@|127.0.0.1|; s|@@HTTPS_IN@@|8443|g; s|@@HTTP_IN@@|8081|g; s|@@HTTPS_PORT@@|$HTTPS_PORT|" \
  "$INSTALLER/templates/tls/Caddyfile.tpl" >"$WORK/Caddyfile"
chmod -R a+rX "$WORK"

docker run -d --name "$NAME" --user "$(id -u):$(id -g)" \
  -p "127.0.0.1:$HTTPS_PORT:8443" -p "$SECOND:$HTTPS_PORT:8443" -p "127.0.0.1:$HTTP_PORT:8081" -p "$SECOND:$HTTP_PORT:8081" \
  --tmpfs /data --tmpfs /config -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" -v "$WORK/tls/leaf/main:/certs:ro" \
  -v "$WORK/tls/trust:/srv/trust:ro" "$IMAGE" caddy run --config /etc/caddy/Caddyfile >/dev/null
docker run -d --name "$NAME-backend" --network "container:$NAME" "$IMAGE" caddy respond --listen :8790 --body backend-ok >/dev/null

for _ in $(seq 1 30); do
  [ "$(curl -sS --max-time 2 --cacert "$WORK/tls/ca/root.crt" "https://127.0.0.1:$HTTPS_PORT/" 2>/dev/null)" = backend-ok ] && break
  sleep 1
done

for address in 127.0.0.1 "$SECOND"; do
  body=$(curl -sS --max-time 8 --cacert "$WORK/tls/ca/root.crt" "https://$address:$HTTPS_PORT/") || fail "https at $address is not trusted or not answering"
  [ "$body" = backend-ok ] || fail "https at $address did not reach the app: $body"
done

redirect=$(curl -sS --max-time 8 -o /dev/null -w '%{http_code} %{redirect_url}' "http://$SECOND:$HTTP_PORT/some/path?x=1")
[ "$redirect" = "308 https://$SECOND:$HTTPS_PORT/some/path?x=1" ] || fail "the plain port answered [$redirect]"

[ "$(curl -sS --max-time 8 "http://$SECOND:$HTTP_PORT/trust")" = '<html>trust page</html>' ] || fail "the trust page is not served"
download=$(curl -sS --max-time 8 -o "$WORK/downloaded.crt" -w '%{http_code} %{content_type}' "http://$SECOND:$HTTP_PORT/trust/ca.crt")
[ "$download" = "200 application/x-x509-ca-cert" ] || fail "the certificate download answered [$download]"
cmp -s "$WORK/downloaded.crt" "$WORK/tls/ca/root.crt" || fail "the download is not the authority's certificate"

if curl -sS --max-time 8 -o /dev/null "https://$SECOND:$HTTPS_PORT/" 2>/dev/null; then fail "a client that does not trust the authority was accepted"; fi

printf 'ok: https at two addresses, the redirect, the trust page and the refusal of an untrusting client\n'
