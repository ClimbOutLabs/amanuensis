---
title: 'Backups'
description: 'How Aman backs up your data, how to put a backup back, and how to copy a backup off your computer.'
---

## How backups work

When you install Aman, it asks "Back up automatically every day?". If you keep the answer yes, Aman backs up every instance on this computer by itself, every night at 03:30. You do not need to do anything.

Each backup is a new folder inside the hidden `.amanuensis` folder in your home folder, in a folder called `backups`. On a Windows PC set up with Aman Setup, the `backups` folder is in `%LOCALAPPDATA%\Amanuensis` instead, and the **Backups** entry in the Start menu opens it. A backup's name starts with its date, year first, so 17 October 2026 reads `20261017`. For each instance it holds:

- the database with your chats, personas and settings, checked after copying;
- your memory files and persona knowledge files;
- the sign-in data and the instance settings, including its secrets;
- the certificate of the local certificate authority, but never its private key;
- a `SHA256SUMS` file to check every file in the folder.

An incognito chat that is open when the backup runs is left out of it, because an incognito chat is gone when it closes. See [Privacy](/privacy#incognito-chats).

If any part fails, the half-written folder is removed. The last 7 backups are kept and older ones are deleted.

A backup made before an import or a restore has `-before-import` or `-before-restore` after its date. It does not count toward the 7 and stays until you delete it.

Backups are not encrypted, and they contain secrets such as your model key. Treat them like a password file.

## Go back to a backup

To put an instance back the way a backup had it, run:

```
aman restore
```

It lists the backups, newest first, and asks which number to use. `aman restore --latest` takes the newest one without the list. It says what will be replaced and waits for you to type `yes`. Before it changes anything it saves a copy of what you have now and prints where it is, so you can go back again. If anything fails, it puts that copy back and says so. With more than one instance, give the name: `aman restore <name>`. See [Install](/install) for the details.

A restore puts back the password too. If you changed the password after the backup was made, the old one works again. If the old one is no longer safe, change it after the restore with `aman password`. Devices that are signed in now may have to sign in again.

If nothing answers the question, for example when `aman restore` runs from a script, it changes nothing and ends with an error.

A restore does not change the certificates of this computer. Devices that trust this computer keep trusting it.

### On another computer

1. Install Aman on the new computer first, with the same instance name. That is `main` unless you chose another.
2. Copy the backup folder, for example `20261017T031500Z`, into the `.amanuensis/backups` folder in your home folder there. On Windows, copy it into `%LOCALAPPDATA%\Amanuensis\backups`, so that folder holds `20261017T031500Z` itself.
3. Run `aman restore --latest`.

The instance keeps the addresses and the sign-in setup of the new computer, so signing in keeps working. It takes back the chats, memory, settings and password of the backup, and the email the backup was made with. If that email is not the one you used on the new computer, the restore says which one to sign in with. Each device has to trust the new computer once, as on a first install.

On Windows, `aman restore` works the same way in a Command Prompt or PowerShell window. It reads the backups in the Backups folder on the PC. Before anything changes it tells you which backup it will use and, when Aman is running, that Aman stops while the backup goes back. Type `yes` to go ahead. To pick a backup without the list, name it: `aman restore 20261017T033000Z`.

## Restore by hand

Use this only when the `aman` command itself is gone or will not start. On a Mac or Linux, run the installer's own restore from the folder Aman was installed from:

```bash
cd amanuensis
./installer/install.sh restore
```

On Windows, run Aman Setup again. It brings the `aman` command back and keeps your instance, and then `aman restore` works as above.

## Copy a backup off this computer

A backup on the same disk does not help if that disk dies. Copy the newest backup to another disk, a network drive or a folder your cloud drive syncs.

On a Mac:

1. Open Finder and choose **Go**, then **Go to Folder**.
2. Type `~/.amanuensis/backups` and press Return.
3. Drag the backup with the newest date onto the other drive.

On Linux:

1. Open **Files**.
2. Press Ctrl+L, type `~/.amanuensis/backups` and press Enter.
3. Copy the backup with the newest date and paste it onto the other drive.

Because backups hold secrets, pick a drive only you can read, or use one that encrypts what it stores.
