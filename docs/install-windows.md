# Install on Windows

Aman Setup is one program that installs everything. You don't need a terminal, WSL, Git or a Linux window.

It takes about an hour on a computer with nothing installed yet. Most of that is waiting while Docker Desktop downloads and Aman builds. You answer four questions near the start, and the rest runs on its own.

Using another computer? Follow [Install on a Mac](install-mac.md) or [Install on Linux](install-linux.md) instead.

!!! note "Before you start"

    - **Windows:** Windows 11, or Windows 10 version 22H2.
    - **Disk space:** about 20 GB free.
    - **Memory:** 8 GB at the least, and 16 GB is better. Aman runs inside Docker, a free program, and Docker needs 6 GB of memory to itself.
    - **Virtualization turned on:** this is a setting in the computer's firmware that lets Docker run. It is on for almost every PC sold in the last few years. If Docker Desktop says it is off, [Microsoft's page](https://learn.microsoft.com/en-us/windows/wsl/troubleshooting#error-0x80370102-the-virtual-machine-could-not-be-started-because-a-required-feature-is-not-installed) shows how to turn it on.
    - **An API key for an AI model:** a key from Together AI, OpenAI, Anthropic or Google Gemini, made on that company's website. You add it in Aman after the install. This is the only part that costs money, and that company bills you, not Aman.

## Step 1: download Aman Setup

Get `Aman-Setup.exe` from the [latest release](https://github.com/ClimbOutLabs/amanuensis/releases/latest).

If that page lists no release, Aman Setup is not out yet. Check again later.

??? note "Check that the download is really from us"

    You can check the file against the signed list on the release page before you run it.

    1. From the same release page, download `manifest.json` and `manifest.json.minisig` into the folder that holds `Aman-Setup.exe`.
    2. Open PowerShell in that folder and paste these two lines. The first checks the list's signature with [minisign](https://github.com/jedisct1/minisign), using the Aman release key from [SECURITY.md](../SECURITY.md#checking-a-download). The second prints the hash of the file:

        ```powershell
        minisign -Vm manifest.json -P RWR8aR0vofffsH8dRDfeCxHcPAo2hBKQp6W9krptCFjneeXPDr+ZB0wr
        Get-FileHash .\Aman-Setup.exe
        ```

    3. The first must say the signature is verified. The hash the second prints must match the one next to `Aman-Setup.exe` in `manifest.json`.

    Every release page also prints the release key and these steps. `SHA256SUMS` on the release page lists the same hashes. On its own, it only shows that the file was not damaged on the way, not who made it.

## Step 2: run it

Double-click `Aman-Setup.exe`. A window opens where Aman Setup shows what it is doing and asks its questions.

!!! note "Windows says \"Windows protected your PC\""

    If Windows shows a blue **Windows protected your PC** box, choose **More info**, then **Run anyway**.

    The box appears because Aman Setup is not signed with a Windows publisher certificate, so Windows shows the publisher as unknown. It doesn't mean anything is wrong with the file.

## Step 3: let it install Docker Desktop

If Docker Desktop is already on the computer, Aman Setup uses it, and starts it if it is not running.

If not, Aman Setup downloads it from Docker, checks that the download is signed by Docker Inc, and installs it. Docker Desktop then needs the computer to restart. Aman Setup says:

> Docker Desktop needs your computer to restart before it can run. Restart your computer, and Aman Setup will open again by itself and carry on.

1. Restart the computer.
2. Sign back in. Aman Setup opens again by itself and says `Continuing where it left off.`
3. If Docker Desktop shows its own welcome or terms window the first time it starts, accept it so Docker can finish starting.

If Aman Setup can't open again by itself, it says so before the restart. In that case, open the Aman Setup download again from where you saved it, usually your Downloads folder.

## Step 4: answer four questions

Aman Setup checks that Docker has enough memory. Then it asks four questions, one at a time:

1. `Your email, used to sign in:` This is only your sign-in name. Nothing is sent to it.
2. `Choose a password (at least 8 characters, not shown):` It also needs a number and a symbol, like @ # $ %. Then it asks `Type it again:`. Nothing shows while you type.
3. `Paste your model key (not shown):` This question is for a Nebius Token Factory key. If you have one, paste it. If your key is from another company, such as Together AI, press ++enter++ to skip. You add it later in Aman.
4. `Also use Aman from your phone and other devices on your home Wi-Fi? (yes or no):` Answer `yes` or `no`. You can change this later.

Nothing else is asked. Aman Setup then downloads the newest Aman and builds it on your computer, with daily backups and a secure (https) address.

This is the long part. Leave the window open. It keeps the computer awake until it is done.

Near the end, Windows asks two things in its own boxes. Choose **Yes** both times:

- Whether to trust Aman's certificate, so your browser opens Aman at its secure address without a warning.
- If you answered yes to the phone question, whether to let devices on your home network through the firewall. Aman Setup then prints the address and a code to scan with your phone.

## Step 5: open Aman

When it finishes, Aman opens in your browser, and a short **Getting started** page opens beside it. Aman Setup says `Aman is installed, and the getting started page is open in your browser.`

1. Sign in with the email and password from step 4.
2. Read the Aman Setup window. When it says `Press Enter to close this window.`, press ++enter++.

Your Start menu now has **Aman**, **Check Aman**, **Update Aman**, **Backups** and **Remove Aman**. It also has **Use Aman on my phone** if you answered yes to the phone question.

Next, [set up Aman](../packages/trueforge/guide/topics/first-steps.md): add your AI model and try your first chat.

## Use Aman day to day

- **Open Aman:** choose **Aman** in the Start menu. It starts Docker Desktop if it needs to, waits for Aman to answer, and opens it in your browser.
- **On your phone:** if you said yes in step 4, choose **Use Aman on my phone** in the Start menu. It prints the address and a code to scan. Your phone must be on the same Wi-Fi. If you said no, open **PowerShell** from the Start menu and run `aman network open`. To close Aman to your home network again, run `aman network close`.
- **Update:** choose **Update Aman** in the Start menu. It asks once before it downloads anything, and it keeps your data. See [Update Aman](commands.md#update-aman).
- **Backups:** Aman makes a backup every day at 03:30 while you are signed in to Windows, and keeps the last seven. **Backups** in the Start menu opens the folder. [Backups](backup.md) says what a backup holds and how to go back to one.
- **Check:** **Check Aman** runs a health check on the computer and on Aman. If something is off, it says the one thing to do.

## If something goes wrong

Every message Aman Setup prints says what happened and the one thing to do next. Do that, then open `Aman-Setup.exe` again. It carries on from where it stopped.

| Aman Setup says                                                                | What to do                                                                                                                                                                        |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Docker Desktop needs your computer to restart before it can run.`             | Restart. Aman Setup opens again by itself.                                                                                                                                        |
| `Docker Desktop did not start.`                                                | Open Docker Desktop from the Start menu and wait until it says it is running. Then open Aman Setup again.                                                                         |
| `Docker has less than 6 GB of memory to work with on this computer.`           | Open Docker Desktop, choose **Settings**, then **Resources**, and give it at least 6 GB. Then open Aman Setup again.                                                              |
| `The Docker Desktop download did not come from Docker Inc, so it was not run.` | Download Docker Desktop yourself from [Docker's Windows install page](https://docs.docker.com/desktop/setup/install/windows-install/) and install it. Then open Aman Setup again. |
| `The setup stopped before it finished.`                                        | Open Aman Setup again. It carries on from where it stopped.                                                                                                                       |

!!! warning "Aman Setup never asks for your Windows password"

    The only boxes Windows shows during the install are its own requests for permission: to install Docker Desktop, to trust Aman's certificate, and to change the firewall for your phone. If anything asks for a password or an account you didn't expect, close the window and [tell us](https://github.com/ClimbOutLabs/amanuensis/issues).

If a step still doesn't work the way this page says, [open an issue](https://github.com/ClimbOutLabs/amanuensis/issues) and say which step it was.

## Remove Aman

1. Choose **Remove Aman** in the Start menu. It first says what it removes: your instances and everything they keep (chats, memory, files and settings), the Aman images in Docker Desktop, the aman command, the Start menu entries, the daily backup task, the home network rule, and the certificate Aman added.
2. It asks `Remove Aman and delete all of its data?` Type `yes` to go ahead. Anything else removes nothing.
3. It asks `Delete your backups folder … too? A last backup is made in it first unless you say yes.` Type `yes` to delete the backups as well. Anything else keeps them, with one last backup made first.
4. If Windows asks for permission to change the firewall, choose **Yes**.

At the end, it says `Aman is removed from this computer.`, and where your backups are if you kept them.

!!! warning

    Removing Aman deletes your chats, memory and settings, and you can't undo it.

Docker Desktop stays installed, because other programs may use it. If nothing else uses it, remove it in Windows **Settings**, under **Apps**.

If the removal stops part way, it says why. Do what it says, then choose **Remove Aman** again. It carries on from where it stopped.

## Install from the source code instead

If you would rather run Aman from its source code, for example to change it, use WSL 2 with Ubuntu and Docker Desktop's WSL integration. Clone the repository inside Ubuntu and run `./installer/install.sh`.

This is the path for developers, and it has more steps. [Windows from source](install.mdx#windows-from-source) in the full install guide covers it. Most people should use Aman Setup above.
