"""A small IMAP server for the email sign-in check: TLS from the start (ssl) or after STARTTLS (starttls).

Usage: fake_imap.py MODE CERT KEY USER PASSWORD PORT_FILE [MAILBOX_FILE]
It accepts one sign-in for USER with PASSWORD exactly as given, writes the password it received to PORT_FILE.login,
and writes its port to PORT_FILE once it listens. It serves connections until it is stopped.
With MAILBOX_FILE (JSON, read again at every EXAMINE so a test can change it) it also serves a read-only INBOX:
{"uidvalidity": 1, "messages": [{"uid": 1, "internal_date": "05-Nov-2026 14:55:00 +0000", "header": "From: ...",
"refuse": false, "gone": false}], "fetch_delay_ms": 0, "no_uidnext": false}. With "no_uidnext" EXAMINE gives no
UIDNEXT. A message with "refuse" fails any FETCH of headers that includes
it with NO, as a server that cannot parse it would, while the reply still carries the other messages. A message with
"gone" is found by SEARCH but has no FETCH reply, as one deleted in between. A message with "batch_refuse" is left out of
a FETCH of headers for several messages, which then ends with NO, but is given when asked for alone. Like a real server, a bare set in SEARCH is
message sequence numbers and only the UID key names UIDs; SINCE and UID keys given together must all match, and any
other SEARCH is refused with BAD. Every command after
sign-in is appended to PORT_FILE.commands.
"""

import json
import os
import socket
import ssl
import sys
import time

mode, cert, key, want_user, want_password, port_file = sys.argv[1:7]
mailbox_file = sys.argv[7] if len(sys.argv) > 7 else None
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
ctx.load_cert_chain(cert, key)


def parse_args(text):
    """IMAP atoms and quoted strings, with backslash escapes inside quotes."""
    args, i = [], 0
    while i < len(text):
        if text[i] == " ":
            i += 1
        elif text[i] == '"':
            i += 1
            value = ""
            while text[i] != '"':
                if text[i] == "\\":
                    i += 1
                value += text[i]
                i += 1
            args.append(value)
            i += 1
        else:
            end = text.find(" ", i)
            end = len(text) if end < 0 else end
            args.append(text[i:end])
            i = end
    return args


def load_mailbox():
    with open(mailbox_file) as f:
        box = json.load(f)
    box["messages"].sort(key=lambda item: item["uid"])
    return box


def day_of(internal_date):
    day, month, rest = internal_date.strip().split("-", 2)
    return (int(rest[:4]), MONTHS.index(month) + 1, int(day))


def uid_set(text, uids):
    """The numbers of `uids` in an IMAP set such as 3,5:7 or 9:*, where * is the highest of them (or 0 when empty)."""
    top = max(uids, default=0)
    chosen = set()
    for part in text.split(","):
        low, _, high = part.partition(":")
        low = top if low == "*" else int(low)
        high = low if high == "" else (top if high == "*" else int(high))
        low, high = min(low, high), max(low, high)
        chosen.update(uid for uid in uids if low <= uid <= high)
    return sorted(chosen)


