"""A small IMAP server for the email sign-in check: TLS from the start (ssl) or after STARTTLS (starttls).

Usage: fake_imap.py MODE CERT KEY USER PASSWORD PORT_FILE
It accepts one sign-in for USER with PASSWORD exactly as given, writes the password it received to PORT_FILE.login,
and writes its port to PORT_FILE once it listens. It serves connections until it is stopped.
"""

import os
import socket
import ssl
import sys

mode, cert, key, want_user, want_password, port_file = sys.argv[1:7]

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
