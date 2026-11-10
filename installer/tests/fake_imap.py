"""A small IMAP server for the email sign-in check: TLS from the start (ssl) or after STARTTLS (starttls).

Usage: fake_imap.py MODE CERT KEY USER PASSWORD PORT_FILE [MAILBOX_FILE]
It accepts one sign-in for USER with PASSWORD exactly as given, writes the password it received to PORT_FILE.login,
and writes its port to PORT_FILE once it listens. It serves connections until it is stopped.
With MAILBOX_FILE (JSON, read again at every EXAMINE so a test can change it) it also serves a read-only INBOX:
{"uidvalidity": 1, "messages": [{"uid": 1, "internal_date": "05-Nov-2026 14:55:00 +0000", "header": "From: ...",
"refuse": false}]}. A message with "refuse" fails any FETCH of headers that includes it, as a server that cannot parse
it would. Every command after sign-in is appended to PORT_FILE.commands.
"""

import json
import os
import socket
import ssl
import sys

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
    """The UIDs in an IMAP set such as 3,5:7 or 9:*, where * is the highest UID (or 0 in an empty mailbox)."""
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
        conn.sendall(
            ("* %d EXISTS\r\n* OK [UIDVALIDITY %d] ok\r\n* OK [UIDNEXT %d] ok\r\n%s OK [READ-ONLY] done\r\n"
             % (len(messages), box["uidvalidity"], top + 1, tag)).encode()
        )
        return
    sub, _, rest = argtext.partition(" ")
    sub = sub.upper()
    if command == "UID" and sub == "SEARCH":
        words = rest.split()
        if words[0].upper() == "SINCE":
            day, month, year = words[1].split("-")
            floor = (int(year), MONTHS.index(month) + 1, int(day))
            found = [item["uid"] for item in messages if day_of(item["internal_date"]) >= floor]
        else:
            found = uid_set(words[0], uids)
        conn.sendall(("* SEARCH %s\r\n%s OK done\r\n" % (" ".join(map(str, found)), tag)).encode())
        return
    if command == "UID" and sub == "FETCH":
        wanted, _, items = rest.partition(" ")
        chosen = [item for item in messages if item["uid"] in uid_set(wanted, uids)]
        headers = "HEADER.FIELDS" in items.upper()
        if headers and any(item.get("refuse") for item in chosen):
            conn.sendall((tag + " NO cannot parse a message\r\n").encode())
            return
        out = b""
        for item in chosen:
            seq = uids.index(item["uid"]) + 1
            line = '* %d FETCH (UID %d INTERNALDATE "%s"' % (seq, item["uid"], item["internal_date"])
            if headers:
                body = (item["header"].replace("\n", "\r\n") + "\r\n\r\n").encode()
                out += (line + " BODY[HEADER.FIELDS (FROM SUBJECT)] {%d}\r\n" % len(body)).encode() + body + b")\r\n"
            else:
                out += (line + ")\r\n").encode()
        conn.sendall(out + (tag + " OK done\r\n").encode())
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
