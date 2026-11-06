# Installing Amanuensis on Windows

On Windows, you install Aman with **Aman Setup**: one download that sets everything up. It installs Docker Desktop if your computer does not have it, asks you four questions, and opens Aman in your browser when it is done. You do not need a terminal, Ubuntu or Git.

Most of the time goes on downloading and building, while Aman Setup works on its own. Plan for about an hour on a computer that has nothing installed yet, including one restart.

## What you need

- **Windows 11, or Windows 10 version 22H2**, with the latest updates.
- **16 GB of memory.** Docker needs at least 6 GB of it for Aman, and Aman Setup stops and tells you how to fix it if Docker has less.
- **About 20 GB of free disk space.**
- **A model key, if you have one.** Aman Setup asks for it, but you can leave it empty and add it later. [After you install](../README.md#after-you-install) explains how to get a Together AI key.

## Install

**1. Download Aman Setup.** Open the [latest release](https://github.com/ClimbOutLabs/amanuensis/releases/latest) and download **Aman-Setup.exe**.

**2. Open it.** Double-click **Aman-Setup.exe** in your Downloads folder. A window opens where Aman Setup shows what it is doing and asks its questions.

Windows may show a blue box that says **Windows protected your PC**, because this download is not signed yet. Choose **More info**, then **Run anyway**.

**3. Let it install Docker Desktop.** Aman runs inside Docker Desktop, a free program. If your computer already has it, Aman Setup uses it and starts it if it is not running. If not, Aman Setup downloads it, checks that the download really comes from Docker Inc, and installs it. If Windows asks whether to let it make changes to your computer, choose **Yes**.

Docker Desktop usually needs a restart after it is installed. Aman Setup says:

> Docker Desktop needs your computer to restart before it can run. Restart your computer, and Aman Setup will open again by itself and carry on.

Restart, and sign in to Windows again. Aman Setup opens by itself and says **Continuing where it left off.** If Docker Desktop shows its own welcome or terms window the first time it starts, accept it so Docker can finish starting.

**4. Answer four questions.** Aman Setup asks them one at a time:

1. **Your email, used to sign in:** This is your sign-in name. Nothing is sent to it.
2. **Choose a password (at least 8 characters, not shown):** It also needs a number and a symbol, such as @ or #. You type it twice, and nothing shows while you type.
3. **Paste your model key (not shown):** Paste your key and press Enter, or press Enter to leave it empty. Without a key, Aman opens but cannot answer until you add one in **Settings, Models**.
4. **Also use Aman from your phone and other devices on your home Wi-Fi? (yes or no):** Type `yes` to use Aman from your phone at home.

**5. Wait while it sets up Aman.** Aman Setup downloads the newest Aman and builds it on your computer, with daily backups and a secure (https) address. This is the long part, and it shows its progress as it goes. Leave the window open; your computer stays awake until it is done.

Near the end, Windows asks two things. Choose **Yes** both times:

- whether to trust the certificate, so your browser opens Aman at its secure address without a warning;
- if you said yes to the phone question, whether to let devices on your home network through the firewall. Aman Setup then prints the address and a square code to scan with your phone.

**6. Sign in.** Aman opens in your browser, next to a short **Getting started** page. Aman Setup says **Aman is installed, and the getting started page is open in your browser.** Sign in with the email and password from step 4.

Then follow [After you install](../README.md#after-you-install) to add a model key if you skipped it, name your assistant, and connect your email and calendar.

## Your Start menu

Aman Setup adds these entries to the Start menu:

- **Check Aman** checks your computer and Aman, and says the one thing to do for anything that is wrong.
- **Update Aman** updates Aman to the newest version and keeps your chats and settings. It asks once before it downloads anything.
- **Backups** opens the folder where your backups are kept. Aman makes one every day at 03:30 while you are signed in to Windows, and keeps the last seven.
- **Use Aman on my phone** shows the address and the scan code for your phone again. It is there when you answered yes to the phone question.

To open Aman later, go to the address it opened at the first time; bookmark it in your browser. The **Getting started** page is saved in your `AppData\Local\Amanuensis` folder and has the address too. Docker Desktop needs to be running for Aman to answer.

To use Aman on your phone later if you answered no, open **PowerShell** from the Start menu and run `aman network open`. To close it to your home network again, run `aman network close`.

## If something goes wrong

Every message from Aman Setup says what happened and the one thing to do next. Do that, then open **Aman-Setup.exe** again. It carries on from where it stopped. If you are not sure what is wrong, run **Check Aman** from the Start menu.

If a step does not work the way this guide says, [open an issue](https://github.com/ClimbOutLabs/amanuensis/issues) and tell us which step it was and what the window said.

## For developers

To run Aman from a checkout of the code on Windows instead, inside WSL 2 and Ubuntu, follow [Windows from source](install.mdx#windows-from-source) in the full install guide.
