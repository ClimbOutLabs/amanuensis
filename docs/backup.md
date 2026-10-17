# Backups

## How `aman backup` works

Run `aman backup` to back up every Aman instance on this computer, or `aman backup <name>` for one. `installer/install.sh backup` does the same.

Each backup is a new folder named with the date and time, under `~/.amanuensis/backups/` (or `<home>/backups/` if you installed with `--home`). For each instance it holds:

- the database with your chats, personas and settings, checked after copying;
- your memory files and persona knowledge files;
- the sign-in data and the instance settings, including its secrets;
- the local certificate authority, so your devices keep trusting Aman after a restore;
- a `SHA256SUMS` file to check every file in the folder.

If any part fails, the half-written folder is removed. The last 7 backups are kept and older ones are deleted.

The installer turns on a daily backup at 03:30. Turn it off or on again with `installer/install.sh backups off` or `installer/install.sh backups daily`. `aman doctor backup` checks that backups are recent and scheduled.

Backups are not encrypted, and they contain secrets such as your model key. Treat them like a password file.

## Copy backups off this computer

A backup on the same disk does not help if that disk dies. Copy it to another disk, a network drive or a folder your cloud drive syncs.

1. Make a fresh backup: `aman backup`.
2. Copy the backups folder to the other drive, for example: `rsync -a ~/.amanuensis/backups/ /path/to/drive/aman-backups/`
3. Check the copy: `cd /path/to/drive/aman-backups/<newest folder> && sha256sum -c SHA256SUMS` (on a Mac, use `shasum -a 256 -c SHA256SUMS`).

Because backups hold secrets, pick a drive only you can read, or use one that encrypts what it stores.
