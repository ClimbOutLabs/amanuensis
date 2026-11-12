---
title: 'Obsidian'
description: 'Connect Obsidian through its Local REST API plugin, so Aman can use your vault on a Docker install, where a notes folder does not work.'
---

Connect Obsidian so Aman can search, read and add to your vault. This is the way to use your notes on a Docker install: the installer on a Mac or Linux, and Aman Setup on Windows. There, Aman runs in a container and can't see a [notes folder](../../packages/trueforge/guide/topics/notes-folder.md) on your computer, but it can reach Obsidian.

!!! note "Before you start"

    You need Obsidian on the same computer as Aman, and about five minutes. You do the first step in Obsidian and the second in Aman.

    Obsidian must be open whenever you want Aman to use your notes. When it's closed, Aman can't reach them.

## Step 1: Turn on the plugin in Obsidian

1. In Obsidian, open **Settings**, then **Community plugins**, and turn community plugins on.
2. Click **Browse**, find **Local REST API**, then click **Install** and **Enable**.
3. Open the plugin's settings and turn on **Enable HTTP server**. Aman can't check the plugin's own https certificate, so it uses the plain address. That address stays on this computer.
4. On Linux only, set **Binding host** to `172.17.0.1`. That's Docker's own address on this computer, so Aman can reach the plugin and other devices on your network can't.
5. Copy the **API key**.

## Step 2: Add Obsidian in Aman

1. In Aman, click **More** in the left bar, then **Settings**, then **Connectors**.
2. Click **Add MCP Server**.
3. Type `obsidian` as the **Name**, and "My notes in Obsidian" as the **Description**.
4. In **URL**, type `http://host.docker.internal:27123/mcp/`. That's how Aman, inside its container, reaches this computer.
5. Under **Auth type**, choose **API key**, and paste the key. Leave **Header name** empty.
6. Click **Add**, then **Test connection**. Aman lists the tools Obsidian offers, or says the one thing to fix.

## How it differs from a notes folder

- **Each tool asks first.** Every Obsidian tool asks for your OK on a card, because Aman doesn't know what a connector you add will do. Click **Always allow everywhere** on the reads you're happy with, such as search and read. See [which tools ask first](../mcp-servers.mdx#which-tools-ask-first).
- **Obsidian can change notes.** The plugin's tools can edit and delete notes. Allow those one at a time.
- **Obsidian must be open.** A notes folder needs only the files. The plugin needs the app running, so it doesn't suit a computer with no screen.
