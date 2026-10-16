# Synthetic test mailbox

Twenty-two fictional email messages for testing the assistant with email:
finding things, summarizing, reading attachments, and drafting replies that
wait for approval. Messages 13 to 20 are everyday mail in other languages
and scripts (Arabic, Hindi, Japanese, Sinhala, Spanish, Simplified Chinese,
Russian, and a mixed English and Persian message), two of them with text
PDF attachments in the message's language.

Every name, company, address, phone number, booking code and amount is
invented. Every address uses a reserved example domain (example.com,
example.org, example.net). There is no real personal data here.

See EXPECTATIONS.md for what a useful assistant should do with each message.

## Regenerating

The `.eml` files (with attachments embedded) are produced deterministically by
`generate-fixtures.mjs`. To regenerate them byte-identically:

    pnpm generate-test-mailbox

The script needs only Node.js and no extra dependencies. No standalone
binary attachments are committed; everything is embedded in the `.eml` files.

## Sending

`scripts/send-test-mailbox.mjs` (run with `pnpm send-test-mailbox`) delivers
the fixtures over SMTP to a test mailbox. Recipient and SMTP settings come
from environment variables or a gitignored `.env.test-mailbox` file and are
never committed (`pnpm test:private-data` fails if that file is ever
tracked). Use `--dry-run` to print what would be sent.
