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
- the certificate of the local certificate authority, but never its private key, so after a restore each device trusts this computer again;
- a `SHA256SUMS` file to check every file in the folder.

If any part fails, the half-written folder is removed. The last 7 backups are kept and older ones are deleted.

A backup made before an import or a restore has `-before-import` or `-before-restore` after its date. It does not count toward the 7 and stays until you delete it.

Backups are not encrypted, and they contain secrets such as your model key. Treat them like a password file.

## Go back to a backup

To put an instance back the way a backup had it, run:

```
aman restore
```

It lists the backups, newest first, and asks which number to use. `aman restore --latest` takes the newest one without the list. It says what will be replaced and waits for you to type `yes`. Before it changes anything it saves a copy of what you have now and prints where it is, so you can go back again. If anything fails, it puts that copy back and says so. With more than one instance, give the name: `aman restore <name>`. See [Install](/install) for the details.

On Windows, `aman restore` works the same way in a Command Prompt or PowerShell window. It reads the backups in the Backups folder on the PC. Before anything changes it tells you which backup it will use and, when Aman is running, that Aman stops while the backup goes back. Type `yes` to go ahead. To pick a backup without the list, name it: `aman restore 20261017T033000Z`.

## Restore by hand

Use this only when the `aman` command itself is gone or will not start. Everything else should go through `aman restore`.

**On a Mac or Linux,** run the installer's own restore from the folder Aman was installed from:

```bash
cd amanuensis
./installer/install.sh restore
```

**On Windows,** the restore runs in Aman's setup helper, the same way `aman restore` runs it. You need Docker Desktop running and the backup in your Backups folder.

1. If this is a new PC, or Docker Desktop was reset, install Aman again with Aman Setup first. Then copy the backup folder into `%LOCALAPPDATA%\Amanuensis\backups`. A fresh install starts empty, and the restore fills it.
2. Open PowerShell.
3. Set the name of the setup helper. Copy the `setup_image` value from `installer/release.json` in the Aman release you installed:

   ```powershell
   $image = "<setup_image from installer/release.json>"
   ```

4. See the backups that are there:

   ```powershell
   Get-ChildItem "$env:LOCALAPPDATA\Amanuensis\backups" -Directory | Sort-Object Name -Descending | Select-Object Name
   ```

5. Put one back. Replace `20261017T033000Z` with the name from step 4. `main` is the name of the instance Aman Setup makes:

   ```powershell
   docker run --rm -it `
     -v /var/run/docker.sock:/var/run/docker.sock `
     -v aman_home:/root/.amanuensis `
     -v aman_source:/src `
     -v "$env:LOCALAPPDATA\Amanuensis\backups:/root/.amanuensis/backups" `
     -w /src $image `
     installer/install.sh restore main 20261017T033000Z
   ```

   It checks the backup, saves a copy of how Aman is now, and asks you to type `yes`. If anything fails, it puts the copy back and says so.

6. Open Aman and sign in with the email and password you had when the backup was made.

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
