#!/usr/bin/env python3
"""The mail sidecar's account agent: the Settings Email card's counterpart inside the sidecar.

It listens on the instance's private network only (the port is exposed inside the compose
network, never published). It holds no state of its own except a short-lived sign-in result;
the account itself lives in the one account file in the sidecar's own volume, which the
installer writes through this agent's command line and the Settings card writes through this
agent's HTTP port. The wrapper watches that file and restarts the mail server with the file's
account whenever it changes, so this agent never touches Docker.

Security rules, enforced here:
- The password is accepted only in a save request's body, is checked before anything is
  stored, and is never written to a log, a response, or an error. Responses carry fixed result
  words only, so a mail server's error text (which can echo credentials) never reaches the app.
- Nothing is logged at all: the HTTP server's request log is silenced, and unexpected failures
  print only the exception's type name to stderr, never its text.
- The same port lists new mail for the app's noticing, by UIDVALIDITY and UID, and says the inbox's UIDVALIDITY:
  read-only (the mailbox is opened read-only and bodies are never fetched), headers From, Subject, Date and
  Message-ID only, with the same fixed result words.
- The sign-in check is the installer's own (email_check.py beside this file, run isolated the
  same way), so both paths give the same answer for the same account.
"""

import email.parser
import email.policy
import email.utils
import hashlib
import imaplib
import json
import os
import re
import ssl
import shlex
import subprocess
import sys
import threading
import time
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ACCOUNT_FILE = os.environ.get("AMAN_MAIL_ACCOUNT_FILE", "/account/.env.mail-email")
PORT = int(os.environ.get("AMAN_MAIL_ACCOUNT_PORT", "9559"))
ALLOWED_HOST = os.environ.get("AMAN_MAIL_ALLOWED_HOST", "mail-email")
CHECK_FILE = os.environ.get(
    "AMAN_MAIL_EMAIL_CHECK",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), "email_check.py"),
)
FILE_HEADER = "# Written by the installer for the Email connector. Keep it private: it holds the app password."
RECHECK_AFTER_SECONDS = 300
MAX_BODY_BYTES = 65536

LOCK = threading.Lock()
# The last sign-in check for the account now in the file: {"fingerprint", "at", "result"}.
LAST_CHECK = {"fingerprint": None, "at": 0.0, "result": None}


def parse_account(text):
    """The account in an account file's text, or None when no complete account is there."""
    values = {}
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if len(value) >= 2 and value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        values[key] = value
    address = values.get("MCP_EMAIL_SERVER_EMAIL_ADDRESS", "")
    password = values.get("MCP_EMAIL_SERVER_PASSWORD", "")
    imap_host = values.get("MCP_EMAIL_SERVER_IMAP_HOST", "")
    smtp_host = values.get("MCP_EMAIL_SERVER_SMTP_HOST", "")
    imap_port = values.get("MCP_EMAIL_SERVER_IMAP_PORT", "")
    smtp_port = values.get("MCP_EMAIL_SERVER_SMTP_PORT", "")
    if not address or not password or not imap_host or not smtp_host:
        return None
    if not (imap_port.isdigit() and smtp_port.isdigit()):
        return None
    return {
        "address": address,
        "password": password,
        "imap_host": imap_host,
        "imap_port": int(imap_port),
        "imap_mode": "ssl" if values.get("MCP_EMAIL_SERVER_IMAP_SSL") == "true" else "starttls",
        "smtp_host": smtp_host,
        "smtp_port": int(smtp_port),
        "smtp_mode": "ssl" if values.get("MCP_EMAIL_SERVER_SMTP_SSL") == "true" else "starttls",
    }


