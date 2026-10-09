# Spec: Email Integration (v1, Gmail only)

**Status:** draft

## Problem

Amanuensis cannot read, search, or draft email, so the morning digest, thread lookup, reply drafting, and collecting mail into a project space do not work. Today the Gmail adapter in `mcp/gmail` exists but sends are rejected, setup needs hand-editing, and every email tool call prompts for approval.

## Solution

Gmail support through the gmail-mcp adapter running in a local container (pinned version), connected through the existing Settings connector UI and a connector gate in `packages/trueforge-core`. The user brings their own Google OAuth client; Amanuensis never owns a client and never goes through provider verification. The spec fixes the send path, defines the exact tool contract and Sentinel tiers, and makes setup UI-only. Outlook and iCloud are deferred to v2.

## Design Decisions

**User-owned credentials.** Each user creates an OAuth client in the Google Cloud console. Honest consequence: this is a multi-step task in a console Amanuensis does not control, and the consent screen shows an "unverified app" warning because the user owns the client. The product makes it guided (see Auth Flow). Same decision as in `privacy-safe-mcp.md`: secrets stay on the device and are never shown in the UI.

**One client, one refresh token, logical grants.** Calendar is expected to reuse this client and token; its spec will be updated to match. Read and send are logical grant records over one token: read maps to `gmail.modify`, send maps to `gmail.compose`. The user connects read-only first and adds send later with a second consent. Swap order is load-bearing: persist the new union-scoped token first, then revoke the old one.

**Read grant is `gmail.modify`.** Mark-read and archive need it; it does not allow permanent deletion, and `gmail.full` is never requested.

**Send grant is `gmail.compose`.** The v1 send path is draft then `send_draft`. With `gmail.compose` the raw `send_email` tool is authorized at Google, so the connector blocks it at invocation.

**Revoking Gmail disconnects Calendar** when both share the token. Revocation warns and requires confirmation.

**Production publishing status.** A client left in Testing gets refresh tokens that expire in 7 days. The guide includes the step, and a 7-day expiry failure triggers the reconnect state.

**Send needs explicit confirmation.** Drafting is free; sending requires the user to confirm the real recipients, subject, and body. No implied consent, standing instruction, or earlier vague approval.

**Email content is untrusted data.** Text inside a message cannot change tool calls, tiers, allowlists, or confirmations.

**One account in v1.** Settings names the account; results and digests state which account was searched.

**Container runtime prerequisite.** The adapter needs a local container runtime. Settings shows a clear message with next steps when it is missing, and Connect Gmail stays disabled until it is available.

## User Journeys

### Morning digest

