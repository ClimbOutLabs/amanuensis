---
id: notes-folder
title: Your notes folder
covers: route:notesFolder
---

You can point Aman at a folder of your Markdown notes, such as the vault you open in Obsidian. Aman can then search your notes and read them in a chat, add entries to one inbox file in the folder, and make new notes. Aman never changes or deletes a note you wrote.

## To connect your notes folder

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Notes folder** and click **Connect**.
3. In **Folder**, type the path of the folder your notes live in, on the computer Aman runs on.
4. In **Inbox file**, type the name of the file new entries go to, or keep the name that is there.
5. Click **Connect**. The panel checks the folder first, then says it is connected and how many notes the folder holds.

Note: The folder can be one a sync app keeps up to date, such as Syncthing or Nextcloud. Obsidian does not need to be running, and no Obsidian plugin is needed. Aman reads the files themselves.

Note: The Docker install cannot use a notes folder yet. On that install Aman runs in a container, and no folder on your computer is passed through to it, so a folder path cannot be found. Aman Setup on Windows uses Docker, so it cannot use a notes folder yet either. A notes folder works on the npx install and on an install built from the source.

Note: The folder cannot be one of the folders Aman keeps its own data in, or a folder inside one of them. Those are the folder for Aman's memory, the folder for persona knowledge, the app data folder that holds Aman's database, and the folder the sandbox slot workspaces live under. If you pick one of those folders, the panel says so and names the folder to pick instead: the one that holds your notes.

Note: To search your notes, Aman keeps an index of them in its app data folder, in a folder named notes-folder-index. Nothing for the index is written into your notes folder.

## To use your notes in a chat

Ask about your notes in any chat, such as what you wrote about a trip or where an idea is written down. Aman searches the notes and reads the ones that match. To have something kept, ask Aman to add it to your inbox or to make a new note. Once a chat has read things written by other people, adding to your notes asks first with a card, because the write may have been asked for by something Aman read rather than by you.

Note: Aman adds an inbox entry under a heading with the date and time, so a file your sync app is also updating keeps both sets of words. If you ask Aman to change a note, it adds the new words as an inbox entry or a new note instead, and says that is what it did.

## To change the folder or the inbox file

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Notes folder** and click **Manage**.
3. Click **Change folder**.
4. Type the new **Folder** or **Inbox file**, then click **Connect**.

## To stop using the folder

1. Click **More** in the left bar, click **Settings**, then click **Connectors**.
2. Find **Notes folder** and click **Manage**.
3. Click **Remove**, then click **Remove folder**.

Note: Removing the folder changes nothing inside it. Aman forgets the path and stops looking at your notes.

For the other connectors on the same page, see Connecting your email and calendar.
