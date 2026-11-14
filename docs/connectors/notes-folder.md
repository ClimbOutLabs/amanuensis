---
title: 'Notes folder setup'
description: 'How the Notes folder connector reads, searches and adds to a folder of Markdown notes, and what it never changes.'
---

The Notes folder connector points Aman at a folder of Markdown notes, such as the vault you open in Obsidian. There's no account and no secret. Settings holds only the folder path and the name of one inbox file.

For the steps to connect, change or remove the folder, see [Your notes folder](../../packages/trueforge/guide/topics/notes-folder.md).

## Which installs it works on

A notes folder works on the npx install and on an install built from the source.

!!! note "Not in Docker"

    The Docker install can't use a notes folder. There, Aman runs in a container, and no folder on your computer is passed through to it, so a folder path can't be found. The installer on a Mac or Linux and Aman Setup on Windows both use Docker. On those installs, connect Obsidian through its Local REST API plugin instead. The steps are in [Obsidian](obsidian.md). Obsidian is then an ordinary connector: each tool asks first, and Obsidian must be open.

## What Aman reads

- **Search.** Aman searches the folder by meaning and by words, and answers from the notes it finds.
- **Read.** Aman reads one note in full when a chat needs the whole note.

Note text reaches the model marked as untrusted, like mail. Words in a note never become instructions.

## What Aman writes

Aman can only add. It never changes or deletes a note you wrote.

- **Add to the inbox.** Aman adds one entry, under a heading with the date and time, to the one file you name in Settings. The default name is `Aman inbox.md`. The entry is added at the end of the file, after a check that the file didn't change while the entry was prepared. So a sync that lands at the same moment is never overwritten.
- **Make a new note.** Aman makes a note that doesn't exist yet. A name that's already taken is refused, never overwritten.

Both writes run without an approval card while the request is yours, the same way reminders do. Once a chat has read content that isn't your own words, a write asks first with a card, because the request may have come from something Aman read. In a scheduled run, with nobody to answer, a write like that is skipped.

## The folder must sit outside Aman's own data

The folder can't overlap any folder Aman keeps its own data in:

- its memory folder
- its persona knowledge folder
- the app data folder that holds its database
- the folder the sandbox slot workspaces live under

Picking one of those folders, a folder inside one of them, or a folder that one of them sits inside is refused. The message names the folder to pick instead.

The check follows links before it compares, so a link into one of those folders is refused the same way. Aman checks again each time a tool runs, so a setting written some other way can't get around it.

## Where the search index lives

Searching uses an index Aman builds from your notes. Aman keeps it up to date on a schedule and when files change. The index lives in Aman's app data folder, in a folder named `notes-folder-index`. Nothing for the index is written into your notes folder.
