# Installing Amanuensis on Windows

Aman Setup is one program that installs everything. You do not need a terminal, WSL, Git, or a Linux window. It takes about an hour on a computer with nothing installed yet, most of it waiting while Docker Desktop downloads and Aman builds. You answer four questions near the start, and the rest runs on its own.

On a Mac, follow [Install on a Mac](install-mac.md). On Linux, follow [Install on Linux](install-linux.md).

## Before you start

- Windows 11, or Windows 10 version 22H2.
- About 20 GB of free disk space.
- 8 GB of memory at the least, and 16 GB is better. Aman runs inside Docker, and Docker needs 6 GB of memory to itself.
- Virtualization turned on in the computer's firmware. It is on for almost every PC sold in the last few years. If Docker Desktop says it is off, [Microsoft's page](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#error-0x80370102-the-virtual-machine-could-not-be-started-because-a-required-feature-is-not-installed) shows how to turn it on.
- A model key from Together AI or another provider, if you have one. You can also add it later in Settings.

## Install

**1. Download Aman Setup.** Get `Aman-Setup.exe` from the [latest release](https://github.com/ClimbOutLabs/amanuensis/releases/latest). If that page lists no release, Aman Setup is not out yet; check again later.

**2. Run it.** Double-click `Aman-Setup.exe`. A window opens where Aman Setup shows what it is doing and asks its questions.

If Windows shows a blue **Windows protected your PC** box, choose **More info**, then **Run anyway**. The box appears because Aman Setup is not signed with a Windows publisher certificate, so Windows shows the publisher as unknown. It does not mean anything is wrong with the file.

To be sure the file is ours before you run it, check it against the signed list on the release page:

1. From the same release page, download `manifest.json` and `manifest.json.minisig` into the folder that holds `Aman-Setup.exe`.
2. Check the list's signature with [minisign](https://github.com/jedisct1/minisign), using the release key from [SECURITY.md](../SECURITY.md#checking-a-download). It must say the signature is verified:

   ```
   minisign -Vm manifest.json -P <release key>
   ```

3. In PowerShell, in that folder, run `Get-FileHash .\Aman-Setup.exe`. The hash it prints must match the one next to `Aman-Setup.exe` in `manifest.json`.

Every release page also prints the release key and these steps. `SHA256SUMS` on the release page lists the same hashes, but on its own it only shows the file was not damaged on the way, not who made it.

**3. Let it install Docker Desktop.** If Docker Desktop is already on the computer, Aman Setup uses it, and starts it if it is not running. If not, Aman Setup downloads it from Docker, checks that the download is signed by Docker Inc, and installs it. Docker Desktop then needs the computer to restart. Aman Setup says:

> Docker Desktop needs your computer to restart before it can run. Restart your computer, and Aman Setup will open again by itself and carry on.

Restart. After you sign back in, Aman Setup opens again by itself and says **Continuing where it left off.** If it does not, Aman Setup says so before the restart; then open the Aman Setup download again from where you saved it, usually your Downloads folder. If Docker Desktop shows its own welcome or terms window the first time it starts, accept it so Docker can finish starting.

**4. Answer four questions.** Aman Setup checks that Docker has enough memory, then asks, one at a time:

1. `Your email, used to sign in:` This is only your sign-in name. Nothing is sent to it.
2. `Choose a password (at least 8 characters, not shown):` It also needs a number and a symbol, like @ # $ %. Then `Type it again:`. Nothing shows while you type.
3. `Paste your model key (not shown):` Paste it, or press Enter to skip and add it later under **Settings, Models**.
4. `Also use Aman from your phone and other devices on your home Wi-Fi? (yes or no):` Answer `yes` or `no`. You can change this later.

Nothing else is asked. Aman Setup then downloads the newest Aman and builds it on your computer, with daily backups and a secure (https) address. This is the long part. Leave the window open; it keeps the computer awake until it is done.

Near the end, Windows asks two things in its own boxes. Choose **Yes** both times:

- whether to trust Aman's certificate, so your browser opens Aman at its secure address without a warning;
- if you answered yes to the phone question, whether to let devices on your home network through the firewall. Aman Setup then prints the address and a code to scan with your phone.

**5. Open Aman.** When it finishes, Aman opens in your browser and a short **Getting started** page opens beside it. Aman Setup says `Aman is installed, and the getting started page is open in your browser.` Sign in with the email and password from step 4. The Aman Setup window then says `Press Enter to close this window.`; press Enter when you have read it.

Your Start menu now has **Aman**, **Check Aman**, **Update Aman**, **Backups** and **Remove Aman**, and **Use Aman on my phone** if you answered yes to the phone question.

Then [add your AI model](try-aman.md#step-4-add-your-ai-model) if you skipped the key, and try your first chat.

## Using Aman day to day

- **Opening Aman:** choose **Aman** in the Start menu. It starts Docker Desktop if it needs to, waits for Aman to answer, and opens it in your browser.
- **On your phone:** if you said yes in step 4, **Use Aman on my phone** in the Start menu prints the address and a code to scan. Your phone must be on the same Wi-Fi. If you said no, open **PowerShell** from the Start menu and run `aman network open`. To close Aman to your home network again, run `aman network close`.
- **Updating:** run **Update Aman** from the Start menu. It asks once before it downloads anything, and it keeps your data.
- **Backups:** Aman makes a backup every day at 03:30 while you are signed in to Windows, and keeps the last seven. **Backups** in the Start menu opens the folder. [What a backup holds](backup.md) says what is in it.
- **Checking the computer:** **Check Aman** runs a health check on the computer and on Aman, and says the one thing to do if something is off.

## If something goes wrong

Every message Aman Setup prints says what happened and the one thing to do next. Do that, then open `Aman-Setup.exe` again; it carries on from where it stopped. The common ones:

- `Docker Desktop needs your computer to restart before it can run.` Restart. Aman Setup opens again by itself.
- `Docker Desktop did not start.` Open Docker Desktop from the Start menu, wait until it says it is running, then open Aman Setup again.
- `Docker has less than 6 GB of memory to work with on this computer.` Open Docker Desktop, choose **Settings**, then **Resources**, give it at least 6 GB, then open Aman Setup again.
- `The Docker Desktop download did not come from Docker Inc, so it was not run.` Download Docker Desktop from [Docker's Windows install page](https://docs.docker.com/desktop/setup/install/windows-install/) yourself, install it, then open Aman Setup again.
- `The setup stopped before it finished.` Open Aman Setup again; it carries on from where it stopped.

Aman Setup never asks for your Windows password itself. The only boxes Windows shows during the install are its own requests for permission: to install Docker Desktop, to trust Aman's certificate, and to change the firewall for your phone. If anything asks for a password or account you did not expect, close the window and [tell us](https://github.com/ClimbOutLabs/amanuensis/issues).

If a step still does not work the way this page says, [open an issue](https://github.com/ClimbOutLabs/amanuensis/issues) and say which step it was.

## Removing Aman

Choose **Remove Aman** in the Start menu. It first says what it removes: your instances and everything they keep (chats, memory, files and settings), the Aman images in Docker Desktop, the aman command, the Start menu entries, the daily backup task, the home network rule and the certificate Aman added. Then it asks two questions:

1. `Remove Aman and delete all of its data?` Type `yes` to go ahead. Anything else removes nothing.
2. `Delete your backups folder … too? A last backup is made in it first unless you say yes.` Type `yes` to delete the backups as well. Anything else keeps them, with one last backup made first.

If Windows asks for permission to change the firewall, choose **Yes**. At the end it says `Aman is removed from this computer.`, and where your backups are if you kept them.

Docker Desktop stays installed, because other programs may use it. If nothing else uses it, remove it in Windows **Settings**, under **Apps**.

If the removal stops part way, it says why. Do what it says, then choose **Remove Aman** again; it carries on from where it stopped.

## Installing from the source code instead

If you would rather run Aman from the repository, for example to change it, use WSL 2 with Ubuntu and Docker Desktop's WSL integration, clone the repository inside Ubuntu, and run `./installer/install.sh`. This is the developer path and has more steps; [Windows from source](install.mdx#windows-from-source) in the full install guide covers it. Most people should use Aman Setup above.
