import imaplib, ssl, sys
host, port, mode, user, password = sys.stdin.read().split("\n")[:5]
ctx = ssl.create_default_context()
try:
    if mode == "ssl":
        conn = imaplib.IMAP4_SSL(host, int(port), ssl_context=ctx, timeout=20)
    else:
        conn = imaplib.IMAP4(host, int(port), timeout=20)
        conn.starttls(ssl_context=ctx)
except (OSError, ssl.SSLError, imaplib.IMAP4.error, ValueError):
    print("server")
    sys.exit(0)
# imaplib quotes the password itself, so it is passed as it is.
try:
    conn.login(user, password)
except imaplib.IMAP4.error:
    print("login")
    sys.exit(0)
conn.logout()
print("ok")
