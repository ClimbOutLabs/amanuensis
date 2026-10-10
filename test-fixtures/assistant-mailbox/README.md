# Synthetic test mailbox

Fourteen fictional email messages for testing the assistant with email:
finding things, summarizing, reading attachments, and drafting replies that
wait for approval.

Every name, company, address, phone number, booking code and amount is
invented. Every address uses a reserved example domain (example.com,
example.org, example.net). There is no real personal data here.

See EXPECTATIONS.md for what a useful assistant should do with each message.

## Regenerating

The `.eml` files (with attachments embedded) are produced deterministically by
`generate-fixtures.py`. To regenerate them byte-identically:

    python3 test-fixtures/assistant-mailbox/generate-fixtures.py

The script needs Python 3 and Pillow (`pip install pillow`). No standalone
binary attachments are committed; everything is embedded in the `.eml` files.

## Sending

`scripts/send-test-mailbox.mjs` (run with `pnpm send-test-mailbox`) delivers
the fixtures over SMTP to a test mailbox. Recipient and SMTP settings come
from environment variables or a gitignored `.env.test-mailbox` file and are
never committed. Use `--dry-run` to print what would be sent.
