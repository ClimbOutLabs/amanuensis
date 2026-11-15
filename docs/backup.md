---
title: 'Back up and restore'
description: 'How Aman backs up your data, how to go back to a backup, and how to copy a backup off your computer.'
---

# Back up and restore

Aman backs up your chats, memory and settings every night, all by itself. If something goes wrong, you can put Aman back the way it was in a backup.

## How backups work

When you install Aman, it asks "Back up automatically every day?". If you keep the answer yes, Aman backs up every instance on this computer each night at 03:30. An instance is one person's own copy of Aman. You don't need to do anything.

=== "Mac and Linux"

    Each backup is a new folder in `~/.amanuensis/backups`. That's the `backups` folder inside the hidden `.amanuensis` folder in your home folder.

=== "Windows"

    On a PC set up with Aman Setup, each backup is a new folder in `%LOCALAPPDATA%\Amanuensis\backups`. The **Backups** entry in the Start menu opens it.

A backup's name starts with its date, year first, so October 17, 2026 reads `20261017`.

- Aman keeps the last 7 backups and deletes older ones.
- If any part of a backup fails, Aman removes the half-written folder.
- A backup made before an import or a restore has `-before-import` or `-before-restore` after its date. It doesn't count toward the 7, and stays until you delete it.

!!! note "Backups are encrypted"

    Each backup is encrypted with a key kept on this computer. Nobody can read your chats or secrets from a backup file alone. To open a backup on another computer you need your recovery key. That's the 48 digits Aman showed you once when it was set up. Keep it somewhere safe.

    Backups made by older versions of Aman weren't encrypted. After you update, the next backup encrypts them where they are, and `aman doctor` warns while any is still readable. A copy you made of an old backup, on another drive or in the cloud, stays readable. Delete it, or replace it with the encrypted one.

??? note "What's in a backup"

    For each instance, a backup holds one encrypted file, named after the instance and ending in `.sealed`. Inside it are:

    - the database with your chats, personas and settings, checked after copying;
    - your memory files and persona knowledge files;
    - the sign-in data and the instance settings, including its secrets.

    Next to it, not encrypted because they hold nothing private, are:

    - the certificate of the local certificate authority, but never its private key;
    - a `SHA256SUMS` file to check every file in the folder.

    If an instance was never given a recovery key, its backup opens only on the computer that made it. Run `aman upgrade` once and the next backup opens with the recovery key too.

    An incognito chat that's open when the backup runs is left out, because an incognito chat is gone when it closes. See [Incognito chat](../packages/trueforge/guide/topics/incognito.md).

## Make a backup now

=== "Mac and Linux"

    Open a terminal and run:

    ```bash
    aman backup
    ```

    To back up only one instance, add its name: `aman backup NAME`.

=== "Windows"

    Open PowerShell and run:

    ```
    aman backup
    ```

    To see the backups kept on this PC, run `aman backups`.

If `aman doctor` warns that backups are off or old, run `aman doctor backup --fix`. It turns on daily backups and makes one now.

## Go back to a backup

Use this when chats or settings were lost or changed by mistake.

1. Open a terminal (on Windows, a Command Prompt or PowerShell window).
2. Run:

   ```
   aman restore
   ```

3. It lists your backups, newest first, and asks which one to use. Type its number.
4. It says what will be replaced. Type `yes` to go ahead.

Before it changes anything, it saves a copy of what you have now and shows you where it is, so you can go back again. If anything fails, it puts that copy back and says so.

!!! note "Your password goes back too"

    A restore brings back the password you had when the backup was made. If you changed the password since, the old one works again. If the old one isn't safe anymore, change it after the restore with `aman password`. Devices that are signed in now may need to sign in again.

??? note "More ways to restore"

    - `aman restore --latest` takes the newest backup without the list.
    - With more than one instance, name the one to restore: `aman restore NAME`. See [Install](install.mdx) for details.
    - On Windows, you can name the backup to skip the list: `aman restore 20261017T033000Z`. Windows tells you which backup it will use before anything changes. If Aman is running, it also tells you that Aman stops while the backup goes back.
    - If nothing answers the question, for example when `aman restore` runs from a script, it changes nothing and ends with an error.
    - A restore doesn't change this computer's certificates. Devices that trust this computer keep trusting it.

## Move to another computer

1. Install Aman on the new computer first, with the same instance name. That's `main` unless you chose another.
2. Copy the backup folder, for example `20261017T031500Z`, into the backups folder there:
   - Mac and Linux: `~/.amanuensis/backups`
   - Windows: `%LOCALAPPDATA%\Amanuensis\backups`, so that folder holds `20261017T031500Z` itself.
3. Run `aman restore --latest`.
4. It asks for the recovery key of the Aman that made the backup. Type the 48 digits, with or without the dashes.

The new computer then protects the data with its own key. Your recovery key stays the same, so keep it.

!!! note "Windows"

    On Windows, `aman restore` can't ask for the recovery key yet. A backup made on another PC can't be restored there for now.

The instance keeps the addresses and sign-in setup of the new computer, so signing in keeps working.

It brings back the chats, memory, settings and password of the backup, and the email the backup was made with. If that email isn't the one you used on the new computer, the restore says which one to sign in with.

Each device has to trust the new computer once, as on a first install.

## Copy a backup off this computer

A backup on the same disk doesn't help if that disk fails. Copy the newest backup to another disk, a network drive or a folder your cloud drive syncs.

=== "Mac"

    1. Open Finder and choose **Go**, then **Go to Folder**.
    2. Type `~/.amanuensis/backups` and press ++return++.
    3. Drag the backup with the newest date onto the other drive.

=== "Linux"

    1. Open **Files**.
    2. Press ++ctrl+l++, type `~/.amanuensis/backups` and press ++enter++.
    3. Copy the backup with the newest date and paste it onto the other drive.

=== "Windows"

    1. Choose **Backups** in the Start menu.
    2. Copy the backup with the newest date onto the other drive.

A backup is encrypted, so it's safe on a shared or cloud drive. Without this computer or your recovery key, nobody can open it. An old copy from before backups were encrypted is still readable, so delete it or replace it.

## Restore by hand

Use this only when the `aman` command itself is gone or won't start.

=== "Mac and Linux"

    Run the installer's own restore from the folder Aman was installed from:

    ```bash
    cd amanuensis
    ./installer/install.sh restore
    ```

=== "Windows"

    Run Aman Setup again. It brings the `aman` command back and keeps your instance. Then `aman restore` works as above.

## Related

- [The aman command](commands.md)
- [Troubleshooting](troubleshooting.md)
- [Password and sign-in](../packages/trueforge/guide/topics/account.md)
