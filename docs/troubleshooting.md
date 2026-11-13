---
title: 'Troubleshooting'
description: 'What to do when something goes wrong: the first check to run, then common problems and their fixes.'
---

# Troubleshooting

Find what you see on this page, then do the step under it. Each answer names the one thing to do next.

## Start here

Most problems are found by one check.

=== "Mac, Linux and WSL"

    Open a new terminal window and run:

    ```bash
    aman doctor
    ```

=== "Windows with Aman Setup"

    Choose **Check Aman** in the Start menu.

It checks this computer and every instance, and prints one **Next:** line for each problem, with the command that fixes it. It changes nothing. [The aman command](commands.md#check-that-everything-works) lists its options, and the [install guide](install.mdx#doctor) says what each check means.

Inside Aman, click **Help, I'm stuck** at the top of the screen. The guide checks Aman for a few seconds and tells you what it found. [Get help](../packages/trueforge/guide/topics/getting-help.md) explains it.

## Installing

??? question "It says \"Docker is installed but not running.\""

    Open Docker Desktop and wait until it says it's running. Then try again.

??? question "Docker has too little memory"

    Aman needs Docker to have at least 6 GB of memory.

    - Mac and Windows: in Docker Desktop, open **Settings**, then **Resources**. Set **Memory** to 8 GB and click **Apply**.
    - Linux: close other programs.

??? question "Permission denied on the Docker socket (Linux)"

    After a fresh Docker install, your user joins the `docker` group, but open terminals don't know that yet. Sign out and back in, or restart the computer.

??? question "A port is already in use"

    Another program has the port Aman wanted. Stop that program. Or add an instance with your own ports:

    ```bash
    ./installer/install.sh instance add NAME --port N --login-port N
    ```

??? question "Image downloads fail with a credential error"

    Docker's sign-in helper has lost its sign-in. Open Docker Desktop, sign in again, and run the installer again.

??? question "Out of disk space"

    Run `aman doctor disk --fix`. It removes old Aman images and the build cache, and touches nothing that runs. If that isn't enough, free up space on the computer. [Try Aman](try-aman.md#what-you-need) lists how much space Aman needs.

??? question "On Windows, Docker Desktop asks for a restart"

    Restart the computer. After you sign back in, Aman Setup opens again by itself and carries on. If it doesn't, see the next question.

??? question "On Windows, Aman Setup didn't open again after the restart"

    Open the Aman Setup download again from where you saved it, usually your Downloads folder. It carries on where it left off. The [Windows guide](install-windows.md) walks through each step.

## Opening Aman and signing in

??? question "The terminal says `aman: command not found`"

    Open a new terminal window. If it still says so, run `./installer/install.sh command` in the folder you installed from. It puts the command back.

??? question "The page doesn't load"

    Run `aman doctor`. If it says an instance isn't running, run `aman doctor instance --fix`. It asks before it restarts the instance.

??? question "The sign-in page says it's unavailable"

    On a first install, the sign-in service takes a few seconds to start. Wait, then reload the page. If it still fails, run `aman doctor` and follow the sign-in check's **Next:** line.

??? question "Signing in says the email isn't allowed"

    Type exactly the email you used during the install, in lowercase.

??? question "Sign-in or certificate checks fail after the computer slept"

    Check that the computer's clock shows the right time. Then run `aman doctor` again.

??? question "I forgot my password"

    On the computer where Aman is installed, run `aman password`. It asks for a new password twice and signs you out everywhere. [Password and sign-in](../packages/trueforge/guide/topics/account.md) has the other ways, and shows how to change a password you still know.

## Using Aman from a phone or another computer

??? question "The page says the connection isn't private"

    That device doesn't trust your computer yet. On the computer itself, use the `http://localhost` address instead.

    On a phone or another computer, do the trust step once:

    1. Find the line the install printed that starts "Instead, open this page once on that device". It has an address that ends in `/trust`.
    2. Open that address on the device.
    3. Follow the steps for it.

    On a Mac, Aman opens on that Mac only, so other devices can't reach it. [Try Aman](try-aman.md) has the details.

??? question "The phone can't reach Aman at all"

    The phone must be on the same Wi-Fi as the computer.

    1. Run `aman doctor network`.
    2. If it says this computer's address changed, run `aman doctor network --fix` to add the new address.

    On Windows with Aman Setup, run `aman network open` in PowerShell instead.

    [Phone and other devices](../packages/trueforge/guide/topics/phone.md) covers the rest.

??? question "After an update, the https address stopped working"

    If an update had to move Aman's https port, it printed the new port. Open Aman with that port on each device.

## Chatting

??? question "Aman doesn't answer"

    Aman needs a model before it can answer. Click **More** in the left bar, click **Settings**, then click **Models**, and choose a model you have access to. [Connect a model](models.mdx) explains the choices.

??? question "The model is set, but the chat says it can't reach it"

    - For a hosted model, check the key in **Settings**, then **Models**.
    - For a local model such as Ollama, check that it's running on the same computer.

??? question "Aman can't run code or read an attachment"

    Run `aman doctor sandbox`. If a check fails, run `aman doctor sandbox --fix`. It asks before anything that needs your admin password.

??? question "A card is waiting for my answer"

    Aman waits for your OK before it sends, deletes or installs anything. The card stays until you answer it. [Approval cards](../packages/trueforge/guide/topics/approvals.md) says what each button does.

??? question "Aman says something was refused, and no card showed"

    Offline mode may be on. Click **More** in the left bar, click **Settings**, then click **Permissions**, and check the **Offline mode** switch. [Permissions and offline mode](../packages/trueforge/guide/topics/permissions.md) explains it.

??? question "Mail or calendar stopped working"

    Click **More** in the left bar, click **Settings**, then click **Connectors**, and look at the card for that account. If it says the sign-in stopped working, click **Manage** and type the details again.

    A Google account in testing mode signs out every 7 days. The [Google guide](google.mdx) shows how to stay signed in.

## Updating and backups

??? question "`aman upgrade` says there's nothing new"

    `aman upgrade` uses the copy of the code in the folder you installed from. It doesn't download the new version itself. Get the newest release into that folder first, then upgrade. [Update Aman](commands.md#update-aman) has the exact lines.

??? question "An update failed"

    The old version comes back on its own, and your data was backed up first. Run `aman doctor` and follow its **Next:** lines. Then run `aman upgrade` again.

??? question "`aman doctor` warns about backups"

    Run `aman doctor backup --fix`. It turns on the daily backup and makes one now. [Back up and restore](backup.md) explains where backups are kept.

## Still stuck

1. Run `aman doctor` and copy everything it prints. It contains no passwords and no chats.
2. If a step printed a log file in a red line, keep that file too.
3. In Aman, click **More** at the bottom of the left bar, then **Report a bug**. It makes a report that leaves out passwords and memory, and sends nothing until you click **File on GitHub**.
4. Or [open an issue on GitHub](https://github.com/ClimbOutLabs/amanuensis/issues) and add what you copied. Say what you were doing and what you saw on the screen.
