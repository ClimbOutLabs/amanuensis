# Try Aman

Aman is a private assistant that runs on your own computer. Your chats, files and memory stay on your machine. What leaves it is what you send to the AI model you choose, and the words of any web search, which go to the Parallel search service.

Setting it up takes about 45 minutes. Most of that is waiting while things download and build; you answer a few questions and choose a password at the start. Then it runs on its own.

## What you need

- A computer with 16 GB of memory (8 GB is the bare minimum, and the first install is slow there) and free disk space: about 20 GB on a Mac, about 45 GB on Linux. It stays on while you use Aman.
- **Mac:** [Docker Desktop](https://www.docker.com/products/docker-desktop/). After installing it, open Docker Desktop, go to Settings, Resources, and set Memory to 8 GB or more. Then click Apply.
- **Windows:** this page is not for you. Follow the [Windows guide](install-windows.md) instead: one download, Aman Setup, does the install. Once you have signed in, come back to [Step 4](#step-4-add-your-ai-model).
- **Linux (Ubuntu or Debian):** nothing extra. The installer offers to install Docker for you. Your user must be allowed to use `sudo`.
- An API key for an AI model (Together AI, OpenAI, Anthropic or Google Gemini). You create it on that company's website; it is pasted into Aman after the install. This is the only part that costs money, and it is billed by that company, not by Aman.

## Steps 1 and 2: install Aman

Follow the guide for your computer. Each one installs the latest release and ends with Aman running:

- [Install on a Mac](install-mac.md)
- [Install on Linux](install-linux.md)
- [Install on Windows](install-windows.md)

Then come back here.

## Step 3: open Aman and sign in

On the computer you installed it on, open a browser and go to:

```
http://localhost:8791
```

Click **Sign in**, then enter the email and the password you chose.

**On a Mac,** Aman opens on that Mac only. Phones and other computers cannot reach it.

**On Linux, from your phone or another computer in your home:** the install printed a line that starts "Instead, open this page once on that device and follow its steps", with an address that ends in `/trust`. Open that address on the phone (or scan the square code that was printed). The page explains, for iPhone, Android, Mac and Windows, how to make that device trust your computer. You do this once per device. After that, open the https address from the "Open" list (the one that starts with `https://` and ends in `:8443`). An iPhone says the profile is "Not Signed"; that is expected for a profile you made yourself.

## Step 4: add your AI model

Aman does not come with a model. In **Settings, Models**, find the company you have a key for (Together AI, OpenAI, Anthropic, Google Gemini), click **Configure**, paste the key, and click **Create**. Its models now appear in the model picker at the bottom of the chat screen.

## Step 5: first things to try

Click **New chat**, pick a model in the picker, and try:

- **A chat.** "Help me plan a week of dinners for two people, one vegetarian."
- **Running code.** "Write a small Python program that prints the first 20 prime numbers, run it, and show me the output." Aman runs it in a sealed-off area on your computer; it cannot reach the internet or your files.
- **Searching the web.** Web search is on from the start (no account needed). Ask: "Search the web for the weather forecast this weekend in my city and summarise it."
- **Memory.** Tell Aman something about yourself in one chat, start a new chat later, and ask about it. Memory is on by default and stays on your computer.

Aman keeps running in the background, also after you restart the computer (Docker has to be running; on Mac and Windows that means Docker Desktop is open).

## If something goes wrong

On Windows, run **Check Aman** from the Start menu. On a Mac or Linux, open a new terminal window and run:

```
aman doctor
```

It checks everything and prints one **Next:** line per problem, with the command that fixes it. If that does not help, follow the **Still stuck** steps in [Troubleshooting](troubleshooting.md).

A few common ones:

- **"Docker is installed but not running"**: open Docker Desktop and wait until it says it is running, then try again.
- **"Docker has only 4.0 GB of memory"**: in Docker Desktop: Settings, Resources, Memory, set 8 GB, Apply.
- **The page says the connection is not private**: you opened the https address on a device that does not trust your computer yet. Use http://localhost:8791 on the computer itself, or do the trust step above on the phone.
- **Signing in says the email is not allowed**: use exactly the email you typed during the install, in lowercase.
- **Forgot your password**: on the computer where Aman is installed, run `aman password`. It asks for a new password twice and signs you out everywhere.

## Updating

On Windows, run **Update Aman** from the Start menu. On a Mac or Linux, run these lines in the folder you installed from. They find the newest release, get its code, and update Aman to it:

```
cd ~/amanuensis
VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/ClimbOutLabs/amanuensis/releases/latest)
VERSION=${VERSION##*/}
git fetch --tags
git checkout "$VERSION"
aman upgrade
```

Here the folder is `~/amanuensis`; use your own folder. If the `git checkout` line fails, there is no newer release, and nothing was changed.

It backs up your data first, builds the new version (about 15 minutes), and switches over. If anything fails, it puts the old version back on its own.

## Removing Aman

On Windows, choose **Remove Aman** in the Start menu; the [Windows guide](install-windows.md#removing-aman) walks through its two questions. On a Mac or Linux, to remove everything, including your chats and memory:

```
cd ~/amanuensis
./installer/install.sh instance remove main --purge-data
```

It asks you to type `main` to confirm. Your backups stay in `~/.amanuensis/backups`; delete that folder too if you do not want them. You can also uninstall Docker Desktop (Mac, Windows) if you do not use it for anything else.

## Go back to an earlier backup

If chats or settings were lost or changed by mistake, run:

```
aman restore
```

It shows your backups, newest first, and asks:

```
Restore which backup (number):
```

Type a number. It tells you what will be replaced and asks you to type `yes`. The password goes back to the one you had when the backup was made. Before it changes anything it saves a copy of what you have now and shows you where that copy is. If something goes wrong it puts everything back and says so. To use the newest backup without the list, run `aman restore --latest`.

## Good to know

- Nothing is sent anywhere except to the model company you chose, and to Parallel (the search service Aman uses by default) when Aman searches the web. Parallel sees the search words and your internet address. To stop it, remove the `parallel-web` connector in Settings, or turn on Offline mode.
- Backups are made every night at 03:30 into `~/.amanuensis/backups` on your computer, keeping the last 7.
- Each person gets their own Aman, called an instance. See [Adding people](install.mdx#adding-people).
