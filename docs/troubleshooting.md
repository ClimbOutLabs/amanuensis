---
title: 'Troubleshooting'
description: 'What to do when something goes wrong: first steps, then common problems and their fixes.'
---

# Troubleshooting

Find what you see on this page, then do the step under it. Each step names the one thing to do next.

## Start here

Most problems are found by one check.

- **Mac, Linux, and Windows with WSL:** open a new terminal window and run `aman doctor`.
- **Windows with Aman Setup:** choose **Check Aman** in the Start menu.

It checks this computer and every instance, and prints one **Next:** line for each problem, with the command that fixes it. It changes nothing. [The aman command](commands.md#check-that-everything-works) lists its options, and the [install guide](install.mdx#doctor) says what each check means.

Inside Aman, click **Help, I'm stuck** at the top of the screen. The guide checks Aman for a few seconds and tells you what it found. [Getting help](../packages/trueforge/guide/topics/getting-help.md) explains it.

## Installing

**"Docker is installed but not running."** Open Docker Desktop and wait until it says it is running. Then try again.

**Docker has too little memory.** Aman needs Docker to have at least 6 GB. In Docker Desktop, open Settings, then Resources, set Memory to 8 GB, and click Apply. On Linux, close other programs.

**Permission denied on the Docker socket (Linux).** After a fresh Docker install, your user joins the `docker` group, but open terminals do not know yet. Sign out and back in, or restart the computer.

**A port is already in use.** Another program has the port Aman wanted. Stop that program, or add an instance with your own ports: `./installer/install.sh instance add NAME --port N --login-port N`.

**Image downloads fail with a credential error.** Docker's sign-in helper has lost its sign-in. Open Docker Desktop, sign it back in, and run the installer again.

**Out of disk space.** Run `aman doctor disk --fix`. It removes old Aman images and the build cache, and touches nothing that runs. If that is not enough, free space on the computer. The [Try Aman](try-aman.md#what-you-need) page lists how much Aman needs.

**On Windows, Aman Setup did not open again after the restart.** Open the Aman Setup download again from where you saved it, usually your Downloads folder. It carries on where it left off. The [Windows guide](install-windows.md) walks through each step.

## Opening Aman and signing in

**`aman: command not found`.** Open a new terminal window. If it still says so, run `./installer/install.sh command` in the folder you installed from. It puts the command back.

**The page does not load.** Run `aman doctor`. If it says an instance is not running, run `aman doctor instance --fix`. It asks before it restarts the instance.

**The sign-in page says it is unavailable.** On a first install, the sign-in service takes a few seconds to start. Wait, then reload the page. If it still fails, run `aman doctor` and follow the sign-in check's **Next:** line.

**Signing in says the email is not allowed.** Use exactly the email you typed during the install, in lowercase.

**Sign-in or certificate checks fail after the computer slept.** Check that the computer's clock shows the right time, then run `aman doctor` again.

**You forgot your password.** On the computer where Aman is installed, run `aman password`. It asks for a new password twice and signs you out everywhere. To change a password you still know, see [Your sign-in and password](../packages/trueforge/guide/topics/account.md).

## Using Aman from a phone or another computer

**The page says the connection is not private.** That device does not trust your computer yet. On the computer itself, use the `http://localhost` address instead. On a phone or another computer, do the trust step once: the install printed a line that starts "Instead, open this page once on that device", with an address that ends in `/trust`. Open that address on the device and follow the steps for it. On a Mac, Aman opens on that Mac only, so other devices cannot reach it. [Try Aman](try-aman.md) has the details.

**The phone cannot reach Aman at all.** The phone must be on the same Wi-Fi as the computer. Run `aman doctor network`. If it says this computer's address changed, run `aman doctor network --fix` to add the new address. On Windows with Aman Setup, run `aman network open` in PowerShell. [Using Aman from your phone](../packages/trueforge/guide/topics/phone.md) covers the rest.

**After an update, the https address stopped working.** If an update had to move Aman's https port, it printed the new port. Open Aman with that port on each device.

## Chatting

**Aman does not answer.** Aman needs a model before it can answer. Click **More** in the left bar, click **Settings**, then click **Models**, and choose a model you have access to. [Connect a model](models.mdx) explains the choices.

**The model is set but chat says it cannot reach it.** For a hosted model, check the key in **Settings**, then **Models**. For a local model such as Ollama, check that it is running on the same computer.

**Aman cannot run code or read an attachment.** Run `aman doctor sandbox`. If a check fails, run `aman doctor sandbox --fix`. It asks before anything that needs your admin password.

**A card is waiting for your answer.** Aman waits for your OK before it sends, deletes or installs anything. [Approval cards](../packages/trueforge/guide/topics/approvals.md) says what each button does.

**Mail or calendar stopped working.** Click **More** in the left bar, click **Settings**, then click **Connectors**, and look at the card for that account. If it says the sign-in stopped working, click **Manage** and type the details again. A Google account in testing mode signs out every 7 days; the [Google guide](google.mdx) says how to stay signed in.

## Updating and backups

**`aman upgrade` says there is nothing new.** `aman upgrade` uses the copy of the code in the folder you installed from, and does not download the new version itself. Get the newest release into that folder first, then upgrade. [The aman command](commands.md#update-aman) has the exact lines.

**An update failed.** The old version comes back on its own, and your data was backed up first. Run `aman doctor` and follow its **Next:** lines, then run `aman upgrade` again.

**`aman doctor` warns about backups.** Run `aman doctor backup --fix`. It turns on the daily backup and makes one now. [Backups](backup.md) explains where they are kept.

## Still stuck

1. Run `aman doctor` and copy all of what it prints. It contains no passwords and no chats.
2. If a step printed a log file in a red line, keep that file too.
3. In Aman, click **More** at the bottom of the left bar, then **Report a bug**. It makes a report that leaves out passwords and memory, and sends nothing until you click **File on GitHub**.
4. Or [open an issue on GitHub](https://github.com/ClimbOutLabs/amanuensis/issues) and add what you copied. Say what you were doing and what you saw on the screen.
