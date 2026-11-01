# Try Aman

Aman is a private assistant that runs on your own computer. Your chats, files and memory stay on your machine. What leaves it is what you send to the AI model you choose, and the words of any web search, which go to the Parallel search service.

Setting it up takes about 45 minutes. Most of that is waiting while things download and build; you answer five questions at the start and type your password once near the end.

## What you need

- A computer with at least 16 GB of memory and 30 GB of free disk space. It stays on while you use Aman.
- **Mac:** [Docker Desktop](https://www.docker.com/products/docker-desktop/). After installing it, open Docker Desktop, go to Settings, Resources, and set Memory to 8 GB or more. Then click Apply.
- **Windows:** Windows 11 (or Windows 10 with the latest updates). You will install Ubuntu inside Windows (called WSL) and Docker Desktop; the steps are below.
- **Linux (Ubuntu or Debian):** nothing extra. The installer offers to install Docker for you. Your user must be allowed to use `sudo`.
- A GitHub account that has been given access to the Aman code (ask the person who sent you this).
- An API key for an AI model (OpenAI, Anthropic or Google Gemini). You create it on that company's website; it is pasted into Aman after the install. This is the only part that costs money, and it is billed by that company, not by Aman.

## Step 1: get the code

Open a terminal.

- Mac: open the **Terminal** app (press Command+Space and type "Terminal").
- Windows: first install Ubuntu. Open **PowerShell as administrator** and run `wsl --install`, then restart the computer and open the **Ubuntu** app once so it asks you for a username and password. Then install Docker Desktop, open it, go to Settings, Resources, WSL integration, and turn on the switch for Ubuntu. From now on, do everything in the **Ubuntu** app, never in PowerShell.
- Linux: open your terminal.

Then run these three lines, one at a time. Replace `vX.Y.Z` with the version the person who sent you this told you to use.

```
git clone https://github.com/ClimbOutLabs/amanuensis
cd amanuensis
git checkout vX.Y.Z
```

The first line asks you to sign in to GitHub. Your GitHub password does not work there; use a "personal access token" instead (on GitHub: your profile picture, Settings, Developer settings, Personal access tokens, Generate new token; give it access to the Aman repository with "Contents: read"). Paste the token where it asks for a password.

On a Mac, the first `git` command may show a window offering to install "command line developer tools". Click Install and wait, then run the line again.

On Windows, keep the code inside Ubuntu (just run the lines as they are; do not go to a folder like `/mnt/c`).

## Step 2: run the installer

```
./installer/install.sh
```

It first checks your computer, then asks:

1. **Name for this instance [main]:** press Enter to name it main, or type another name, such as `work`.
2. **Your email, used to sign in**: type your email in lowercase. This is only your sign-in name; nothing is sent to it.
3. **What should Aman call you?**: type your name, or press Enter to use the part of your email before the @.
4. **Back up automatically every day? [Y/n]**: press Enter.
5. It shows the plan: what it will download and build. **Go ahead? [Y/n]**: press Enter.
6. **Password**: choose a password of at least 8 characters with a number and a symbol, such as @ or #, and type it twice. Nothing shows while you type. Remember it; you need it to sign in.

Then it works on its own for 20 to 40 minutes. You see one line per step with a spinner and the time it has taken. "Building the Aman app (this might take a while)" is the longest step; 15 minutes is normal.

On **Linux** it asks two more questions near the end. Type `y` for both, then your computer password when it asks:

- **Set up the sandbox now? [y/N]**: type `y`. (This gives Aman a safe place to run code. If you press Enter here, the install stops; just run the installer again and type `y`.)
- **Make Docker start with this computer? [y/N]**: type `y`.

When it is done, it prints a box that starts with **Ready. Instance main is running.** and lists the addresses to open. Below that: "Open a new terminal window to use the aman command."

If it stops with a red line instead, read the **Next:** line under it. It names the one thing to fix or the one command to run. Then run `./installer/install.sh` again; it continues where it stopped.

## Step 3: open Aman and sign in

On the computer you installed it on, open a browser and go to:

```
http://localhost:8791
```

Click **Let's Get Started**, then enter the email and the password you chose. You land in Settings, Models.

**From your phone or another computer in your home:** the install printed a line like "Trust this computer on each device: http://…/trust". Open that address on the phone (or scan the square code that was printed). The page explains, for iPhone, Android, Mac and Windows, how to make that device trust your computer. You do this once per device. After that, open the https address from the "Open" list (the one that starts with `https://` and ends in `:8443`). An iPhone says the profile is "Not Signed"; that is expected for a profile you made yourself.

## Step 4: add your AI model

Aman does not come with a model. In **Settings, Models**, find the company you have a key for (OpenAI, Anthropic, Google Gemini), click **Configure**, paste the key, and save. Its models now appear in the model picker at the bottom of the chat screen.

## Step 5: first things to try

Click **New Chat**, pick a model in the picker, and try:

- **A chat.** "Help me plan a week of dinners for two people, one vegetarian."
- **Running code.** "Write a small Python program that prints the first 20 prime numbers, run it, and show me the output." Aman runs it in a sealed-off area on your computer; it cannot reach the internet or your files.
- **Searching the web.** Web search is on from the start (no account needed). Ask: "Search the web for the weather forecast this weekend in my city and summarise it."
- **Memory.** Tell Aman something about yourself in one chat, start a new chat later, and ask about it. Memory is on by default and stays on your computer.

Aman keeps running in the background, also after you restart the computer (Docker has to be running; on Mac and Windows that means Docker Desktop is open).

## If something goes wrong

Open a new terminal window and run:

```
aman doctor
```

It checks everything and prints one **Next:** line per problem, with the command that fixes it. If that does not help, copy the whole output of `aman doctor` and send it to the person who gave you this guide, together with the log file named in the red line, if there was one. The output contains no passwords or chats.

A few common ones:

- **"Docker is installed but not running"**: open Docker Desktop and wait until it says it is running, then try again.
- **"Docker has only 4.0 GB of memory"**: in Docker Desktop: Settings, Resources, Memory, set 8 GB, Apply.
- **The page says the connection is not private**: you opened the https address on a device that does not trust your computer yet. Use http://localhost:8791 on the computer itself, or do the trust step above on the phone.
- **Signing in says the email is not allowed**: use exactly the email you typed during the install, in lowercase.
- **Forgot your password**: on the computer where Aman is installed, run `aman password`. It asks for a new password twice and signs you out everywhere.

## Updating

When a new version comes out, run (replace the version):

```
cd amanuensis
git fetch --tags
git checkout vX.Y.Z
aman upgrade
```

It backs up your data first, builds the new version (about 15 minutes), and switches over. If anything fails, it puts the old version back on its own.

## Removing Aman

To remove everything, including your chats and memory:

```
cd amanuensis
./installer/install.sh instance remove main --purge-data
```

It asks you to type `main` to confirm. Then, to free the disk space Aman's downloads used:

```
docker image prune -a
```

Your backups stay in `~/.amanuensis/backups`; delete that folder too if you do not want them. You can also uninstall Docker Desktop (Mac, Windows) if you do not use it for anything else.

## Good to know

- Nothing is sent anywhere except to the model company you chose, and to Parallel (the search service Aman uses by default) when Aman searches the web. Parallel sees the search words and your internet address. To stop it, remove the `parallel-web` connector in Settings, or turn on Offline mode.
- Backups are made every night at 03:30 into `~/.amanuensis/backups` on your computer, keeping the last 7.
- Each person gets a new instance.
