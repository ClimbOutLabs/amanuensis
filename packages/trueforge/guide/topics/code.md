---
id: code
title: Reading files and running code
covers: settings:sandbox, route:runCode, route:sandboxProvider, route:sandboxWorkspace
---

Aman can read files and run code in a sandbox, a small separate space on your computer. For example, ask Aman to add up your expenses by category and draw a chart.

The sandbox must be set up first. Open Settings, then Sandbox. The "Read files and run code" card only appears once the sandbox is ready.

If the sandbox is off in a chat, the Add-ons list in the message box says why. If a new chat says the sandbox storage is almost full, delete old chats you no longer need, then try again. If the message also says to free disk space, removing large files from this computer helps too. Chats that already used the sandbox keep working.

Code runs only inside the sandbox. Anything Aman writes to a file there stays in the sandbox until you ask it to move the file.

Sometimes code needs a package that is not installed yet, for example a chart library. Aman can download packages from the public package sites (PyPI, npm, the Go package site and crates.io) through its own mirrors, never straight from the sandbox to the internet. The first time a chat wants to download, Aman asks you. In a chat that is working on a project, your answer covers that project. In a chat without a project, your answer covers your chats without a project, including chats run on a schedule. You can change your mind at any time: open Settings, then Sandbox, and use the switches under "Package downloads". Turning a switch off stops downloads in that scope at once. Publishing or uploading a package is never possible this way, only downloading.

Each chat that runs code gets its own workspace in the sandbox. To see them, open Settings, then Sandbox, and look at the "Chat workspaces" card. It lists each workspace with how much space it takes and when it was last used, and how much room is left. Your own chats show by title, and your incognito chats show as "Incognito chat", without their title. Another person's chat shows as "Another person's chat". "A workspace with no chat" usually means its chat was deleted but the workspace stayed behind. The card only shows; nothing there deletes a workspace.
