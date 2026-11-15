# Spec: Put Aman back from a backup

**Status:** draft

## Problem

Aman makes a backup every night, but a backup only helps if it can be put back. On Mac and Linux, `aman restore` does that (the shell installer's `install.sh restore`). A PC set up with Aman Setup on Windows has `aman backup` and `aman backups` but no way back: putting a backup back by hand means unpacking it into Docker volumes in the right order, which most people cannot do.

## Solution

### `aman restore` on Windows

`aman restore [<name>] [<backup> | --latest]` in Aman Setup's `aman` command takes the same words as the shell's `aman restore`, so every next step the shell prints can be typed as it is.

- It reads the instances from the record of what is installed and the backups from the Backups folder on the PC (`%LOCALAPPDATA%\Amanuensis\backups`).
- With no backup named, it lists the backups that hold that instance newest first, by date and time (and "before import" or "before restore" for a kept backup), and asks for a number. `--latest` takes the newest. A name picks the instance when there is more than one.
- It asks once before anything changes: which instance, which backup, that a copy of how it is now is saved first, and, when the instance is running, that it is stopped while this happens. Just before the question it says that the password goes back to the backup's and that devices may have to sign in again. A typed answer other than yes changes nothing and exits 0. An input that ends without an answer changes nothing and exits 1, so a script never reads success.
- After a yes it deletes the note an earlier removal left to say Docker is cleared, because the restore brings an instance back. If the note cannot be deleted, nothing runs.
- The settings of this install that the sign-in service depends on (its addresses, cookie name and sign-in client) stay as they are, and the chats, settings, password and owner come from the backup, so a backup from another computer can be restored after a new install and sign-in keeps working.
- The work is the shell's own restore, run in the setup container exactly like `aman backup`, with the Backups folder mounted where the shell reads backups. The shell checks the backup is whole and not newer than this Aman, saves the `before-restore` copy, puts the backup back, starts the instance, and puts the copy back if anything fails.
- Reading the backup happens inside the setup container, so a future backup format that needs a tool to open it never needs that tool on Windows.
- Every refusal says what happened and the one thing to do next. When the shell explains a failure itself, its words are shown as they are, with nothing added, however the shell wrapped them. A path into the backups folder is shown as the folder on the PC.

### Restore by hand

`docs/backup.md` gains a "Restore by hand" section for when the `aman` command is gone: `install.sh restore` from the checkout on Mac and Linux. On Windows, running Aman Setup again brings the `aman` command back, so `aman restore` is the way there too. A section on restoring on another computer says to install Aman first and copy the backup folder into the Backups folder.

## Privacy

Nothing leaves the computer. The backup is read from the PC's own disk and put back into Aman's own Docker volumes. Backups still hold secrets such as the model key, as before.

## Testing

Package tests with a fake Windows host, fake process runner and made-up backups:

- the command line run, the folders mounted, and the yes sent to the shell's question;
- listing newest first, picking by number, `--latest`, a named backup, and every bad answer changing nothing;
- saying no, no answer, a running and a stopped instance's question, two instances, a missing instance or backup, no backups, backups of another instance only, a folder that cannot be listed;
- the removal note cleared on a yes, left on a no, and a note that cannot be cleared stopping the restore;
- a wrapped shell message counting as explained, and backup paths shown as the folder on the PC;
- several answers piped in together each reaching their own question, and the end of the input answering null (`tests/lineInput.test.ts`);
- the record failing to read, Docker not answering, a busy install, the shell's refusal and rollback shown in its own words, and an unexplained failure.

The shell restore has its own tests in `installer/tests/lib/restore.test.sh`.

## Out of scope

- Encrypted backups and their keys.
- A Start menu entry for restore.
- Restoring onto a new PC without installing Aman first.
