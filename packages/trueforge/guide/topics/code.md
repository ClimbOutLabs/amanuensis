---
id: code
title: Reading files and running code
covers:
---

Aman can read files and run code in a sandbox, a small separate space on your computer. For example, ask Aman to add up your expenses by category and draw a chart.

The sandbox must be set up first. Open Settings, then Sandbox. The "Read files and run code" card only appears once the sandbox is ready.

Code runs only inside the sandbox. Anything Aman writes to a file there stays in the sandbox until you ask it to move the file.

Sometimes code needs a package that is not installed yet, for example a chart library. Aman can download packages from the public package sites (PyPI, npm, the Go package site and crates.io) through its own mirrors, never straight from the sandbox to the internet. The first time a chat wants to download, Aman asks you. In a chat that is working on a project, your answer covers that project. In a chat without a project, your answer covers your chats without a project, including chats run on a schedule. You can change your mind at any time: open Settings, then Sandbox, and use the switches under "Package downloads". Turning a switch off stops downloads in that scope at once. Publishing or uploading a package is never possible this way, only downloading.