def render_account(account):
    """The account file's exact text, the same bytes the installer's email_env_text writes."""

    def ssl_flag(mode):
        return "true" if mode == "ssl" else "false"

    def starttls_flag(mode):
        return "true" if mode == "starttls" else "false"

    lines = [
        FILE_HEADER,
        "MCP_EMAIL_SERVER_EMAIL_ADDRESS=" + account["address"],
        "MCP_EMAIL_SERVER_PASSWORD='" + account["password"] + "'",
        "MCP_EMAIL_SERVER_IMAP_HOST=" + account["imap_host"],
        "MCP_EMAIL_SERVER_IMAP_PORT=" + str(account["imap_port"]),
        "MCP_EMAIL_SERVER_IMAP_SSL=" + ssl_flag(account["imap_mode"]),
        "MCP_EMAIL_SERVER_IMAP_START_SSL=" + starttls_flag(account["imap_mode"]),
        "MCP_EMAIL_SERVER_IMAP_VERIFY_SSL=true",
        "MCP_EMAIL_SERVER_SMTP_HOST=" + account["smtp_host"],
        "MCP_EMAIL_SERVER_SMTP_PORT=" + str(account["smtp_port"]),
        "MCP_EMAIL_SERVER_SMTP_SSL=" + ssl_flag(account["smtp_mode"]),
        "MCP_EMAIL_SERVER_SMTP_START_SSL=" + starttls_flag(account["smtp_mode"]),
        "MCP_EMAIL_SERVER_SMTP_VERIFY_SSL=true",
    ]
    return "\n".join(lines) + "\n"


def public_account(account):
    """The account as responses may carry it: everything but the password."""
    return {
        "address": account["address"],
        "imap_host": account["imap_host"],
        "imap_port": account["imap_port"],
        "imap_mode": account["imap_mode"],
        "smtp_host": account["smtp_host"],
        "smtp_port": account["smtp_port"],
        "smtp_mode": account["smtp_mode"],
    }


def read_file_text():
    try:
        with open(ACCOUNT_FILE, "r", encoding="utf-8") as handle:
            return handle.read()
    except OSError:
        return ""


def read_account():
    return parse_account(read_file_text())