def mailbox_command(conn, tag, command, argtext):
    """EXAMINE, UID SEARCH and UID FETCH over the mailbox file. Anything that would change the mailbox is refused."""
    with open(port_file + ".commands", "a") as f:
        f.write(command + " " + argtext + "\n")
    box = load_mailbox()
    messages = box["messages"]
    uids = [item["uid"] for item in messages]
    if command == "EXAMINE":
        top = max(uids, default=0)
        next_line = "" if box.get("no_uidnext") else "* OK [UIDNEXT %d] ok\r\n" % (top + 1)
        conn.sendall(
            ("* %d EXISTS\r\n* OK [UIDVALIDITY %d] ok\r\n%s%s OK [READ-ONLY] done\r\n"
             % (len(messages), box["uidvalidity"], next_line, tag)).encode()
        )
        return
    sub, _, rest = argtext.partition(" ")
    sub = sub.upper()
    if command == "UID" and sub == "SEARCH":
        words = rest.split()
        found = set(uids)
        if len(words) == 1 and words[0][:1].isdigit():
            # A bare set is message sequence numbers, even under UID SEARCH.
            sequence = uid_set(words[0], list(range(1, len(messages) + 1)))
            found = set(messages[number - 1]["uid"] for number in sequence)
            words = []
        if len(words) % 2 != 0:
            conn.sendall((tag + " BAD unsupported search\r\n").encode())
            return
        # Keys given together must all match, as IMAP ANDs them.
        for key, value in zip(words[0::2], words[1::2]):
            if key.upper() == "SINCE":
                day, month, year = value.split("-")
                floor = (int(year), MONTHS.index(month) + 1, int(day))
                found &= set(item["uid"] for item in messages if day_of(item["internal_date"]) >= floor)
            elif key.upper() == "UID":
                found &= set(uid_set(value, uids))
            else:
                conn.sendall((tag + " BAD unsupported search\r\n").encode())
                return
        found = sorted(found)
        conn.sendall(("* SEARCH %s\r\n%s OK done\r\n" % (" ".join(map(str, found)), tag)).encode())
        return
    if command == "UID" and sub == "FETCH":
        wanted, _, items = rest.partition(" ")
        chosen = [item for item in messages if item["uid"] in uid_set(wanted, uids) and not item.get("gone")]
        headers = "HEADER.FIELDS" in items.upper()
        time.sleep(box.get("fetch_delay_ms", 0) / 1000)
        several = len(chosen) > 1
        left_out = [item for item in chosen if item.get("refuse") or (several and item.get("batch_refuse"))]
        refused = headers and len(left_out) > 0
        out = b""
        for item in chosen:
            if headers and item in left_out:
                continue
            seq = uids.index(item["uid"]) + 1
            line = '* %d FETCH (UID %d INTERNALDATE "%s"' % (seq, item["uid"], item["internal_date"])
            if headers:
                body = (item["header"].replace("\n", "\r\n") + "\r\n\r\n").encode()
                out += (line + " BODY[HEADER.FIELDS (FROM SUBJECT)] {%d}\r\n" % len(body)).encode() + body + b")\r\n"
            else:
                out += (line + ")\r\n").encode()
        ending = " NO some messages could not be fetched\r\n" if refused else " OK done\r\n"
        conn.sendall(out + (tag + ending).encode())
        return
    conn.sendall((tag + " NO read-only\r\n").encode())


def serve(conn):
    reader = conn.makefile("rb")
    conn.sendall(b"* OK [CAPABILITY IMAP4rev1 STARTTLS] ready\r\n")
    while True:
        line = reader.readline()
        if not line:
            return
        tag, _, rest = line.decode().rstrip("\r\n").partition(" ")
        command, _, argtext = rest.partition(" ")
        command = command.upper()
        if command == "CAPABILITY":
            conn.sendall(b"* CAPABILITY IMAP4rev1 STARTTLS AUTH=PLAIN\r\n" + tag.encode() + b" OK done\r\n")
        elif command == "STARTTLS" and mode == "starttls" and not isinstance(conn, ssl.SSLSocket):
            conn.sendall(tag.encode() + b" OK begin TLS\r\n")
            conn = ctx.wrap_socket(conn, server_side=True)
            reader = conn.makefile("rb")
        elif command == "LOGIN":
            user, password = parse_args(argtext)[:2]
            with open(port_file + ".login", "w") as f:
                f.write(password)
            if user == want_user and password == want_password:
                conn.sendall(tag.encode() + b" OK signed in\r\n")
            else:
                conn.sendall(tag.encode() + b" NO [AUTHENTICATIONFAILED] wrong password\r\n")
        elif mailbox_file is not None and command in ("EXAMINE", "SELECT", "UID", "STORE", "FETCH", "EXPUNGE"):
            mailbox_command(conn, tag, command, argtext)
        elif command == "LOGOUT":
            conn.sendall(b"* BYE\r\n" + tag.encode() + b" OK bye\r\n")
            return
        else:
            conn.sendall(tag.encode() + b" BAD unknown\r\n")


listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
listener.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
listener.bind(("127.0.0.1", 0))
listener.listen(5)
with open(port_file + ".tmp", "w") as f:
    f.write(str(listener.getsockname()[1]))
os.replace(port_file + ".tmp", port_file)
while True:
    raw, _ = listener.accept()
    try:
        serve(ctx.wrap_socket(raw, server_side=True) if mode == "ssl" else raw)
    except (OSError, ssl.SSLError):
        pass
    finally:
        raw.close()
