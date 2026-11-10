---
title: 'Notes folder'
description: 'Connect a folder of Markdown notes so Aman can search and read them in chat, add entries to one inbox file, and make new notes.'
---

The Notes folder connector points Aman at a folder of Markdown notes, such as the vault you open in Obsidian. There is no account and no secret. Settings holds only the folder path and the name of one inbox file.

## What Aman reads

- **Search.** Aman searches the folder by meaning and by words, and answers from the notes it finds.
- **Read.** Aman reads one note in full when a chat needs the whole note.

Note text comes back to the model marked as untrusted data, like mail. Words in a note do not become instructions.

## What Aman writes

Aman can only add. It never changes or deletes a note you wrote.

- **Add to the inbox.** Aman adds one entry, under a heading with the date and time, to the one file you name in Settings. The default name is `Aman inbox.md`. The entry is appended as new bytes at the end of the file, after a check that the file did not change while the entry was prepared, so a sync landing at the same moment is never overwritten.
- **Make a new note.** Aman makes a note that does not exist yet. A name that is already taken is refused, never overwritten.

The two writes run without an approval card while the ask is yours, the same way reminders do. Once a chat has read content that is not your own words, a write asks first with a card, because the write may have been asked for by something Aman read. On a scheduled run with nobody to answer, a write like that is skipped.

## The folder must sit outside Aman's own data

The folder cannot overlap any folder Aman keeps its own data in: its memory folder, its persona knowledge folder, the app data folder that holds its database, or the folder the sandbox slot workspaces live under. Picking one of those folders, a folder inside one of them, or a folder one of them sits inside is refused, with a message naming the folder to pick instead. The check follows links before it compares, so a link into one of those folders is refused the same way. The service checks again when a tool runs, so a settings value written some other way cannot get around it.

## Where the search index lives

Searching uses an index Aman builds from your notes and keeps up to date on a schedule and when files change. The index lives in Aman's app data folder, in a folder named `notes-folder-index`. Nothing for the index is written into your notes folder.

## Which installs it works on

A notes folder works on the npx install and on an install built from the source.

Note: The Docker install cannot use a notes folder yet. On that install Aman runs in a container, and no folder on your computer is passed through to it, so a folder path cannot be found. Aman Setup on Windows uses Docker, so it cannot use a notes folder yet either.

## To connect your notes folder

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Notes folder** and click **Connect**.
3. In **Folder**, type the path of the folder your notes live in, on the computer Aman runs on.
4. In **Inbox file**, type the name of the file new entries go to, or keep the name that is there.
5. Click **Connect**. The panel checks the folder first, then says it is connected and how many notes the folder holds.

Note: The folder can be one a sync app keeps up to date, such as Syncthing or Nextcloud. Obsidian does not need to be running, and no Obsidian plugin is needed. Aman reads the files themselves.

## To stop using the folder

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Notes folder** and click **Manage**.
3. Click **Remove**, then click **Remove folder**.

Note: Removing the folder changes nothing inside it. Aman forgets the path and stops looking at your notes.