def write_file_text(text):
    """Writes in place, mode 600, flushed to disk. In place keeps the wrapper's watch on the
    same file, and mode 600 keeps the password readable only by this sidecar's user."""
    fd = os.open(ACCOUNT_FILE, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.fchmod(fd, 0o600)
        os.write(fd, text.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)


def run_check(account):
    """The installer's sign-in check, run isolated with the five lines on stdin. Returns ok/login/server."""
    feed = "\n".join(
        [
            account["imap_host"],
            str(account["imap_port"]),
            account["imap_mode"],
            account["address"],
            account["password"],
        ]
    )
    try:
        done = subprocess.run(
            [sys.executable, "-I", CHECK_FILE],
            input=feed,
            capture_output=True,
            text=True,
            timeout=40,
            cwd="/",
        )
    except (OSError, subprocess.TimeoutExpired):
        return "server"
    word = done.stdout.strip()
    return word if word in ("ok", "login", "server") else "server"


def current_status():
    """Status for the card: the saved account (never the password) and its sign-in state."""
    with LOCK:
        account = read_account()
        if account is None:
            return {"connected": False}
        fingerprint = hashlib.sha256(read_file_text().encode("utf-8")).hexdigest()
        fresh = (
            LAST_CHECK["fingerprint"] == fingerprint
            and LAST_CHECK["result"] is not None
            and time.time() - LAST_CHECK["at"] < RECHECK_AFTER_SECONDS
        )
        if not fresh:
            result = run_check(account)
            LAST_CHECK.update({"fingerprint": fingerprint, "at": time.time(), "result": result})
        sign_in = {"ok": "ok", "login": "refused", "server": "unreachable"}[LAST_CHECK["result"]]
        body = public_account(account)
        body["connected"] = True
        body["sign_in"] = sign_in
        return body


def save_account(payload):
    """Checks the sign-in first; only a passing account is written. Returns (status, body)."""
    fields = ("provider_key", "address", "password", "imap_host", "smtp_host")
    if not isinstance(payload, dict) or any(not isinstance(payload.get(name), str) or payload[name] == "" for name in fields):
        return 400, {"error": "invalid"}
    for name in ("imap_port", "smtp_port"):
        value = payload.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 65535:
            return 400, {"error": "invalid"}
    for name in ("imap_mode", "smtp_mode"):
        if payload.get(name) not in ("ssl", "starttls"):
            return 400, {"error": "invalid"}
    account = {
        "address": payload["address"],
        "password": payload["password"],
        "imap_host": payload["imap_host"],
        "imap_port": payload["imap_port"],
        "imap_mode": payload["imap_mode"],
        "smtp_host": payload["smtp_host"],
        "smtp_port": payload["smtp_port"],
        "smtp_mode": payload["smtp_mode"],
    }
    with LOCK:
        result = run_check(account)
        if result == "login":
            return 400, {"error": "sign_in_refused"}
        if result == "server":
            return 400, {"error": "server_unreachable"}
        write_file_text(render_account(account))
        fingerprint = hashlib.sha256(read_file_text().encode("utf-8")).hexdigest()
        LAST_CHECK.update({"fingerprint": fingerprint, "at": time.time(), "result": "ok"})
    body = public_account(account)
    body["connected"] = True
    body["sign_in"] = "ok"
    return 200, body


def remove_account():
    """Empties the account file: the password is gone, and the wrapper restarts the mail server
    with no account. The file itself stays in the volume; empty means no account is connected."""
    with LOCK:
        write_file_text("")
        LAST_CHECK.update({"fingerprint": None, "at": 0.0, "result": None})
    return 200, {"connected": False}


MOST_LISTED_PER_CALL = 500
# The app gives up on a list after 75 seconds. Work stops starting new round trips after this long, so an answer
# usually comes well before that. The first of each step is made whatever the time and may take up to the IMAP timeout,
# so a server slow at every step can still run past it; that pass is then too slow and the next one tries again.
LIST_WORK_SECONDS = float(os.environ.get("AMAN_MAIL_LIST_SECONDS", "35"))
IMAP_TIMEOUT_SECONDS = 20
CANDIDATES_PER_FETCH = 200
MONTHS = ("Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec")
INTERNAL_DATE = re.compile(rb'INTERNALDATE "([^"]+)"')
INTERNAL_DATE_PARTS = re.compile(r"(\d{1,2})-([A-Za-z]{3})-(\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-])(\d{2})(\d{2})$")
FETCHED_UID = re.compile(rb"\bUID (\d+)")


def open_imap(account):
    """A logged-in IMAP connection to the saved account, or the word for why it could not be made."""
    context = ssl.create_default_context()
    try:
        if account["imap_mode"] == "ssl":
            conn = imaplib.IMAP4_SSL(account["imap_host"], account["imap_port"], ssl_context=context, timeout=IMAP_TIMEOUT_SECONDS)
        else:
            conn = imaplib.IMAP4(account["imap_host"], account["imap_port"], timeout=IMAP_TIMEOUT_SECONDS)
            conn.starttls(ssl_context=context)
    except (OSError, ssl.SSLError, imaplib.IMAP4.error, ValueError):
        return None, "unavailable"
    try:
        conn.login(account["address"], account["password"])
    except imaplib.IMAP4.error:
        return None, "login_failed"
    return conn, None


def parse_instant(text):
    """An ISO 8601 time as a UTC datetime, or None."""
    try:
        value = datetime.fromisoformat(text.replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return None
    return value if value.tzinfo else value.replace(tzinfo=timezone.utc)


def fetched_items(data):
    """The (metadata, header bytes) pairs of a FETCH reply. Anything else in the reply is not a message."""
    return [item for item in data if isinstance(item, tuple) and len(item) >= 2]


def arrival_of(raw):
    """INTERNALDATE of a FETCH reply's metadata line as a UTC datetime, or None. It is read here rather than with
    imaplib's helper, which gives local time."""
    date = INTERNAL_DATE.search(raw)
    if date is None:
        return None
    parts = INTERNAL_DATE_PARTS.match(date.group(1).decode("ascii", "replace").strip())
    if parts is None or parts.group(2).title() not in MONTHS:
        return None
    day, month, year, hour, minute, second, sign, zone_hours, zone_minutes = parts.groups()
    try:
        local = datetime(int(year), MONTHS.index(month.title()) + 1, int(day), int(hour), int(minute), int(second))
    except ValueError:
        return None
    offset = timedelta(hours=int(zone_hours), minutes=int(zone_minutes))
    return (local - offset if sign == "+" else local + offset).replace(tzinfo=timezone.utc)


def internal_dates(conn, uids, out_of_time):
    """INTERNALDATE of each UID the server still has, and how many of `uids` were looked at. It stops between
    chunks once the time is up, but always looks at the first chunk, so every call gets somewhere."""
    found = {}
    looked = 0
    for start in range(0, len(uids), CANDIDATES_PER_FETCH):
        if start > 0 and out_of_time():
            break
        chunk = uids[start : start + CANDIDATES_PER_FETCH]
        kind, data = conn.uid("FETCH", ",".join(str(uid) for uid in chunk), "(INTERNALDATE)")
        if kind != "OK":
            raise imaplib.IMAP4.error("fetch")
        for item in data:
            raw = item[0] if isinstance(item, tuple) else item
            uid = FETCHED_UID.search(raw) if isinstance(raw, bytes) else None
            arrived = arrival_of(raw) if uid else None
            if uid and arrived:
                found[int(uid.group(1))] = arrived
        looked = start + len(chunk)
    return found, looked


def search_uids(conn, *criteria):
    """The UIDs a UID SEARCH gives, sorted."""
    kind, data = conn.uid("SEARCH", None, *criteria)
    if kind != "OK":
        raise imaplib.IMAP4.error("search")
    return sorted(int(part) for part in (data[0] or b"").split())


def list_after(conn, payload, out_of_time=lambda: False):
    """Mail after a cursor, in UID order, read-only. With no cursor, or a cursor from another UIDVALIDITY, it starts
    at the first message that arrived at or after `since`: every message already in the mailbox is dated, and the
    rest are new. Those dated UIDs and their time come back in `dated_to_uid` and `dated_since`, which the next call
    passes back, so mail still to be dated is held to the same time. A message whose headers cannot be read is
    counted in `skipped` and the cursor moves past it, so one bad message never holds up the others. A message
    deleted while it was being listed is simply gone, not skipped. Once the time is up it answers with what it got
    through and `more`."""
    kind, _ = conn.select("INBOX", readonly=True)
    if kind != "OK":
        raise imaplib.IMAP4.error("select")
    validity = int(conn.response("UIDVALIDITY")[1][0])
    next_data = conn.response("UIDNEXT")[1]
    limit = max(1, min(int(payload["limit"]), MOST_LISTED_PER_CALL))
    cursor_valid = payload.get("last_uid") is not None and payload.get("uidvalidity") == validity
    if cursor_valid:
        last = int(payload["last_uid"])
        dated_to = payload.get("dated_to_uid")
        dated_since = parse_instant(payload["dated_since"]) if dated_to is not None else None
        if dated_to is not None and dated_since is None:
            raise ValueError("dated_since")
    else:
        # Every message in the mailbox now is dated; one that arrives from here on gets a higher UID and is new.
        last = 0
        if next_data and next_data[0]:
            dated_to = int(next_data[0]) - 1
        else:
            # A server that gives no UIDNEXT still says its highest UID: "*" is the last message.
            top = search_uids(conn, "UID", "*")
            dated_to = top[-1] if top else 0
        dated_since = parse_instant(payload["since"])
        if dated_since is None:
            raise ValueError("since")
    dated_to = int(dated_to) if dated_to is not None and int(dated_to) > last else None
    # How far the dated UIDs were looked at when the time ran out, so the older ones are not asked again.
    looked_to = None
    if dated_to is None:
        # The UID key names UIDs; a bare set in SEARCH would be message sequence numbers.
        candidates = [uid for uid in search_uids(conn, "UID", "%d:*" % (last + 1)) if uid > last]
    else:
        start = dated_since - timedelta(days=1)
        # IMAP dates name the month in English whatever the locale, and SINCE goes by whole days, so a day earlier is asked.
        day = "%d-%s-%d" % (start.day, MONTHS[start.month - 1], start.year)
        listed = [
            uid
            for uid in search_uids(conn, "UID", "%d:%d" % (last + 1, dated_to), "SINCE", day)
            if last < uid <= dated_to
        ]
        dates, looked = internal_dates(conn, listed, out_of_time)
        if looked < len(listed):
            looked_to = listed[looked - 1]
            listed = listed[:looked]
        candidates = [uid for uid in listed if uid in dates and dates[uid] >= dated_since]
        if looked_to is None:
            candidates += [uid for uid in search_uids(conn, "UID", "%d:*" % (dated_to + 1)) if uid > dated_to]
    batch = candidates[:limit]
    more = len(candidates) > limit or looked_to is not None
    items, refused, handled = fetch_headers(conn, batch, out_of_time)
    if handled < len(batch):
        batch = batch[:handled]
        more = True
    wanted = set(batch)
    found = {}
    unreadable = set(uid for uid in refused if uid in wanted)
    for item in items:
        message = message_of(item)
        uid = uid_of(item)
        if uid is None or uid not in wanted or uid in found:
            continue
        if message is None:
            unreadable.add(uid)
        else:
            found[uid] = message
    messages = [found[uid] for uid in batch if uid in found]
    if len(batch) < len(candidates):
        last_uid = batch[-1] if batch else last
    elif looked_to is not None:
        last_uid = max([last, looked_to] + batch)
    else:
        # Every candidate was read, so the dated UIDs with none left are behind the cursor too.
        last_uid = max([last, dated_to or 0] + batch)
    # The dated UIDs are given back even once all are behind the cursor, since a pass that stops at an earlier
    # message moves the cursor back below them.
    return {
        "uidvalidity": validity,
        "last_uid": last_uid,
        "dated_to_uid": dated_to,
        "dated_since": dated_since.isoformat().replace("+00:00", "Z") if dated_to is not None else None,
        "more": more,
        "skipped": len(unreadable - set(found)),
        "messages": messages,
    }


HEADER_ITEMS = "(INTERNALDATE BODY.PEEK[HEADER.FIELDS (FROM SUBJECT DATE MESSAGE-ID)])"


def uid_of(item):
    """The UID a FETCH item is for, or None."""
    raw = item[0] if isinstance(item, tuple) else item
    found = FETCHED_UID.search(raw) if isinstance(raw, bytes) else None
    return int(found.group(1)) if found else None


def fetch_headers(conn, uids, out_of_time):
    """The FETCH items for `uids`, the UIDs the server refused alone, and how many of `uids` (from the start) were
    dealt with. A server that refuses a batch may still answer for some of it: those items are kept and only the
    missing UIDs are asked for one by one, so one message it cannot give costs only that message. The one-by-one
    asks stop once the time is up, after at least one, so every call gets somewhere."""
    if not uids:
        return [], set(), 0
    kind, data = conn.uid("FETCH", ",".join(str(uid) for uid in uids), HEADER_ITEMS)
    if kind == "OK":
        return fetched_items(data), set(), len(uids)
    # imaplib leaves the FETCH lines of a refused command among the untagged responses.
    items = fetched_items(conn.response("FETCH")[1] or [])
    answered = set(uid_of(item) for item in items)
    refused = set()
    asked = 0
    for index, uid in enumerate(uids):
        if uid in answered:
            continue
        if asked > 0 and out_of_time():
            return items, refused, index
        asked += 1
        kind, data = conn.uid("FETCH", str(uid), HEADER_ITEMS)
        if kind == "OK":
            # An OK with nothing in it is a message deleted meanwhile.
            items.extend(fetched_items(data))
        else:
            conn.response("FETCH")
            refused.add(uid)
    return items, refused, len(uids)


def raw_header(block, name):
    """A header's value as sent, unfolded and stripped, or None. The first header of that name wins. Parsing would
    cut down odd values, and two different values must not read as one."""
    text = re.sub(r"\r?\n[ \t]+", " ", block.decode("utf-8", "replace"))
    prefix = name.lower() + ":"
    for line in text.splitlines():
        if line.lower().startswith(prefix):
            return line[len(prefix) :].strip() or None
    return None


def message_of(item):
    """One listed message from a FETCH item, or None when its UID, arrival or sender does not read."""
    parser = email.parser.BytesHeaderParser(policy=email.policy.default)
    try:
        raw = item[0]
        uid = int(FETCHED_UID.search(raw).group(1))
        arrived = arrival_of(raw)
        if arrived is None:
            return None
        headers = parser.parsebytes(item[1])
        name, address = email.utils.parseaddr(str(headers["From"] or ""))
        if not address or "@" not in address:
            return None
        return {
            "uid": uid,
            "internal_date": arrived.isoformat().replace("+00:00", "Z"),
            "from_address": address,
            "from_name": name or None,
            "subject": str(headers["Subject"] or ""),
            "message_id": raw_header(item[1], "Message-ID"),
            "date": raw_header(item[1], "Date"),
        }
    except Exception:
        return None


def mailbox_validity(conn):
    """The inbox's UIDVALIDITY now, read-only, so the app can tell whether a UID it kept still names the same message."""
    kind, _ = conn.select("INBOX", readonly=True)
    if kind != "OK":
        raise imaplib.IMAP4.error("select")
    return {"uidvalidity": int(conn.response("UIDVALIDITY")[1][0])}


def with_imap(work):
    """Runs `work` on a signed-in connection: (HTTP status, body), with fixed words for every failure."""
    account = read_account()
    if account is None:
        return 409, {"error": "no_account"}
    conn, word = open_imap(account)
    if conn is None:
        return 502, {"error": word}
    try:
        return 200, work(conn)
    except (imaplib.IMAP4.error, OSError, ssl.SSLError):
        return 502, {"error": "unavailable"}
    except (KeyError, TypeError, ValueError):
        return 400, {"error": "invalid"}
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def handle_list_after(payload):
    """A list-after request: (HTTP status, body). Fixed words for every failure; the mail server's text can echo credentials.
    The work stops starting round trips once its time is up, so the answer usually comes inside the app's own limit."""
    deadline = time.monotonic() + LIST_WORK_SECONDS

    def out_of_time():
        return time.monotonic() >= deadline

    return with_imap(lambda conn: list_after(conn, payload, out_of_time))


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format, *args):
        pass

    def _host_allowed(self):
        host = self.headers.get("Host", "")
        name = host.split(":")[0].strip().lower()
        return name in (ALLOWED_HOST, "localhost", "127.0.0.1")

    def _send(self, status, body):
        data = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _handle(self, method):
        try:
            if not self._host_allowed():
                self._send(403, {"error": "forbidden_host"})
                return
            if self.path == "/list_after" and method == "POST":
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    self._send(400, {"error": "invalid"})
                    return
                try:
                    payload = json.loads(self.rfile.read(length).decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "invalid"})
                    return
                status, body = handle_list_after(payload)
                self._send(status, body)
                return
            if self.path == "/mailbox" and method == "GET":
                status, body = with_imap(mailbox_validity)
                self._send(status, body)
                return
            if self.path != "/account":
                self._send(404, {"error": "not_found"})
                return
            if method == "GET":
                self._send(200, current_status())
            elif method == "DELETE":
                status, body = remove_account()
                self._send(status, body)
            elif method == "POST":
                length = int(self.headers.get("Content-Length", "0"))
                if length <= 0 or length > MAX_BODY_BYTES:
                    self._send(400, {"error": "invalid"})
                    return
                raw = self.rfile.read(length)
                try:
                    payload = json.loads(raw.decode("utf-8"))
                except (ValueError, UnicodeDecodeError):
                    self._send(400, {"error": "invalid"})
                    return
                status, body = save_account(payload)
                self._send(status, body)
            else:
                self._send(405, {"error": "method_not_allowed"})
        except Exception as caught:  # Fixed words only: exception text can carry credentials.
            sys.stderr.write("mail account agent: request failed (%s)\n" % type(caught).__name__)
            try:
                self._send(500, {"error": "internal"})
            except Exception:
                pass

    def do_GET(self):
        self._handle("GET")

    def do_POST(self):
        self._handle("POST")

    def do_DELETE(self):
        self._handle("DELETE")


