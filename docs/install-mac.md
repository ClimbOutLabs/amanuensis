# Install Aman on a Mac

This page installs Aman on a Mac, from the latest release. It takes about 45 minutes. Most of that is waiting while things download and build. You answer a few questions and choose a password at the start. Then it runs on its own.

On Linux, follow [Install on Linux](install-linux.md). On Windows, follow [Install on Windows](install-windows.md).

## What you need

- A Mac with 16 GB of memory. 8 GB is the bare minimum, and the first install is slow there.
- About 20 GB of free disk space.
- [Docker Desktop](https://www.docker.com/products/docker-desktop/). Install it, open it, then go to **Settings**, **Resources**, set **Memory** to 8 GB or more, and click **Apply**.
- An API key for an AI model, from Together AI, OpenAI, Anthropic or Google Gemini. You make it on that company's website and paste it into Aman after the install. This is the only part that costs money, and that company bills you, not Aman.

The Mac stays on while you use Aman.

## Step 1: open Terminal

Press Command and Space, type `Terminal`, and press Return.

## Step 2: get the latest release

Aman is installed from its latest release, never from the code that is still being worked on. Run these lines one at a time. They ask GitHub which release is the newest, and print it:

```bash
VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/ClimbOutLabs/amanuensis/releases/latest)
VERSION=${VERSION##*/}
echo "Installing Aman $VERSION"
```

It prints the version, such as `Installing Aman v0.2.0`. If it prints `Installing Aman releases` instead, there is no release yet. Stop here: Aman cannot be installed until the first release is out. Check the [releases page](https://github.com/ClimbOutLabs/amanuensis/releases) later, then start this step again.

Then get that version of the code:

```bash
git clone --branch "$VERSION" https://github.com/ClimbOutLabs/amanuensis
cd amanuensis
```

The first time, the Mac may show a window offering to install "command line developer tools". Click **Install**, wait until it finishes, then run the `git clone` line again.

Git may say "You are in 'detached HEAD' state". That is expected: you have one fixed version, not the code that changes every day.

## Step 3: run the installer

```bash
./installer/install.sh
```

It first checks your Mac, then asks:

1. **Name for this instance [main]:** press Return to name it main.
2. **Your email, used to sign in:** type your email in lowercase. It is only your sign-in name; nothing is sent to it.
3. **What should Aman call you?** Type your name, or press Return to use the part of your email before the @.
4. **Connect a calendar? [y/N]** Press Return. You can connect one later in Aman.
5. **Connect an email account? (optional) [y/N]** Press Return. You can do this later too.
6. **Back up automatically every day? [Y/n]** Press Return.
7. It shows the plan: what it will download and build. **Go ahead? [Y/n]** Press Return.
8. **Enter a password for** your email: choose a password of at least 8 characters, with a number and a symbol such as @ or #. Type it, then type it again. Nothing shows while you type.

Then it works on its own for 20 to 40 minutes. You see one line per step, with the time it has taken. "Building the Aman app" is the longest step; 15 minutes is normal.

When it is done, it prints a box that starts with **Ready. Instance main is running.** and lists the addresses to open.

If it stops with a red line instead, read the **Next:** line under it. It names the one thing to fix. Then run `./installer/install.sh` again; it continues where it stopped.

## Step 4: open Aman and sign in

Open a browser on the Mac and go to:

```
http://localhost:8791
```

Click **Sign in**, then type the email and password you chose.

On a Mac, Aman opens on this Mac only. Phones and other computers cannot reach it.

## Next

- [Add your AI model](try-aman.md#step-4-add-your-ai-model) and try your first chat.
- Open a new Terminal window to use the `aman` command. [The aman command](commands.md) lists what it does.
- To update later, see [Update Aman](commands.md#update-aman).
- If something went wrong, see [Troubleshooting](troubleshooting.md).
