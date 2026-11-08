#!/usr/bin/env python3
"""The mail sidecar's account agent: the Settings Email card's counterpart inside the sidecar.

It listens on the instance's private network only (the port is exposed inside the compose
network, never published). It holds no state of its own except short-lived sign-in results;
the accounts themselves live in the one account file in the sidecar's own volume, which the
installer writes through this agent's command line and the Settings card writes through this
agent's HTTP port. The file holds one account block per email account, in the same env shape
the installer has always written, with an optional line naming the default account. The
wrapper restarts the mail server whenever the file changes, and starts it from a config this
agent renders (see --print-config), so this agent never touches Docker.

Security rules, enforced here:
- A password is accepted only in a save request's body or on stdin, is checked before anything
  is stored, and is never written to a log, a response, or an error. Responses carry fixed
  result words only, so a mail server's error text (which can echo credentials) never reaches
  the app.
- Nothing is logged at all: the HTTP server's request log is silenced, and unexpected failures
  print only the exception's type name to stderr, never its text.
- The sign-in check is the installer's own (email_check.py beside this file, run isolated the
  same way), so both paths give the same answer for the same account.
"""

import hashlib
import json
import os
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
DEFAULT_KEY = "AMAN_MAIL_DEFAULT_ACCOUNT"
ADDRESS_KEY = "MCP_EMAIL_SERVER_EMAIL_ADDRESS"
RECHECK_AFTER_SECONDS = 300
MAX_BODY_BYTES = 65536

LOCK = threading.Lock()
# The last sign-in check per account address: {address: {"fingerprint", "at", "result"}}.
# A fingerprint is the hash of that account's own block, so one account changing never
# makes another account look unchecked.
LAST_CHECKS = {}


def parse_account_values(values):
    """One account from a block's key values, or None when the block is not a complete account."""
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


def parse_accounts(text):
    """The accounts in an account file's text, and the default account's address (or None).

    Each account block starts at its address line, the shape the file has always had, so a
    file holding one account reads as a one-entry list with no change. A block that is not
    a complete account is left out rather than hiding the accounts that are complete.
    """
    default_address = None
    blocks = []
    current = None
    for line in text.split("\n"):
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        if len(value) >= 2 and value.startswith("'") and value.endswith("'"):
            value = value[1:-1]
        if key == DEFAULT_KEY:
            default_address = value
            continue
        if key == ADDRESS_KEY:
            current = {}
            blocks.append(current)
        if current is None:
            continue
        current[key] = value
    accounts = []
    for values in blocks:
        account = parse_account_values(values)
        if account is not None:
            accounts.append(account)
    return accounts, default_address


def parse_account(text):
    """The first account in an account file's text, or None when no complete account is there."""
    accounts, _ = parse_accounts(text)
    return accounts[0] if accounts else None


def default_account(accounts, default_address):
    """The account sends go from when none is named: the named default, else the first account."""
    for account in accounts:
        if account["address"] == default_address:
            return account
    return accounts[0] if accounts else None