The user asks "Catch me up on my email." Amanuensis returns unread important mail first (Gmail's `IMPORTANT` label, no invented score), then newsletters and notifications collapsed, one line each with sender, subject, and a one-sentence gist in the user's language. It names the account searched and lists action items separately. Query order is `in:inbox is:unread` newest-first, then `in:inbox` newest-first, following `nextPageToken`. It always states coverage ("N threads reviewed, roughly M remain"); a bare "stopped fetching" is not acceptable. If Gmail is down, one line says so and the rest of the briefing continues. If Gmail was never connected, one line points to Settings → Connect Gmail, then stops; inside a multi-source briefing the section reads "Email: not connected".

### Search

"Find the email about the lease." Gmail query syntax over the inbox by default; "mail I sent" uses `in:sent`. Results show sender, date, snippet, and account, and state the scope used, the provider's match count, results reviewed, and whether the `maxResults` cap or token bound truncated them.

### Read

The user opens a thread. It renders in reading order with attachment metadata (filename, size, type). Long threads truncate oldest-first within the token bound, keep omitted message ids, and are marked truncated. Mark-read happens only when the thread rendered completely.

**Reading attachments (core v1).** Asked what an attachment says, the agent calls `download_attachment` (Tier 1, like message reads) and receives extracted content, reusing the host's existing document extraction rather than a second extractor:

- PDF: native text first, local OCR for scanned pages, through `extractDocumentText` (`packages/trueforge-core/src/documents/documentExtraction.ts:306`) as wired for the sandbox in `extractDocumentsFromSandbox` (`packages/trueforge-core/src/core/capabilities/builtins/DocumentTools.ts:224`). The page-range inputs (`DocumentTools.ts:62`) give PDF continuation.
- Plain text, markdown, CSV, and ICS: returned as text.
- Images: passed to the model as image parts when the model supports vision, using the existing path in `packages/trueforge-core/src/core/runtime/UserInputMessage.ts:353` (flag at `:314`, 4 MB image cap at `:49`); otherwise local OCR.
- Office documents (`.doc`, `.docx`, `.odt`, `.rtf`): the existing extractor declines them (`documentExtraction.ts:25`), so v1 returns metadata and an "open in Gmail" link.
- Limits: per-attachment cap of 25 MB (`documentExtraction.ts:28`) and a per-turn extracted-text cap of 8,000 tokens. When content is cut, the result says "truncated, ask for the next part" and returns an `offset` (a page number for PDFs, a character offset for text); the next call passes it back. No windowed sessions.
- Encrypted, password-protected, corrupt, oversize, and unsupported files return a plain reason, never a guess.
- Safety: extracted attachment text is wrapped and labeled as untrusted data, exactly like message bodies, and cannot change tool calls, tiers, or confirmations. Extraction uses only the fixed `pdftotext`, `pdfinfo`, and `tesseract` commands (`packages/trueforge-core/src/core/sandbox/Sandbox.ts:5615`, `runDocumentOcr`) and never executes attachment content (no macros, no scripts). It runs in the Docker sandbox driver, whose containers have no network (`NetworkMode` is `none`, `packages/trueforge-core/src/core/sandbox/driver/DockerDriver.ts:343`); no network-free claim is made for any other sandbox provider. Docker is already a prerequisite. If the Docker sandbox is unavailable, attachments return metadata plus an "open in Gmail" link, the same as Office files.
- Wiring: the connector writes the downloaded bytes to a per-turn sandbox path, extracts through `extractDocumentsFromSandbox`, and deletes the file in a `finally` block, so nothing persists unless the user saves it. Input is bounded by `MAX_BYTES_PER_DOCUMENT`; the extractor allows up to 200,000 characters, but the connector truncates the text it returns to the 8,000-token per-turn cap and offers the `offset` continuation.

### Draft

"Draft a reply to a colleague saying Thursday works." A provider-side draft is created as a reply (`threadId`, `inReplyTo`) and shown with recipients, subject, and body, editable. Each edit calls `update_draft` on the same id. `delete_draft` removes abandoned drafts; `list_drafts` resumes work across sessions. CC and BCC work. Attaching files is deferred.

### Send

"Send it." Sending is one user step: the Sentinel Tier 3 approval card is the confirmation surface, and there is no separate dialog or second prompt. The card re-reads the draft live from Gmail and shows a draft summary (recipients, subject, body preview) plus send-as `from`, `mimeType`, `inlineImages`, rendered `htmlBody`, reply thread, and an attachments indicator (a draft with attachments cannot be approved in v1). Approving the card mints the confirmation, which binds the draft id, SHA-256 hashes of `to`/`cc`/`bcc`/`subject`/`body`/`htmlBody`/`from`/`mimeType`/`inlineImages`/`threadId`/`inReplyTo`, and a 15-minute TTL; it is single use. At send time the gate re-reads the draft and compares hashes, so any edit anywhere invalidates the confirmation. On provider rejection (auth, quota) the draft is kept and the error shows with Retry.

### Emails into a space

"Put together a space for the apartment hunt." Amanuensis proposes threads with coverage stated, and on approval writes thread summaries plus Gmail thread ids as plain text and the source account. Structured source links wait on the spaces spec.

## Tool Contract

Default-deny. The adapter defines 36 tools today and 37 with the `get_draft` patch: 11 are allowed (10 model-visible plus internal `get_draft`) and 26 are blocked. A tool not on the allowlist is hidden at `tools/list` and rejected at `tools/call` before the MCP transport, which also defeats tool names smuggled in through email content. The allowlist lives in the connector definition.

| Tool                  | Parameters                                                                                                             | Grant    | Notes                                                                                                                                                         |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list_inbox_threads`  | `query` (default `in:inbox`), `maxResults` (cap 100), `pageToken`                                                      | read     | The single list and search tool.                                                                                                                              |
| `get_thread`          | one of `threadId` or `messageId`; `format` (`full`, `metadata`, `minimal`)                                             | read     | Oldest-first; truncated to the bound with omitted ids kept.                                                                                                   |
| `read_email`          | `messageId`                                                                                                            | read     | One message; truncation stated.                                                                                                                               |
| `list_drafts`         | `maxResults`, `pageToken`                                                                                              | read     | Metadata and snippet only.                                                                                                                                    |
| `download_attachment` | `messageId`, `attachmentId`, `offset` (optional)                                                                       | read     | The connector pins the download to a per-turn temp directory and returns extracted content (see Read); `offset` is a connector parameter, not an adapter one. |
| `modify_thread`       | `threadId`, `addLabelIds`, `removeLabelIds`                                                                            | read     | Only `UNREAD` removal (mark read) and `INBOX` removal (archive, on explicit request).                                                                         |
| `draft_email`         | `to`, `subject`, `body` required; `from`, `htmlBody`, `mimeType`, `cc`, `bcc`, `threadId`, `inReplyTo`, `inlineImages` | send     | `attachments` is rejected in v1.                                                                                                                              |
| `update_draft`        | `draftId` plus the `draft_email` fields                                                                                | send     | Keeps the id; any change invalidates confirmations.                                                                                                           |
| `delete_draft`        | `draftId`                                                                                                              | send     | Invalidates confirmations.                                                                                                                                    |
| `send_draft`          | `draftId`                                                                                                              | send     | The only send path; gated.                                                                                                                                    |
| `get_draft`           | `draftId`                                                                                                              | internal | Hidden from the model; used only by the gate and the approval card.                                                                                           |

**Blocked (26), by reason.** Raw send: `send_email`, `reply_all` (replies use `draft_email` plus `send_draft`). Redundant or bloating: `search_emails`, `get_inbox_with_threads`, `download_email`. Label and message mutation beyond mark-read and archive: `modify_email`, `batch_modify_emails`. Permanent delete: `delete_email`, `batch_delete_emails`. Spam: `report_phishing`, `batch_report_phishing`. Labels: `list_email_labels`, `create_label`, `update_label`, `delete_label`, `get_or_create_label`. Filters and identities: `list_filters`, `get_filter`, `create_filter`, `delete_filter`, `create_filter_from_template`, `list_send_identities`. Accounts: `list_accounts`, `switch_account`, `unread_summary`. Probe only: `health_check`.

**The adapter has no draft read tool today.** `list_drafts` returns metadata and a snippet, so the gate cannot compute the hashes. The fix is a local, read-only `get_draft` patch in `mcp/gmail` (input `draftId`; output `draftId`, `messageId`, `to`, `cc`, `bcc`, `subject`, `body`, `htmlBody`, `from`, `mimeType`, `inlineImages`, `threadId`, `inReplyTo`, `attachments`), backed by the provider's full draft get, with the adapter version and hash pinned afterward. It is not upstreamed in v1. This fixes the bug where every send is rejected because the gate calls a tool that does not exist.

**Grant split.** With a read-only token the adapter still exposes the four draft tools, so the connector rejects them server-side and hides them from the listing until the send grant record exists.

## Sentinel tiers

Unrecognized MCP tools default to Tier 3 in the classifier, and read-only hints cannot lower a tier, so without a change every email read would prompt. The connector declares a tier per allowlisted tool, and the classifier honors it only for tools on a verified connector allowlist. Hints still only escalate.

| Tool                                                                                   | Tier        | Reason                                                                                                                 |
| -------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------------------------------------------------------------------------- |
| `list_inbox_threads`, `get_thread`, `read_email`, `list_drafts`, `download_attachment` | 1           | Read only; attachments are the user's own mail.                                                                        |
| `modify_thread` (mark read, archive)                                                   | 2           | Reversible, non-blocking, in the activity feed with undo.                                                              |
| `draft_email`, `update_draft`                                                          | 2           | Nothing leaves the account.                                                                                            |
| `delete_draft`                                                                         | 3           | Removes user data.                                                                                                     |
| `send_draft`                                                                           | 3           | The card is the single confirmation step: draft summary shown, approval mints the single-use confirmation; also gated. |
| Trash, label, filter changes                                                           | not offered | Blocked; if added later they start at Tier 3.                                                                          |
| Forwarding                                                                             | not offered | Deferred to v2.                                                                                                        |

Background and scheduled runs execute Tier 1 tools only. A Tier 2 or 3 call from a background run is held until the user is present. Sending is never possible from a background run. Background runs may read attachment metadata and ICS, text, and CSV attachments within their read budget (enough for flight and appointment detection); PDF extraction, OCR, and image reads happen only in interactive turns.

## Read surface for downstream features

Proactive reminders and the morning briefing read through the Tier 1 tools and are out of scope here. Every thread and message result carries `id`, `threadId`, internal date, `from`, `subject`, `snippet`, `labelIds`, and the account name; plain-text bodies state any truncation; `list_inbox_threads` accepts Gmail operators (`newer_than:2d`, `has:attachment`, `category:updates`). Creating a reminder is not an email write and never uses `modify_thread`.

**Context bounds.** Interactive: no tool call injects more than 8,000 tokens of email content; snippets are capped at 200 characters and `maxResults` at 100. Background runs have a separate read budget (default 24,000 tokens per run, configurable) enforced across the run, not per call, with a per-run cap on messages read in full (default 50). When a budget ends, the run states coverage and stops. Character-count approximation undercounts non-Latin scripts, so tests must exercise that case.

## Send gate

The gate runs in the connector in `packages/trueforge-core`, between the agent and the adapter. In order:

1. Allowlist: only the contract tools are callable.
2. Grant: the four draft tools require the send grant record, the same store the listing hook reads.
3. Confirmation: `send_draft` needs a record that exists (missing after restart fails closed), names the same draft id, is within 15 minutes, and is unconsumed. Check-and-consume is atomic, so two racing calls cannot both consume it. The gate then reads the draft via `get_draft` and compares hashes; any mismatch rejects. A millisecond race between the re-read and the send is an accepted residual.
4. Attachments: any attachment on the live draft rejects the send ("remove them in Gmail and re-confirm"), because attachments are outside the hashed surface.
5. Residual: the adapter holds the refresh token and has egress to Google, so a compromised adapter could bypass the gate. The gate is policy on the honest path, not a boundary against a compromised adapter.

The confirmation record is minted only when the user approves the Tier 3 card, through an endpoint that requires a human UI session and a CSRF token and is unreachable from the agent context. The internal draft read is likewise unreachable from the agent. Records persist across restarts.

## Auth Flow

Setup is UI-only: nobody edits a config file or calls an API. It runs in Settings, in the existing connector UI.

1. Settings → Connect Gmail opens a guided panel (shown only when the container runtime is present). It has numbered steps and a copy button for every string typed into the Google console: the Gmail API enable link, the client type to choose (Desktop app, which needs no redirect registration; for a Web client the panel shows the exact redirect URI to copy), and the Production publishing step.
2. The user pastes the client id and secret or drops the downloaded client JSON, which is parsed locally. The panel validates before consent: id and secret shapes, client type, and the redirect URI for Web clients. "Check my client" runs a dry authorization request and reports problems in plain language.
3. The panel shows the "unverified app" consent wording beforehand and says which button continues.
4. Connect starts authorization code flow with PKCE (`S256`) and a 128-bit `state`. Both are stored server-side, single use, 10-minute expiry, bound to the session, never logged. A mismatch or expiry rejects the callback.
5. Same machine: Google redirects to a loopback-only callback listener. Remote browser: manual code paste into the form, with the shoulder-surfing and clipboard risk stated.
6. The first consent requests `gmail.modify` only. Enabling send runs a second consent for `gmail.compose`. Granted grants derive from the scopes Google actually returned. Settings shows which grants are active.
7. If Calendar is already connected, the existing client is reused and the Gmail scopes are added.

**Verify.** After connecting, Settings runs a test connection and shows the account name and grants. **Disconnect/revoke:** see Security.

**Failure states the user sees:** container runtime missing; invalid client id or secret; redirect mismatch; consent denied; unverified-app screen not passed; token expired or revoked ("Email needs reconnection" with a one-click restart, other features keep working); Google quota or downtime (draft kept, Retry shown); revocation failed ("retrying", nothing deleted locally until Google confirms).

**Health.** The backend probes with `health_check` every 5 minutes and on demand. States: `healthy`, `not_configured`, `down`.

## Scope (v1, Gmail only)

- gmail-mcp adapter in a local container with the user's own OAuth.
- Guided UI-only setup, Settings connector card, disconnect and revoke.
- The 11-tool contract, tiers, and send gate above, including the `get_draft` patch.
- Journeys: digest, search, read (including attachment content), draft, send, emails into a space.
- Graceful degradation when credentials expire, scopes are revoked, or the provider is down.
- Context bounds for interactive and background runs.

## Architecture

```
gmail-mcp adapter   # pinned version, local container, user's own OAuth, loopback only
agent backend       # gmail connector: allowlist, grants, tier declarations,
                    #   send gate, fetch semantics, health probe
                    # encrypted store: refresh token, client id and secret
```

The fetch-semantics layer normalizes real adapter results (item arrays under `results`, `threads`, `messages`; ids; `nextPageToken`) from a static table verified against the pinned adapter. The shape check must engage against the real server, replacing the earlier mock-derived expectations that never matched. Unexpected shapes are logged by tool name and structure only, never content.

## Security

**Credential storage.** The refresh token and the client id and secret are stored encrypted at rest, following `privacy-safe-mcp.md`: masked in the UI, logs, and errors. The adapter receives credentials when it starts, provisioned from the store; if the adapter rotates the token, the connector detects the failure and shows the reconnect state rather than syncing in the background. Credentials reach the adapter through a tmpfs file, never an environment variable, and the adapter's own OAuth flow is disabled. On upgrade, existing plaintext Gmail token files are deleted after the user re-consents through the new flow; plaintext tokens are never silently migrated.

**Revocation order.** (1) Revoke the refresh token at Google and verify; an already-invalid token counts as success; a transient failure aborts and retries. (2) Delete stored credentials and both grant records so draft tools hide immediately. (3) Tear down the adapter container. (4) Show the reconnect state. Revoking removes both grants and, when shared, Calendar.

**Trust boundary.** The adapter is third-party code holding the refresh token. It runs with egress limited to Google APIs, a loopback-only transport, and a random 32-byte bearer token. Plaintext bearer transport over a network is not permitted.

**No credential or content logging.** Tokens, secrets, codes, and verifiers never reach logs, errors, or tool results. Subjects, bodies, and addresses stay out of debug logs and traces.

## Privacy

- Email is processed only to answer the request: no training, no analytics, no third-party sharing. It goes to the configured model; with a local model nothing leaves the device apart from calls to Google.
- Data flow: Google APIs to the adapter on the device, to the agent backend, to the model. Digests summarize; they do not forward bodies elsewhere.
- Credentials stay on the device, encrypted, and are never displayed.
- The privacy dashboard documents the flow: account, scopes, where the token lives, how to revoke, and the shared-token consequence for Calendar.
- Disconnecting revokes at Google and deletes local credentials.

## Testing

All tests use synthetic data: fixtures in `mcp/gmail/fixtures` and a dedicated test account seeded with invented mail. No real personal mail is read, and no personal names or addresses appear in fixtures.

- **Unit:** agent calls to `get_draft` or `health_check` by name are rejected at the allowlist; canonical hashing; confirmation store (expiry, single use, atomic consume, restart persistence); grant store; tier declarations; allowlist at list and call; fetch semantics; credential redaction; OAuth state and PKCE handling.
- **Attachments:** synthetic fixture attachments (PDF with a text layer, scanned PDF, image, ICS, oversize, password-protected, unsupported type, and a PDF containing injection text). Assert extracted content for each readable type, a clear reason for the rest, an injected instruction causing no tool call, the per-turn cap with a working `offset` continuation to the next part, nothing left in the temp directory after the turn, and a background run reading ICS and text attachments but not PDFs, stopping at its budget with coverage stated.
- **Fixture-backed MCP tests:** `get_draft` returns every hashed field and an attachments list, and a clear error for a missing draft. With `get_draft` in place, a confirmed draft sends successfully; before the patch the same test fails. Mark-read, archive, and draft edit loop against the fixture client.
- **Send gate:** edit the draft in Gmail after confirmation (rejected); expire (rejected); send twice (second rejected); concurrent sends (one wins); attachment added out-of-band (rejected); backend restart with record intact (succeeds) and absent (fails closed); `send_email` and `reply_all` by name (rejected); a revoked token (send fails with the reconnect state, draft kept); confirmation endpoint called without session or CSRF (rejected).
- **Prompt injection:** a message body telling the agent to send or forward mail, or to call a blocked tool, produces no tool call outside the allowlist and no confirmation.
- **Sentinel:** each tool gets its table tier; an unlisted tool stays Tier 3; hints never lower a tier; a background run calling a Tier 2 or 3 tool is held; a background run reading past its budget stops with coverage stated.
- **Revocation and degradation:** order verified, transient failure aborts local deletion, provider down and scope revoked mid-session degrade only email.
- **UI-only browser journey** with a dedicated test account: from an empty state, follow the guided panel, paste wrong credentials and see each failure message, connect read-only, read seeded mail, add send, approve a send to the test account itself, disconnect, and confirm the grant is gone at the provider. No config file or direct API call at any step. Includes the container-runtime-missing message.

## Branch plan

1. Land `fix/gmail-mcp-null-escape` first (one-line pattern fix in `mcp/gmail`).
2. Add the local `get_draft` patch to `mcp/gmail`, with fixture test, and re-pin.
3. Build on `feat/gmail-integration` (connector, gate, vault, setup routes). Change its begin request to default to read-only scopes, validate the redirect URI, and fix `get_draft` usage against the patched adapter.
4. Add the Settings connector card and guided panel by extending the existing connector settings UI in `packages/trueforge-ui`; change schemas across core, frontend, and the server in the same change.
5. Close `feat/email-integration`; `feat/gmail-integration` supersedes it.

## Out of Scope (v1)

- App-owned OAuth clients or provider verification. Never.
- Office document extraction and sending attachments (`draft_email` rejects `attachments`; the gate rejects any draft carrying one).
- Forwarding, attaching files to drafts, labels, filters, trash, and permanent delete.
- Multiple accounts, Outlook, iCloud, bulk import.
- Automated unsubscribe (the `List-Unsubscribe` link may be shown).
- Proactive reminders and the morning briefing logic (they consume the read surface above).

## Deferred to v2

Outlook (own Azure registration, Graph mail permissions), iCloud Mail (app password, IMAP adapter), multiple accounts, forwarding, Office document reading, sending attachments, and a scheduled drift review of unexpected adapter shapes.

## Open Questions

1. Is the default 24,000-token background budget right for a daily scan, and should text-layer PDFs be allowed in background runs later?
2. When Calendar lands, does revoking Gmail alone prompt a reconnect for Calendar, or can scopes be narrowed in place?
