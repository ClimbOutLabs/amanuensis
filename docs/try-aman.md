# Get started

Aman is a private assistant that runs on your own computer. This page shows what you need, then walks you to the install guide for your computer.

Setting Aman up takes about 45 minutes. Most of that is waiting while things download and build. You answer a few questions and choose a password at the start, and then it runs on its own.

## What you need

- **A computer that stays on while you use Aman.** It can be a Mac, a Windows PC, or a Linux computer with Ubuntu or Debian.
- **16 GB of memory.** 8 GB is the bare minimum, and the first install is slow there.
- **Free disk space.** You need about 20 GB on a Mac or a Windows PC, and about 45 GB on Linux.
- **An API key for an AI model.** An API key is a long password that lets Aman use your account at an AI company. Aman works with Together AI, OpenAI, Anthropic and Google Gemini. You make the key on that company's website, and paste it into Aman after the install. Or use a model you run yourself on the same computer, such as Ollama. See [A model on this computer](../packages/trueforge/guide/topics/local-model.md).

!!! note "What it costs"

    Aman itself is free. The AI model is the only part that costs money. The company you choose bills you for what you use, not Aman.

Each install guide lists anything else your computer needs, such as Docker. Docker is a free program that runs Aman's parts in their own sealed-off boxes.

## Step 1: install Aman

Pick your computer. Each guide installs the latest release and ends with Aman running.

<div class="grid cards" markdown>

- :material-apple:{ .lg .middle } **Install on a Mac**

  ***

  Install Docker Desktop, then run the installer in Terminal.

  [:octicons-arrow-right-24: Install on a Mac](install-mac.md)

- :material-linux:{ .lg .middle } **Install on Linux**

  ***

  Run the installer on Ubuntu or Debian. It can install Docker for you.

  [:octicons-arrow-right-24: Install on Linux](install-linux.md)

- :material-microsoft-windows:{ .lg .middle } **Install on Windows**

  ***

  One download, Aman Setup, installs everything. No terminal needed.

  [:octicons-arrow-right-24: Install on Windows](install-windows.md)

</div>

## Step 2: set up Aman

Open Aman, sign in, and add your AI model. Then tell Aman a little about you and start your first chat.

<div class="grid cards" markdown>

- :material-check-circle-outline:{ .lg .middle } **Set up Aman**

  ***

  Sign in, add a model, and try your first chat.

  [:octicons-arrow-right-24: Set up Aman](../packages/trueforge/guide/topics/first-steps.md)

- :material-lightbulb-outline:{ .lg .middle } **Ideas to try**

  ***

  Ready-made requests to start with, grouped by what is going on in your life.

  [:octicons-arrow-right-24: Ideas to try](../packages/trueforge/guide/topics/ideas.md)

</div>

## Good to know

- Aman keeps running in the background, even after you restart the computer. Docker has to be running for that. On a Mac or a Windows PC, that means Docker Desktop is open.
- Aman backs up your data every night. [Backups](backup.md) explains how to go back to one.
- To get a newer version, see [Update Aman](commands.md#update-aman).
- Each person gets their own Aman, called an instance. See [Adding people](install.mdx#adding-people).
- If something goes wrong, [Troubleshooting](troubleshooting.md) lists the common problems and what to do.
