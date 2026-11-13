# Install on a Mac

This guide installs the latest release of Aman on your Mac. It takes about 45 minutes. Most of that is waiting while things download and build. You answer a few questions and choose a password at the start, and then it runs on its own.

Using another computer? Follow [Install on Linux](install-linux.md) or [Install on Windows](install-windows.md) instead.

!!! note "Before you start"

    - **Memory:** your Mac needs 16 GB of memory. 8 GB is the bare minimum, and the first install is slow there.
    - **Disk space:** you need about 20 GB free.
    - **Docker Desktop:** Aman runs inside Docker, a free program. Install [Docker Desktop](https://www.docker.com/products/docker-desktop/) and open it. In Docker Desktop, go to **Settings**, then **Resources**, set **Memory** to 8 GB or more, and click **Apply**.
    - **An API key for an AI model:** get one from Together AI, OpenAI, Anthropic or Google Gemini, on that company's website. You paste it into Aman after the install. This is the only part that costs money, and that company bills you, not Aman.

    Your Mac stays on while you use Aman.

## Step 1: open Terminal

Terminal is the Mac app where you type commands.

1. Press ++cmd+space++.
2. Type `Terminal`.
3. Press ++return++.

## Step 2: get the latest release

Aman is always installed from its latest release, never from the code that is still being worked on.

1. Copy all of these lines and paste them into Terminal, then press ++return++. They ask GitHub which release is the newest, download that version of Aman into a folder named `amanuensis`, and go into that folder.

   ```bash
   VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/ClimbOutLabs/amanuensis/releases/latest)
   VERSION=${VERSION##*/}
   echo "Installing Aman $VERSION"
   git clone --branch "$VERSION" https://github.com/ClimbOutLabs/amanuensis
   cd amanuensis
   ```

   It prints the version first, such as `Installing Aman v0.2.0`.

!!! warning "If it prints `Installing Aman releases`"

    There is no release yet, and Aman can't be installed until the first one is out. Stop here. Check the [releases page](https://github.com/ClimbOutLabs/amanuensis/releases) later, then start this step again.

??? note "The Mac offers to install command line developer tools"

    The first time you use `git`, your Mac may show a window offering to install "command line developer tools". Click **Install** and wait until it finishes. Then paste all the lines from this step again.

??? note "Git says \"You are in 'detached HEAD' state\""

    That is expected. It means you have one fixed version, not the code that changes every day.

## Step 3: run the installer

1. Start the installer:

   ```bash
   ./installer/install.sh
   ```

2. It checks your Mac first. Then it asks a few questions. Answer each one and press ++return++:

   | The installer asks                           | What to do                                                                         |
   | -------------------------------------------- | ---------------------------------------------------------------------------------- |
   | `Name for this instance [main]:`             | Press ++return++ to name it main.                                                  |
   | `Your email, used to sign in`                | Type your email in lowercase. It is only your sign-in name. Nothing is sent to it. |
   | `What should Aman call you?`                 | Type your name, or press ++return++ to use the part of your email before the @.    |
   | `Connect a calendar? [y/N]`                  | Press ++return++. You can connect one later in Aman.                               |
   | `Connect an email account? (optional) [y/N]` | Press ++return++. You can do this later too.                                       |
   | `Back up automatically every day? [Y/n]`     | Press ++return++.                                                                  |
   | `Go ahead? [Y/n]`                            | It first shows the plan: what it will download and build. Press ++return++.        |

3. Choose a password for Aman. The installer asks `Enter a password for you@example.com (not shown):`, with your own email. Type the password and press ++return++. Then it asks `Enter password again (not shown):`, so type it once more. Nothing shows while you type.

   Your password needs at least 8 characters, with a number and a symbol such as @ or #.

4. Wait while it works on its own for 20 to 40 minutes. You see one line per step, with the time it has taken. "Building the Aman app" is the longest step, and 15 minutes is normal.

When it is done, it prints a box that starts with **Ready. Instance main is running.** The box lists the addresses to open.

!!! note "If it stops with a red line"

    Read the **Next:** line under it. It names the one thing to fix. Fix it, then run `./installer/install.sh` again. It carries on where it stopped.

## Step 4: open Aman and sign in

1. Open a browser on your Mac and go to:

   ```
   http://localhost:8791
   ```

2. Click **Sign in**.
3. Type the email and the password you chose.

Aman opens on this Mac only. Phones and other computers can't reach it.

## Next steps

- [Set up Aman](../packages/trueforge/guide/topics/first-steps.md): add your AI model and try your first chat.
- To use the `aman` command, open a new Terminal window. [The aman command](commands.md) lists what it does.
- To get a newer version later, see [Update Aman](commands.md#update-aman).
- If something went wrong, see [Troubleshooting](troubleshooting.md).

## Remove Aman

This removes Aman and everything it keeps, including your chats and memory.

1. Open Terminal. Run these lines, which go to the folder you installed from and start the removal. Here the folder is `~/amanuensis`; use your own folder.

   ```bash
   cd ~/amanuensis
   ./installer/install.sh instance remove main --purge-data
   ```

2. It asks you to type `main` to confirm.

!!! warning

    Removing Aman deletes your chats, memory and settings, and you can't undo it. Your backups stay in `~/.amanuensis/backups`. Delete that folder too if you don't want them.

If you don't use Docker Desktop for anything else, you can uninstall it as well.