ACCOUNT_KEYS = [
    "MCP_EMAIL_SERVER_EMAIL_ADDRESS",
    "MCP_EMAIL_SERVER_PASSWORD",
    "MCP_EMAIL_SERVER_IMAP_HOST",
    "MCP_EMAIL_SERVER_IMAP_PORT",
    "MCP_EMAIL_SERVER_IMAP_SSL",
    "MCP_EMAIL_SERVER_IMAP_START_SSL",
    "MCP_EMAIL_SERVER_IMAP_VERIFY_SSL",
    "MCP_EMAIL_SERVER_SMTP_HOST",
    "MCP_EMAIL_SERVER_SMTP_PORT",
    "MCP_EMAIL_SERVER_SMTP_SSL",
    "MCP_EMAIL_SERVER_SMTP_START_SSL",
    "MCP_EMAIL_SERVER_SMTP_VERIFY_SSL",
]


def print_child_env():
    """Shell lines that put the wrapper's shell in the account file's state, for starting the
    mail server: exports of the saved account, or unsets when no account is saved. The account
    file is the one record: the mail server is always started from it, never from the
    container's starting environment, which can hold an older account from before a Settings
    change (a restart does not reload the env file; the installer writes the file through this
    agent instead, and the wrapper restarts the server when the file changes)."""
    account = read_account()
    if account is None:
        sys.stdout.write("unset %s\n" % " ".join(ACCOUNT_KEYS))
        return
    pairs = [
        ("MCP_EMAIL_SERVER_EMAIL_ADDRESS", account["address"]),
        ("MCP_EMAIL_SERVER_PASSWORD", account["password"]),
        ("MCP_EMAIL_SERVER_IMAP_HOST", account["imap_host"]),
        ("MCP_EMAIL_SERVER_IMAP_PORT", str(account["imap_port"])),
        ("MCP_EMAIL_SERVER_IMAP_SSL", "true" if account["imap_mode"] == "ssl" else "false"),
        ("MCP_EMAIL_SERVER_IMAP_START_SSL", "true" if account["imap_mode"] == "starttls" else "false"),
        ("MCP_EMAIL_SERVER_IMAP_VERIFY_SSL", "true"),
        ("MCP_EMAIL_SERVER_SMTP_HOST", account["smtp_host"]),
        ("MCP_EMAIL_SERVER_SMTP_PORT", str(account["smtp_port"])),
        ("MCP_EMAIL_SERVER_SMTP_SSL", "true" if account["smtp_mode"] == "ssl" else "false"),
        ("MCP_EMAIL_SERVER_SMTP_START_SSL", "true" if account["smtp_mode"] == "starttls" else "false"),
        ("MCP_EMAIL_SERVER_SMTP_VERIFY_SSL", "true"),
    ]
    for key, value in pairs:
        sys.stdout.write("export %s=%s\n" % (key, shlex.quote(value)))


