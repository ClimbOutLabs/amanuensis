#!/usr/bin/env python3
"""The mail sidecar's account agent: the Settings Email card's counterpart inside the sidecar.

It listens on the instance's private network only (the port is exposed inside the compose
network, never published). It holds no state of its own except a short-lived sign-in result;
the account itself lives in the one account file the installer also writes (.env.mail-email,
bind-mounted into this container). The wrapper watches that file and restarts the mail server
with the file's account whenever it changes, so this agent never touches Docker.

Security rules, enforced here:
- The password is accepted only in a save request's body, is checked before anything is
  stored, and is never written to a log, a response, or an error. Responses carry fixed result
  words only, so a mail server's error text (which can echo credentials) never reaches the app.
- Nothing is logged at all: the HTTP server's request log is silenced, and unexpected failures
  print only the exception's type name to stderr, never its text.
- The sign-in check is the installer's own (email_check.py beside this file, run isolated the
  same way), so both paths give the same answer for the same account.
"""

import hashlib
import json
import os
import shlex
import subprocess
import sys
import threading
import time
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
    """Writes in place (a bind-mounted single file cannot be replaced), mode 600, flushed to disk."""
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
    with no account. The file itself stays (it is mounted into this container and must exist)."""
    with LOCK:
        write_file_text("")
        LAST_CHECK.update({"fingerprint": None, "at": 0.0, "result": None})
    return 200, {"connected": False}


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
    change (a restart does not reload the env file; only a recreate does, and the installer
    recreates this container whenever it writes the file itself)."""
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


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--print-child-env":
        print_child_env()
        return
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
