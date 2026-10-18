# Spec: Email Integration (v1, Gmail only)

**Status:** implemented. This replaces the earlier design, which ran a separate Gmail adapter in a local container behind the connector gate. That approach is superseded and is not built; the adapter folder is kept only for people who added it as a connector, and Aman's own Gmail does not use it.

## Problem

Aman could not read, search, or draft email, so the morning digest, thread lookup, reply drafting, and collecting mail into a project space did not work. Email is also the most dangerous text Aman reads: anyone can write to the user, and a send cannot be undone.

## Solution

Gmail support built into Aman. The user connects their own Google account in Settings, Connectors, Google. Aman keeps one saved sign-in per person and calls Gmail's web API directly with it, so there is no extra process, container, or adapter to install. The user brings their own Google Cloud project, so Aman never owns a Google client and never goes through Google's app verification. Outlook and iCloud are deferred.

## Design Decisions

**User-owned client.** Each user creates an OAuth client in their own Google Cloud project. The honest consequence is a multi-step task in a console Aman does not control, and a consent screen that shows an "unverified app" notice because the user owns the app. The product makes it guided: a step-by-step panel, a check of the client before sign-in, and plain words for every failure. The client secret is sent to Aman once, to start the sign-in, and is never shown again.

**One sign-in per person, two features.** Features are what the user sees and what tools are gated on. Read maps to the narrow read-only Gmail scope; Compose maps to the compose scope. Full-mailbox and delete scopes are never requested. The user connects read-only first and adds compose later with a second consent that keeps the first. Tools are offered only for what Google actually granted, not for what was asked.

**Read is required.** Asking for compose alone is refused with a plain message, because a send is always shown against the mail it answers.

**Where the browser returns to depends on how the user reaches Aman.** With a public https address, the user makes a Web client that returns to it. On the same machine, a Desktop client returns straight to Aman. From any other machine, the user pastes the address of the page that fails to load, and Aman reads the code from it. Only the one expected return address is accepted, and a wrong page never uses up the sign-in in progress.

**Testing or Published.** A project left in Testing signs the user out every 7 days. The panel offers both choices in plain words and never assumes the user will publish. When Google stops accepting the sign-in, Aman shows Reconnect needed, pauses mail, and keeps everything else working.

**Settings routes are for the browser only.** Agents, sandboxes, and API clients cannot call them. A cross-site form cannot start a test or a disconnect. On a demo instance the owner connects one named Google account (`DEMO_GOOGLE_ACCOUNT`) before visitors arrive; any other account is refused, and with no account named nothing can be connected. A demo consent asks for every feature. Once a working connection for that account with every feature is saved, the panel cannot reconnect or disconnect it; until then the named account can connect again to add what is missing. A login Google stopped accepting can be reconnected, but only with the named account. Mail tools are mounted, drafts work, and a send is allowed only to the addresses in `DEMO_SEND_ALLOWLIST`; the demo refuses sends it cannot fully check, including every connector action that is not declared read-only.

**Disconnect never gets stuck.** Aman asks Google to revoke its access, then deletes the saved sign-in. If Google does not confirm, the sign-in is still deleted and the user is told how to remove access in their Google account settings.

**Secrets at rest.** The saved client secret and sign-in are stored in Aman's database and are not encrypted there. They rely on the private data folder. They are also added to the guard that stops secrets leaving in outbound text.

**Email content is untrusted data.** Text inside a message cannot change tool calls, approvals, or confirmations. Every result says so, and any internal tag written in a subject, name, or body is turned into plain text.

**One account in v1.** Results name the account that was read.

## User Journeys

### Morning digest

The user asks "Catch me up on my email." Aman lists unread mail first, then the rest of the inbox, one line each with sender, subject, and a short gist in the user's language, and names the account it searched.

### Search

"Find the email about the lease." Gmail's own search syntax over the inbox by default. Results show sender, date, snippet, and account, and say when they were cut short.

### Read

The user opens a thread. It reads oldest first, with each attachment named. Long threads keep their newest messages and count the older ones that were left out.

### Draft

"Draft a reply saying Thursday works." A reply keeps its thread and its reply headers, and the subject becomes "Re:" the original. The user is asked before the draft is saved, and again before any change to it. Drafts are plain text only.

### Send

"Send it." The approval card is the one confirmation step. It shows the whole message exactly as it will be sent: recipients, copy, hidden copy, subject, the name it is sent under, and the full text. There is no second prompt and no standing permission to send.

## Tools

Reads run silently and count as reading private data. Writes always ask.

| Tool                  | Does                                                                  | Asks |
| --------------------- | --------------------------------------------------------------------- | ---- |
| `list_inbox_threads`  | List or search threads with Gmail search syntax                       | No   |
| `get_thread`          | Read one thread by thread or message id                               | No   |
| `read_email`          | Read one message with its attachments listed                          | No   |
| `download_attachment` | Place one attachment in the sandbox workspace so it can be read there | No   |
| `list_drafts`         | List saved drafts                                                     | No   |
| `get_draft`           | Read one saved draft                                                  | No   |
| `draft_email`         | Save a new plain-text draft, optionally as a reply                    | Yes  |
| `update_draft`        | Replace the content of a saved plain-text draft                       | Yes  |
| `send_draft`          | Send a saved draft. The only way to send                              | Yes  |

Any other tool name is refused. A raw send that skips the draft does not exist.

## Safety Model

**What a send delivers is what the user saw.** The card is built from the draft as Gmail holds it, never from the model's words. Aman remembers a fingerprint of that draft: recipients, copy, hidden copy, subject, text, thread, reply headers, and the sender name. The send goes ahead only if the draft still matches. An edit made after review, by anyone, makes the send stop and ask again. A review is used once and lasts 30 minutes. It lives in memory, so after a restart or an expiry the user is asked again.

**Only drafts Aman can show in full are sent.** A draft is refused when it has an attachment, an HTML version, extra headers such as a reply address, a different sender, a body too long to read, odd blank space at its edges, or a recipient list that a mail reader might split differently. Headers that are not shown must be in a closed, simple format.

**Nothing may be hidden.** Text with characters that do not show, such as zero-width marks or Unicode tag characters, is refused, except in the few places they are part of normal writing, such as emoji and some scripts.

**Reads are bounded.** One result never goes over a fixed token budget as a whole: headers, file names, and every message count, not only bodies. Text beyond the budget is never decoded. A response that is too large is refused before it is parsed. A list that takes too long returns the rows it has and says so.

**A send is never repeated blindly.** Requests that create or send are not retried after a failure that may have happened after Gmail acted. If the outcome is unknown, Aman says the send may have gone through and tells the user to check the Sent folder before trying again.

**After reading mail, outbound searches ask.** Once a conversation has read mail, web searches in it ask first, so mail content cannot leave in a query unseen.

**Scheduled runs read but never write.** The write tools are not offered to a scheduled run and a call is refused.

**Offline mode turns Gmail off**, because it needs the network.

## Not In v1

Outlook and iCloud. Labels, archive, mark-read, and delete. Sending attachments or HTML. More than one account. Calendar, which is expected to reuse the same sign-in and its own consent.