def write_account_stdin():
    """The installer's write path: the account file's exact text arrives on stdin and is
    stored as-is. The installer already checked the sign-in before calling, so this only
    refuses text that is empty, too large, or not a complete account. Prints one fixed word."""
    raw = sys.stdin.buffer.read(MAX_BODY_BYTES + 1)
    if len(raw) > MAX_BODY_BYTES:
        sys.stderr.write("mail account agent: refused oversized account text\n")
        return 2
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        sys.stderr.write("mail account agent: refused unreadable account text\n")
        return 2
    if text == "" or parse_account(text) is None:
        sys.stderr.write("mail account agent: refused incomplete account text\n")
        return 2
    try:
        write_file_text(text)
    except OSError:
        sys.stderr.write("mail account agent: account write failed (OSError)\n")
        return 1
    sys.stdout.write("saved\n")
    return 0


def remove_account_cli():
    """The installer's remove path: empties the account file the same way the HTTP remove does."""
    try:
        remove_account()
    except OSError:
        sys.stderr.write("mail account agent: account remove failed (OSError)\n")
        return 1
    sys.stdout.write("removed\n")
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--print-child-env":
        print_child_env()
        return
    if len(sys.argv) > 1 and sys.argv[1] == "--write-stdin":
        sys.exit(write_account_stdin())
    if len(sys.argv) > 1 and sys.argv[1] == "--remove":
        sys.exit(remove_account_cli())
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
