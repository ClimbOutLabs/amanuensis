# shellcheck shell=bash
# The host's report for the app: host-report.json in the data folder the app mounts as /data. The app never runs host
# commands, so the report goes through a short-lived container that mounts that folder. The file is written under a
# temporary name in the same folder and moved into place, so the app never reads half of it.

HOST_REPORT_FILE=host-report.json

# The script the container runs: reads the report from stdin into a temporary file, moves it over the old report and
# removes the temporary file whether or not that worked.
# shellcheck disable=SC2016 # $$, $tmp and $rc expand in the container's shell, not here
HOST_REPORT_WRITE='tmp=/data/.host-report.$$.tmp; cat >"$tmp" && mv -f "$tmp" /data/host-report.json; rc=$?; rm -f "$tmp"; exit $rc'

# json_escape VALUE: sets JSON_ESCAPED to VALUE escaped for use inside a JSON string.
json_escape() {
  local value=$1
  value=${value//\\/\\\\}
  value=${value//\"/\\\"}
  value=${value//$'\n'/\\n}
  value=${value//$'\r'/\\r}
  value=${value//$'\t'/\\t}
  value=${value//[[:cntrl:]]/ }
  JSON_ESCAPED=$value
}

# host_report_time EPOCH: the time as UTC ISO 8601, which is the report's checked_at. GNU and BSD date differ here.
host_report_time() {
  date -u -d "@$1" +%Y-%m-%dT%H:%M:%SZ 2>/dev/null || date -u -r "$1" +%Y-%m-%dT%H:%M:%SZ
}

# host_report_save VOLUME IMAGE JSON: writes the report into VOLUME, which the app mounts as /data. When that fails it
# prints one plain warning and returns 1; the caller's own result does not depend on it.
host_report_save() {
  local volume=$1 image=$2 json=$3 rc=0
  printf '%s\n' "$json" | docker run --rm -i --network none -v "$volume:/data" "$image" sh -c "$HOST_REPORT_WRITE" >/dev/null 2>&1 || rc=$?
  if [ "$rc" != 0 ]; then
    printf 'Aman could not save the latest check result for the app. Run aman doctor again to save it.\n' >&2
    return 1
  fi
}
