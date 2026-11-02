# Installing Amanuensis on Windows

On Windows, Amanuensis runs inside [WSL 2](https://learn.microsoft.com/en-us/windows/wsl/install), a free part of Windows that runs Linux, together with Docker Desktop. Setup takes about 20 minutes. Follow these steps in order.

> **Windows support is still being polished.** Installing on Windows has more moving parts than on a Mac or Linux, so it may not go as smoothly. If a step doesn't work the way this guide says, [open an issue](https://github.com/ClimbOutLabs/amanuensis/issues) and tell us which step it was.

**1. Install WSL 2 with Ubuntu.** Open PowerShell as an administrator and run:

```powershell
wsl --install -d Ubuntu
```

Restart when it asks. Then open **Ubuntu** from the Start menu once, and set the Linux username and password it asks for. [Microsoft's WSL guide](https://learn.microsoft.com/en-us/windows/wsl/install) has the details.

**2. Install Docker Desktop.** Get it from [Docker's Windows install page](https://docs.docker.com/desktop/setup/install/windows-install/) and install it. Start Docker Desktop and wait until it reports it is running. Then open its **Settings**, go to **Resources, WSL Integration**, turn on Ubuntu under **Enable integration with additional distros**, and choose **Apply & Restart**. If that page shows only one switch, for the default distro, follow the **Go to classic Settings** link at the top of the Settings page instead: the classic page has the same WSL Integration page, with the list of distros.

**3. Get the code.** In the Ubuntu window:

```bash
sudo apt update && sudo apt install -y git
git clone https://github.com/ClimbOutLabs/amanuensis.git
cd amanuensis
```

**4. Run the install.** Still in the Ubuntu window:

```bash
./installer/install.sh
```

The script checks the computer first, then shows its plan and asks before it changes anything. It asks its questions one at a time: the email address you will sign in with, what Aman should call you, a password to choose, and a few setup choices. It does not ask for a model key. You add the key after the install, under **Settings, Models**, which [After you install](../README.md#after-you-install) walks through.

**5. Open Aman.** The script checks Docker, builds and installs everything, and prints the address to open in your browser. Sign in with the email and password from step 4.

**Upgrading.** In the Ubuntu window, in the same `amanuensis` folder, run `git pull`, then run `./installer/install.sh` again. It keeps your data and carries on.

**If something looks missing.** Commands like `apt` only exist inside the Ubuntu window. If a terminal says a distro or a package tool is missing, you are in PowerShell or in Docker Desktop's own system, not Ubuntu. Open **Ubuntu** from the Start menu.

**If Docker is not connected to Ubuntu.** The install script may say Docker did not answer, or Ubuntu itself may say the docker command could not be found in this WSL 2 distro. Both mean the same thing: Docker Desktop is running, but its integration with Ubuntu is off. Open Docker Desktop, go to **Settings, Resources, WSL Integration**, turn on Ubuntu under **Enable integration with additional distros**, and choose **Apply & Restart**. Then, in the Ubuntu window, `docker version` must print a Server section. Once it does, run `./installer/install.sh` again.

## Next steps

Once Aman is open, follow [After you install](../README.md#after-you-install) to add a model key, name your assistant, and connect your email and calendar.
