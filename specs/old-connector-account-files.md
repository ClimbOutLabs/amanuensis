# Old connector account files and browser saving

Status: draft

## Problem

Early installers kept the Email connector's account, app password included, in
`.env.mail-email` in the instance folder. The connector now keeps its account in
its own volume and nothing reads that file. An upgrade only said "connect it
again", so the file stayed on disk with a working app password in it. The
Calendar connector already moves its old file and deletes it; Email did not.

Aman's own browser is a full Chromium. If someone clicked "Save password" in the
live view, Chromium would keep that password in the profile folder, and cards or
addresses the same way.

## Change

- `aman upgrade` moves an old `.env.mail-email` into the Email connector through
  its account agent, then deletes the file. An account already saved in the
  connector (connected again in Settings) is newer, so it is kept and the old file
  is only deleted. A file that cannot be moved stays, and the upgrade keeps saying
  how to connect again. This runs on every upgrade, including one that finds
  nothing new to install.
- The account agent gets `--has-account`, which prints one word (`saved` or
  `none`) and never the account, so the upgrade can tell which case it is in.
- `install.sh instance email NAME --remove` also deletes an old file.
- `aman doctor` warns while an old `.env.mail-email` or `.env.calendar` is still
  in an instance folder, and says to run `aman upgrade`.
- The browser image sets Chromium policy so it never offers to save passwords,
  cards or addresses. The x64 and arm64 builds read policy from different
  folders, so the image writes both.

## Privacy

Less personal data stays on disk: an app password nothing uses is removed, and
the browser profile can no longer hold saved passwords, cards or addresses. The
password moves only on stdin between the installer and the connector's agent; it
is never printed or logged.

## Testing

All with synthetic accounts and passwords.

- Installer tests: a complete old file is moved and deleted, and the password
  never appears in output; an account connected again is kept; an incomplete
  file stays and the notice still shows; an upgrade with nothing new still moves
  the file.
- Account agent test: `--has-account` prints `saved` or `none` only.
- Doctor tests: each old file gives the warning and its contents never appear.
- CI runs a check on the built arm64 browser image that the three saving
  settings are off by policy.

## Out of scope

Encrypting saved secrets, chats and backups is separate work.
