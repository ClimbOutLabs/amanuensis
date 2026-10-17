# Synthetic test mailbox

Twenty-six fictional email messages for testing the assistant with email:
finding things, summarizing, reading attachments, and drafting replies that
wait for approval. Messages 13 to 20 are everyday mail in other languages
and scripts (Arabic, Hindi, Japanese, Sinhala, Spanish, Simplified Chinese,
Russian, and a mixed English and Persian message), two of them with text
PDF attachments in the message's language.

Fixtures 03, 04 and 21 to 24 are the demo additions for Maya, who lives in
Lisbon: a Portuguese electricity bill with a PDF, a Portuguese landlord email
with a `.docx` repair notice, a Portuguese class homework email, a bakery
order, a Spanish lunch invitation from a friend in Madrid, and an English
email with a `.docx` photo walk itinerary. All Portuguese text needs a
native-speaker check.

The recipient is Maya Hollis (the persona of the seeded demo world). Fixtures
13 to 20 keep the earlier transliterated name inside their non-Latin text and
PDFs, which are not regenerated for a rename.

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

`demo/scripts/send-test-mailbox.mjs` (run with `pnpm send-test-mailbox`) delivers
the fixtures over SMTP to a test mailbox. Recipient and SMTP settings come
from environment variables or a gitignored `.env.test-mailbox` file and are
never committed (`pnpm test:private-data` fails if that file is ever
tracked). Use `--dry-run` to print what would be sent.

## Demo set

`demo-set.json` lists the 17 fixtures used for the hackathon demo inbox: 12
English, 4 Portuguese and 1 Spanish. Everything else (the school newsletter,
the Spanish internet bill and fixtures 13 to 20 in other languages) stays in
the repo for tests but is not imported. Dates run from Monday October 12 to
Sunday October 18, 2026; amounts are in euros.

### Importing into a throwaway Gmail account

`pnpm demo:import-mailbox` imports the demo set with `users.messages.import`:
each message keeps its Date header as the received time and lands unread in
the inbox, and messages already present (matched by Message-ID) are skipped,
so running it twice is safe. Use `--dry-run` first to list what would be
imported; it needs no credentials and makes no network calls.

Credentials come from environment variables or the gitignored
`.env.test-mailbox`, never the command line:

    TEST_MAILBOX_GMAIL_ACCESS_TOKEN=...      # short-lived token, or the next three:
    TEST_MAILBOX_GMAIL_CLIENT_ID=...
    TEST_MAILBOX_GMAIL_CLIENT_SECRET=...
    TEST_MAILBOX_GMAIL_REFRESH_TOKEN=...
    TEST_MAILBOX_TO=throwaway@example.com      # optional safety check

The scope is `https://www.googleapis.com/auth/gmail.modify`. Importing alone
needs only `gmail.insert`, but the duplicate check searches the mailbox, which
`gmail.insert` does not allow.

To get a token for the throwaway account: in a Google Cloud project, enable the
Gmail API, create an OAuth client (type Desktop app) and add the throwaway
account as a test user on the consent screen. Open Google's OAuth 2.0
Playground (https://developers.google.com/oauthplayground), set its gear
menu to "Use your own OAuth credentials", authorize the scope above while
signed in as the throwaway account, and copy the access token (valid for an
hour) or the refresh token.
