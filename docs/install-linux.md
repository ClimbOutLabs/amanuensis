# Install on Linux

This guide installs the latest release of Aman on Ubuntu or Debian. It takes about 45 minutes. Most of that is waiting while things download and build. You answer a few questions and choose a password at the start. Later, you type your computer password when a step needs it.

Using another computer? Follow [Install on a Mac](install-mac.md) or [Install on Windows](install-windows.md) instead.

!!! note "Before you start"

    - **System:** Ubuntu or Debian.
    - **Memory:** 16 GB. 8 GB is the bare minimum, and the first install is slow there.
    - **Disk space:** about 45 GB free. Aman itself takes about 10 GB. The rest is room for the two sandbox disks, the sealed-off areas where Aman runs code.
    - **Your user can use `sudo`:** `sudo` lets you run a command as the computer's administrator. The installer asks before each step that needs it.
    - **Docker:** you don't need it in advance. Docker is a free program that runs Aman's parts, and the installer offers to install it for you.
    - **An API key for an AI model:** get one from Together AI, OpenAI, Anthropic or Google Gemini, on that company's website. You paste it into Aman after the install. This is the only part that costs money, and that company bills you, not Aman.

    The computer stays on while you use Aman.

## Step 1: open a terminal and get the tools

Open a terminal. Then make sure `curl` and `git` are installed:

```bash
sudo apt update && sudo apt install -y curl git
```

## Step 2: get the latest release

Aman is always installed from its latest release, never from the code that is still being worked on.

1. Copy all of these lines and paste them into the terminal, then press ++enter++. They ask GitHub which release is the newest, download that version of Aman into a folder named `amanuensis`, and go into that folder.

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

??? note "Git says \"You are in 'detached HEAD' state\""

    That is expected. It means you have one fixed version, not the code that changes every day.

## Step 3: run the installer

1. Start the installer:

   ```bash
   ./installer/install.sh
   ```

2. It checks your computer first. Then it asks a few questions. Answer each one and press ++enter++:

   | The installer asks                           | What to do                                                                         |
   | -------------------------------------------- | ---------------------------------------------------------------------------------- |
   | `Name for this instance [main]:`             | Press ++enter++ to name it main.                                                   |
   | `Your email, used to sign in`                | Type your email in lowercase. It is only your sign-in name. Nothing is sent to it. |
   | `What should Aman call you?`                 | Type your name, or press ++enter++ to use the part of your email before the @.     |
   | `Connect a calendar? [y/N]`                  | Press ++enter++. You can connect one later in Aman.                                |
   | `Connect an email account? (optional) [y/N]` | Press ++enter++. You can do this later too.                                        |
   | `Back up automatically every day? [Y/n]`     | Press ++enter++.                                                                   |
   | `Go ahead? [Y/n]`                            | It first shows the plan: what it will download and build. Press ++enter++.         |
   | `Install Docker Engine now? [y/N]`           | It asks this only if Docker is missing. Type `y`, then your computer password.     |

3. Choose a password for Aman. The installer asks `Enter a password for you@example.com (not shown):`, with your own email. Type the password and press ++enter++. Then it asks `Enter password again (not shown):`, so type it once more. Nothing shows while you type.

   Your password needs at least 8 characters, with a number and a symbol such as @ or #.

4. Wait while it works on its own for 20 to 40 minutes. You see one line per step, with the time it has taken. "Building the Aman app" is the longest step, and 15 minutes is normal.

5. Near the end, it asks one or two more questions. Type `y` each time, then your computer password when it asks:

   - `Set up the sandbox now? [y/N]` Type `y`. This gives Aman a safe place to run code. If you press ++enter++ here, the install stops. Run the installer again and type `y`.
   - `Make Docker start with this computer? [y/N]` It asks this only if Docker doesn't start on its own yet. Type `y`.

When it is done, it prints a box that starts with **Ready. Instance main is running.** The box lists the addresses to open.

!!! note "If it stops with a red line"

    Read the **Next:** line under it. It names the one thing to fix. Fix it, then run `./installer/install.sh` again. It carries on where it stopped.

!!! tip "If the installer added Docker for you"

    Sign out of your computer and back in once. Until then, other terminal windows may say "permission denied" when they use Docker.

## Step 4: open Aman and sign in

1. Open a browser on this computer and go to:

   ```
   http://localhost:8791
   ```

2. Click **Sign in**.
3. Type the email and the password you chose.

To use Aman from your phone or another computer at home, see [Set up Aman](../packages/trueforge/guide/topics/first-steps.md#open-aman-and-sign-in).

## Next steps

- [Set up Aman](../packages/trueforge/guide/topics/first-steps.md): add your AI model and try your first chat.
- To use the `aman` command, open a new terminal window. [The aman command](commands.md) lists what it does.
- To get a newer version later, see [Update Aman](commands.md#update-aman).
- If something went wrong, see [Troubleshooting](troubleshooting.md).

## Remove Aman

This removes Aman and everything it keeps, including your chats and memory.

1. Open a terminal. Run these lines, which go to the folder you installed from and start the removal. Here the folder is `~/amanuensis`; use your own folder.

   ```bash
   cd ~/amanuensis
   ./installer/install.sh instance remove main --purge-data
   ```

2. It asks you to type `main` to confirm.

!!! warning

    Removing Aman deletes your chats, memory and settings, and you can't undo it. Your backups stay in `~/.amanuensis/backups`. Delete that folder too if you don't want them.
