# Encrypted secrets at rest

Status: approved

## Problem

Aman saves provider API keys, MCP credentials and OAuth tokens in its database as plain text. Anyone who gets a copy of the database, a backup or a support bundle can read them. Saved site logins for the browser are coming next, which raises the stakes.

## Solution

Every saved secret is encrypted with one master key per machine (AES-256-GCM). The master key never sits in the database or in backups:

- Where the machine has a TPM, the key is protected by it (Linux through `systemd-creds`, Windows through the built-in Platform Crypto Provider, Mac through the login keychain with FileVault).
- Without a TPM, the key lives in a file outside the data folder, and Aman shows a plain warning about what that does and doesn't protect.

A small host job places the key in a memory-only file when the machine starts. Aman waits for it and unlocks by itself, so reminders and scheduled briefs still run after a power cut with nobody signed in. A recovery key is printed during setup and tested by unlocking with it alone.

## Key design decisions

- **Each value is bound to where it lives.** The table, the row's declared primary key and the field are authenticated with the value, so a value copied to another row or field fails to decrypt. SQLite's implicit rowid is never used, because `VACUUM` can renumber it.
- **Versioned format.** Values look like `enc:v1:<base64url>` and carry a short key fingerprint, so later key changes don't need another data migration.
- **Key check value per database.** Each instance database stores a known value encrypted with the master key. A missing or wrong key is detected at start, and secrets stay locked.
- **Fail closed.** While locked, Aman never reads or writes a secret, in plain text or otherwise. Only setup (or `aman secrets init`) creates a master key; starting Aman never does.
- **The TPM is bound to the chip only, not to boot measurements,** so firmware and Secure Boot updates don't lock people out. Protection against a stolen whole machine comes from disk encryption, which setup checks.

## How the key reaches Aman

- Aman reads the master key from one file, set by `SECRETS_KEY_FILE`. The file holds the key as one line of base64 and must be readable only by its owner.
- Aman never makes a key when it starts. If the file isn't there yet, it keeps checking: every 2 seconds for the first 10 minutes, then every 30 seconds. It unlocks by itself when the right key appears, with no restart.
- A key that is missing, readable by other accounts, malformed or wrong for this database keeps secrets locked, and the log says which.
- `aman secrets init` sets up one database: it uses the key file if it is there (so every instance on a machine shares one key) and makes it only if it is not. It saves the key check value and a recovery copy, then prints this database's own recovery key once. It refuses a database that is already set up, or one set up with a different key.
- `aman secrets check-recovery` reads a recovery key on stdin and says whether it unlocks the database, so setup can make sure it was written down correctly.
- Setup on each platform puts the key file in a memory-only place outside the data folder and mounts it into each instance; that wiring comes with the platform step.

## Sealed backups

A backup holds chats, memory and settings, so the whole backup is encrypted, not only the secrets inside it.

- `aman seal` turns a stream of bytes into a sealed file, and `aman unseal` opens one. Both read and write files or stdin and stdout, so a backup can be sealed without an unencrypted copy touching the disk.
- Each sealed file has its own random data key. The header holds that key encrypted with the machine key, and the database's recovery copy, so the file opens with the machine key on the computer that made it, or with the recovery key anywhere.
- The data is encrypted in 64 KB pieces (AES-256-GCM). Each piece is checked together with the header and its position, and the last piece is marked. A file that was changed, cut short, reordered or mixed with another file is refused.
- `aman seal` refuses a database that is not set up, or a key that is not that database's key. `aman unseal` writes to a `.part` file and only gives it its final name when the whole file passed its checks.

## Scope

Delivered in steps, each its own PR linking this spec:

1. The encrypted store: format, binding, key check value, locked state.
2. Key delivery, waiting for the key, and the key file.
3. The recovery key and restoring on a new machine.
4. Platform key protection (Linux, Windows, Mac) and the startup task on Windows.
5. Encrypting existing secrets, then cleaning old copies out of the database files.
6. Log redaction and plain docs on what backups hold.
7. Sealed backups, and restoring one on a new machine with the recovery key.

## Privacy

Everything stays on the person's machine. No key, secret or recovery key is sent anywhere, logged, or shown back in the app. Secrets are write-only in the API: at most the last four characters are shown.

## Testing

Tests use synthetic keys and planted canary values, never real user data. They cover tampering, values moved between rows or fields, wrong and missing keys, `VACUUM` and database copies, and that no plaintext or key bytes appear in errors or logs.

## Out of scope

- Separate keys per connection or per person.
- Unlocking with a passphrase instead of a TPM or key file.
- Protection against malware already running as the user on a live machine.
