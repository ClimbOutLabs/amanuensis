---
title: 'Backups'
description: 'How Aman backs up your data and how to copy a backup off your computer.'
---

## How backups work

When you install Aman, it asks "Back up automatically every day?". If you keep the answer yes, Aman backs up every instance on this computer by itself, every night at 03:30. You do not need to do anything.

Each backup is a new folder inside the hidden `.amanuensis` folder in your home folder, in a folder called `backups`. A backup's name starts with its date, year first, so 17 October 2026 reads `20261017`. For each instance it holds:

- the database with your chats, personas and settings, checked after copying;
- your memory files and persona knowledge files;
- the sign-in data and the instance settings, including its secrets;
- the local certificate authority, so your devices keep trusting Aman after a restore;
- a `SHA256SUMS` file to check every file in the folder.

If any part fails, the half-written folder is removed. The last 7 backups are kept and older ones are deleted.

Backups are not encrypted, and they contain secrets such as your model key. Treat them like a password file.

## Copy a backup off this computer

A backup on the same disk does not help if that disk dies. Copy the newest backup to another disk, a network drive or a folder your cloud drive syncs.

On a Mac:

1. Open Finder and choose **Go**, then **Home**.
2. Press Command+Shift+full stop to show hidden folders.
3. Open `.amanuensis`, then `backups`.
4. Drag the backup with the newest date onto the other drive.

On Linux:

1. Open **Files**. It starts in your home folder.
2. Press Ctrl+H to show hidden folders.
3. Open `.amanuensis`, then `backups`.
4. Copy the backup with the newest date and paste it onto the other drive.

Because backups hold secrets, pick a drive only you can read, or use one that encrypts what it stores.
