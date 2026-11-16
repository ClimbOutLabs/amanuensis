---
id: code
title: Run code
covers: settings:sandbox, route:runCode, route:sandboxProvider, route:gitCommitIdentity
---

Aman can write and run small programs for you, to work out numbers, sort data or draw a chart. For example, ask it to add up your expenses by category and draw a chart. The code runs in the sandbox: a walled-off space on your computer with no internet access, where nothing it does can reach your own files or accounts.

How to get there: Just ask in any chat. To check the sandbox, click **More** in the left bar, then **Settings**, then **Sandbox**.

## Ask Aman to run code

1. Click **Chats**, then click **New chat**.
2. Ask for the result you want, such as "Here are my bills for March. Add them up by category and draw a pie chart."
3. Aman writes the code, runs it in the sandbox and shows you the result.

You don't need to read or write any code yourself. To work with a file you have, attach it to your message first. See [Files and pictures](files.md).

## Check that the sandbox is ready

1. Click **More** in the left bar, then **Settings**, then **Sandbox**.
2. The status card says whether the sandbox is ready. If it is off, it says why and what to do.
3. After you fix the cause, click **Re-check**.

The same page shows the limits for each run: how long code may run, and how much memory and disk space it may use.

If the sandbox is off in one chat, click **Add-ons** in the message box. The **Sandbox** switch there says why.

## Download and install packages

Sometimes code needs a package that isn't in the sandbox yet, such as a chart library. A package is a piece of ready-made code that other code builds on.

Aman can download packages from the public package sites (PyPI, npm, the Go package site and crates.io). It always goes through its own download-only mirrors, never straight from the sandbox to the internet. So nothing can be published or uploaded from the sandbox.

The first time a chat wants to download, Aman asks you:

- In a chat that is working on a project, your answer covers that project.
- In a chat without a project, your answer covers all your chats without a project, including scheduled runs.

To change your mind:

1. Click **More** in the left bar, then **Settings**, then **Sandbox**.
2. Under **Package downloads**, turn each switch on or off. **Chats without a project** covers chats that are not working on a project.

Turning a switch off stops downloads there at once, even in chats that are already running.

Allowing downloads doesn't install anything by itself. Each time Aman wants to install a package, it shows you a card first.

## Choose the name on Git commits

Git is a tool that keeps the history of a project. Each saved step in that history is called a commit, and it carries a name and an email. When Aman saves work with Git in the sandbox, the commit carries your own name, the one under **Personalization**. If you gave no name there, it says "Aman".

To use a different name or email:

1. Click **More** in the left bar, then **Settings**, then **Sandbox**.
2. Under **Name on Git commits**, type the name and the email you want.
3. Click **Save**.

Leave a box empty to go back to what is shown in grey. A change applies from your next message. To have GitHub link the commits to you, use an email from your GitHub account.

## What asks first

With the **Sandbox** switch on under **Settings**, then **Permissions**, Aman can make new files and run the code it wrote in the chat without asking. These still ask first:

- Running code or making a file where package downloads are allowed, because that code can reach the package sites.
- Installing a package.
- Changing a file that already exists, running scripts from your project and running tests.
- Anything that leaves the sandbox.
- Anything in a scheduled run, and in its chat when you type there.

To check every step yourself, turn the **Sandbox** switch off.

## When the sandbox is full

Each sandbox space holds as many chats as its disk fits. When they are all full, the sandbox is off and Aman says so. Delete old chats you no longer need, then try again.

## Good to know

- The files Aman makes in a chat stay in that chat's sandbox between messages. Programs left running in the background stop when their step ends.
- A file Aman made for you can be downloaded from the chat, even after the sandbox has stopped.
- Your model and connector passwords never go into the sandbox.
- For how the sandbox is set up, its limits and its settings, see [Sandbox setup](../../../../docs/sandbox.mdx).

## Related

- [Files and pictures](files.md)
- [Approval cards](approvals.md)
- [Skills](skills.md)