def account_block_lines(account):
    """One account's lines in the file, without the header."""

    def ssl_flag(mode):
        return "true" if mode == "ssl" else "false"

    def starttls_flag(mode):
        return "true" if mode == "starttls" else "false"

    return [
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


def render_account(account):
    """One account's file text on its own, the same bytes the installer's email_env_text writes."""
    return "\n".join([FILE_HEADER] + account_block_lines(account)) + "\n"


def render_accounts(accounts, default_address):
    """The account file's exact text for a list of accounts.

    A default line is written only when a default was named, so a file the installer wrote
    for one account, and a file holding one account with no named default, keep the bytes
    they have always had.
    """
    if not accounts:
        return ""
    lines = [FILE_HEADER]
    if default_address is not None:
        lines.append(DEFAULT_KEY + "=" + default_address)
    for account in accounts:
        lines.extend(account_block_lines(account))
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


def read_accounts():
    return parse_accounts(read_file_text())


def write_file_text(text):
    """Writes in place, mode 600, flushed to disk. In place keeps the wrapper's watch on the
    same file, and mode 600 keeps the passwords readable only by this sidecar's user."""
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


def block_fingerprint(account):
    return hashlib.sha256("\n".join(account_block_lines(account)).encode("utf-8")).hexdigest()


def checked_result(account):
    """The account's sign-in word, from the kept answer when it is fresh, else a new check."""
    fingerprint = block_fingerprint(account)
    kept = LAST_CHECKS.get(account["address"])
    if kept is not None and kept["fingerprint"] == fingerprint and time.time() - kept["at"] < RECHECK_AFTER_SECONDS:
        return kept["result"]
    result = run_check(account)
    LAST_CHECKS[account["address"]] = {"fingerprint": fingerprint, "at": time.time(), "result": result}
    return result


SIGN_IN_WORDS = {"ok": "ok", "login": "refused", "server": "unreachable"}


def status_body():
    """Status for the card: every saved account (never a password), each with its sign-in state."""
    accounts, default_address = read_accounts()
    if not accounts:
        return {"connected": False, "accounts": [], "default": None}
    entries = []
    for account in accounts:
        body = public_account(account)
        body["sign_in"] = SIGN_IN_WORDS[checked_result(account)]
        entries.append(body)
    chosen = default_account(accounts, default_address)
    return {"connected": True, "accounts": entries, "default": chosen["address"] if chosen else None}


def current_status():
    with LOCK:
        return status_body()


def valid_save_payload(payload):
    """The account a save payload names, or None when the payload is not a complete account."""
    fields = ("provider_key", "address", "password", "imap_host", "smtp_host")
    if not isinstance(payload, dict) or any(not isinstance(payload.get(name), str) or payload[name] == "" for name in fields):
        return None
    for name in ("imap_port", "smtp_port"):
        value = payload.get(name)
        if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 65535:
            return None
    for name in ("imap_mode", "smtp_mode"):
        if payload.get(name) not in ("ssl", "starttls"):
            return None
    return {
        "address": payload["address"],
        "password": payload["password"],
        "imap_host": payload["imap_host"],
        "imap_port": payload["imap_port"],
        "imap_mode": payload["imap_mode"],
        "smtp_host": payload["smtp_host"],
        "smtp_port": payload["smtp_port"],
        "smtp_mode": payload["smtp_mode"],
    }


def save_account(payload):
    """Checks the sign-in first; only a passing account is stored. Returns (status, body).

    Saving an address that is already saved replaces that account and keeps the others;
    a new address is added after them. The first account saved becomes the default by
    being first, until a default is named.
    """
    account = valid_save_payload(payload)
    if account is None:
        return 400, {"error": "invalid"}
    with LOCK:
        result = run_check(account)
        if result == "login":
            return 400, {"error": "sign_in_refused"}
        if result == "server":
            return 400, {"error": "server_unreachable"}
        accounts, default_address = read_accounts()
        replaced = False
        for index, saved in enumerate(accounts):
            if saved["address"] == account["address"]:
                accounts[index] = account
                replaced = True
        if not replaced:
            accounts.append(account)
        write_file_text(render_accounts(accounts, default_address))
        LAST_CHECKS[account["address"]] = {
            "fingerprint": block_fingerprint(account),
            "at": time.time(),
            "result": "ok",
        }
        return 200, status_body()


def remove_account(payload):
    """Removes one account, named by address in the body, or every account when none is named.

    The removed account's password is gone from the file; the others are untouched. A named
    default that is removed stops being named, and the first remaining account takes over.
    """
    address = payload.get("address") if isinstance(payload, dict) else None
    if address is not None and not isinstance(address, str):
        return 400, {"error": "invalid"}
    with LOCK:
        accounts, default_address = read_accounts()
        if address is None:
            kept = []
            removed = accounts
        else:
            kept = [saved for saved in accounts if saved["address"] != address]
            removed = [saved for saved in accounts if saved["address"] == address]
        if default_address is not None and all(saved["address"] != default_address for saved in kept):
            default_address = None
        write_file_text(render_accounts(kept, default_address))
        for saved in removed:
            LAST_CHECKS.pop(saved["address"], None)
        return 200, status_body()


def set_default(payload):
    """Names the default account. The address must be one of the saved accounts."""
    address = payload.get("address") if isinstance(payload, dict) else None
    if not isinstance(address, str) or address == "":
        return 400, {"error": "invalid"}
    with LOCK:
        accounts, _ = read_accounts()
        if all(saved["address"] != address for saved in accounts):
            return 400, {"error": "invalid"}
        write_file_text(render_accounts(accounts, address))
        return 200, status_body()


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

    def _read_payload(self):
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY_BYTES:
            return None
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except (ValueError, UnicodeDecodeError):
            return None

    def _handle(self, method):
        try:
            if not self._host_allowed():
                self._send(403, {"error": "forbidden_host"})
                return
            if self.path == "/account/default" and method == "POST":
                payload = self._read_payload()
                if payload is None:
                    self._send(400, {"error": "invalid"})
                    return
                status, body = set_default(payload)
                self._send(status, body)
                return
            if self.path != "/account":
                self._send(404, {"error": "not_found"})
                return
            if method == "GET":
                self._send(200, current_status())
            elif method == "DELETE":
                length = int(self.headers.get("Content-Length", "0"))
                payload = self._read_payload() if length > 0 else None
                if length > 0 and payload is None:
                    self._send(400, {"error": "invalid"})
                    return
                status, body = remove_account(payload)
                self._send(status, body)
            elif method == "POST":
                payload = self._read_payload()
                if payload is None:
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


def toml_string(value):
    """A TOML string literal holding exactly this value, escapes and all."""
    out = []
    for char in value:
        if char == '"':
            out.append('\\"')
        elif char == "\\":
            out.append("\\\\")
        elif char == "\n":
            out.append("\\n")
        elif char == "\r":
            out.append("\\r")
        elif char == "\t":
            out.append("\\t")
        elif ord(char) < 0x20 or ord(char) == 0x7F:
            out.append("\\u%04X" % ord(char))
        else:
            out.append(char)
    return '"' + "".join(out) + '"'


def config_toml(accounts, default_address):
    """The mail server's own config form for these accounts, as a TOML fragment.

    The server named by the image reads its accounts from a TOML config file: one
    [[emails]] table per account, its account name its email address, with an
    [emails.incoming] and an [emails.outgoing] table under it. The wrapper puts this
    fragment after the send list in the file the server reads, so the accounts and the
    list are read together. The default account comes first.
    """
    chosen = default_account(accounts, default_address)
    ordered = []
    if chosen is not None:
        ordered.append(chosen)
    ordered.extend(saved for saved in accounts if chosen is None or saved["address"] != chosen["address"])
    lines = []
    for account in ordered:
        address = account["address"]
        lines.append("[[emails]]")
        lines.append("account_name = " + toml_string(address))
        lines.append("full_name = " + toml_string(address.split("@")[0] if "@" in address else address))
        lines.append("email_address = " + toml_string(address))
        for table, host, port, mode in (
            ("incoming", account["imap_host"], account["imap_port"], account["imap_mode"]),
            ("outgoing", account["smtp_host"], account["smtp_port"], account["smtp_mode"]),
        ):
            lines.append("[emails.%s]" % table)
            lines.append("user_name = " + toml_string(address))
            lines.append("password = " + toml_string(account["password"]))
            lines.append("host = " + toml_string(host))
            lines.append("port = %d" % port)
            lines.append("use_ssl = %s" % ("true" if mode == "ssl" else "false"))
            lines.append("start_ssl = %s" % ("true" if mode == "starttls" else "false"))
            lines.append("verify_ssl = true")
    if not lines:
        return ""
    return "\n".join(lines) + "\n"


def print_config():
    """Prints the config fragment for the saved accounts, for the wrapper to compose."""
    accounts, default_address = read_accounts()
    sys.stdout.write(config_toml(accounts, default_address))
    return 0


def write_account_stdin():
    """The installer's write path: account text arrives on stdin and is stored.

    Text carrying a default line or several accounts is a whole list and replaces the
    file. A single account with no default line, which is what the installer writes, is
    merged in: an account with the same address is replaced, the others are kept. The
    installer already checked the sign-in before calling, so this only refuses text
    that is empty, too large, or holds no complete account. Prints one fixed word.
    """
    raw = sys.stdin.buffer.read(MAX_BODY_BYTES + 1)
    if len(raw) > MAX_BODY_BYTES:
        sys.stderr.write("mail account agent: refused oversized account text\n")
        return 2
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        sys.stderr.write("mail account agent: refused unreadable account text\n")
        return 2
    incoming, incoming_default = parse_accounts(text)
    if not incoming:
        sys.stderr.write("mail account agent: refused incomplete account text\n")
        return 2
    try:
        if incoming_default is not None or len(incoming) > 1:
            write_file_text(render_accounts(incoming, incoming_default))
        else:
            accounts, default_address = read_accounts()
            account = incoming[0]
            replaced = False
            for index, saved in enumerate(accounts):
                if saved["address"] == account["address"]:
                    accounts[index] = account
                    replaced = True
            if not replaced:
                accounts.append(account)
            write_file_text(render_accounts(accounts, default_address))
    except OSError:
        sys.stderr.write("mail account agent: account write failed (OSError)\n")
        return 1
    sys.stdout.write("saved\n")
    return 0


def remove_account_cli(address):
    """The installer's remove path: one account by address, or every account with no address."""
    try:
        remove_account({"address": address} if address is not None else None)
    except OSError:
        sys.stderr.write("mail account agent: account remove failed (OSError)\n")
        return 1
    sys.stdout.write("removed\n")
    return 0


def main():
    if len(sys.argv) > 1 and sys.argv[1] == "--print-config":
        sys.exit(print_config())
    if len(sys.argv) > 1 and sys.argv[1] == "--write-stdin":
        sys.exit(write_account_stdin())
    if len(sys.argv) > 1 and sys.argv[1] == "--remove":
        sys.exit(remove_account_cli(sys.argv[2] if len(sys.argv) > 2 else None))
    server = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    server.serve_forever()


if __name__ == "__main__":
    main()
