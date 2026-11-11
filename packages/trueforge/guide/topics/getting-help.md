---
id: getting-help
title: Getting help and reporting a bug
covers: command:doctor, command:backup, command:upgrade, command:password, command:uninstall, route:help, route:bugReport
---

## Ask the guide

1. Click **Help, I'm stuck** at the top of the screen. It shows on the main screens, not inside Settings.
2. A new chat opens. The guide checks Aman for a few seconds and tells you what it found.
3. Click the choice that fits: **Setting up a model**, **Connecting email or calendar**, **An approval card**, **Something went wrong** or **Something else**.
4. Or type in the box under the choices, then click **Send message**.

The guide tells you the exact clicks. It cannot change anything for you.

## Report a bug

1. Click **More** at the bottom of the left bar, then click **Report a bug**.
2. Under **What went wrong?**, say what you expected and what happened. You can skip this.
3. To include this chat's messages, tick the box for it. It is off by default.
4. Click **Generate report**.
5. Click **Copy to clipboard**, or click **Download (.json)**, or click **File on GitHub**.

The report leaves out passwords, memory and tool details. It sends nothing until you click **File on GitHub**.

## Things you do in a terminal

Settings has no button for these. In a terminal, type `aman doctor` to check each part of your install. Type `aman backup` to back up your data. Type `aman upgrade` to update Aman. Type `aman password` to set a new password.

On Windows, the Start menu has entries for the common ones, so you do not need a terminal. "Aman" opens Aman in your browser. "Check Aman" checks each part of your install. "Update Aman" updates Aman. "Remove Aman" removes Aman from this computer, the same as typing `aman uninstall`. It asks before it deletes your data, keeps your backups unless you say otherwise, and leaves Docker Desktop installed. When one of these opens a window, the window stays open until you press Enter, so you can read what it says. The one exception is "Aman": its window closes by itself once your browser opens.

When you ask for help, say what you were doing and what you saw on the screen.
