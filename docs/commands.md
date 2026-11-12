---
title: 'The aman command'
description: 'Every aman command and installer command, what it does, and when to use it.'
---

# The aman command

`aman` is the command you type in a terminal to check, back up, update and repair Aman. The installer puts it on your computer. This page lists every command, grouped by what you want to do.

Most people only need four: `aman doctor`, `aman backup`, `aman upgrade` and `aman password`.

## Where the command is

There are two versions of the command. Which one you have depends on how you installed Aman.

- **Mac, Linux, and Windows with WSL:** the installer (`installer/install.sh`) puts `aman` in `~/.amanuensis/bin`. New terminal windows find it on their own. If a terminal says `aman: command not found`, open a new terminal window. If it still says so, run `~/.amanuensis/bin/aman`, or run `./installer/install.sh command` in the folder you installed from to put the command back.
- **Windows with Aman Setup:** Aman Setup installs its own `aman` command. Its commands are listed under [Windows with Aman Setup](#windows-with-aman-setup). The Start menu has entries for the common ones, so you rarely need it.

The rest of this page, up to the Windows section, is for Mac, Linux and WSL.

## Check that everything works

```bash
aman doctor
```

Checks this computer and every instance, then prints one **Next:** line for each problem, with the command that fixes it. It changes nothing.

| Command                       | What it does                                                                       |
| ----------------------------- | ---------------------------------------------------------------------------------- |
| `aman doctor`                 | Check this computer and every instance                                             |
| `aman doctor --instance NAME` | Check this computer and one instance only                                          |
| `aman doctor --deep`          | Wait up to 30 seconds for each check instead of 5, for a slow computer             |
| `aman doctor --local`         | Skip the checks that reach the internet (the model and the public https addresses) |
| `aman doctor --only ID`       | Run one check, such as `--only disk`. A wrong ID prints the list of checks         |
| `aman doctor --verbose`       | Show technical details                                                             |
| `aman doctor --json`          | Print the result as JSON, for a script                                             |

`aman doctor` finishes with 0 when nothing fails, 1 when a check fails, and 2 when the command was typed wrong. The [install guide](install.mdx#doctor) explains what each check means.

### Check one area and fix it

Each of these checks one area. Add `--fix` to repair what it finds. A fix asks before it changes anything, and asks before anything that needs your admin password. Add `--yes` after `--fix` to answer yes to its questions.

| Command                | What it checks                                                                                    | What `--fix` does                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `aman doctor docker`   | Docker is installed and running, and its sign-in helper works                                     | Installs, starts or updates Docker with the installer                                           |
| `aman doctor disk`     | Docker has enough free space                                                                      | Removes old Aman images and the build cache. Nothing that runs is touched                       |
| `aman doctor backup`   | Backups are recent and scheduled                                                                  | Turns on daily backups and makes one now                                                        |
| `aman doctor checkout` | Only you can change the folder Aman's installer runs from                                         | Makes that folder yours only                                                                    |
| `aman doctor tls`      | The https certificates are valid                                                                  | Renews the certificates that are due                                                            |
| `aman doctor instance` | Each instance's settings and containers                                                           | Restarts the instance                                                                           |
| `aman doctor network`  | Each of this computer's addresses is allowed for sign-in                                          | Adds the new addresses and restarts the instance                                                |
| `aman doctor sandbox`  | The sandbox where Aman runs code passes its safety checks, then makes a real call through the app | Rebuilds the sandbox image, reloads its safety profile, recreates missing disks and restarts it |

`aman doctor instance`, `aman doctor network` and `aman doctor sandbox` also take `--instance NAME`. `aman doctor sandbox` takes `--disk-gb N` to set the size of each sandbox disk, and `--no-hard-disk-limit` where the computer cannot make fixed-size disks.

## Back up and restore your data

| Command                 | What it does                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `aman backup`           | Back up every instance now                                                                       |
| `aman backup NAME`      | Back up one instance now                                                                         |
| `aman restore`          | Put Aman back the way it was in a backup. It lists the backups, newest first, and asks which one |
| `aman restore --latest` | Put back the newest backup without the list                                                      |
| `aman restore NAME`     | Restore one instance when there are several                                                      |

Backups go to `~/.amanuensis/backups`, one folder per backup. Aman keeps the seven newest. A restore says what it will replace and waits for you to type `yes`, and saves a copy of what you have now first. [Backups](backup.md) explains what is in them, how a restore works and how to copy a backup off your computer. To turn daily backups on or off, see [Installer commands](#installer-commands).

## Update Aman

`aman upgrade` updates Aman to the copy of the code in the folder you installed from. It does not download the new version itself, so first get the newest release into that folder. Run these lines in it (here `~/amanuensis`; use your own folder):

```bash
cd ~/amanuensis
VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' https://github.com/ClimbOutLabs/amanuensis/releases/latest)
VERSION=${VERSION##*/}
git fetch --tags
git checkout "$VERSION"
aman upgrade
```

The second and third lines ask GitHub which release is the newest. Always update to a release, not to the code that is still being worked on. If the `git checkout` line fails, there is no newer release, and nothing was changed.

| Command                | What it does                                                                                              |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `aman upgrade`         | Back up, build the new version, and switch over. If anything fails, the old version comes back on its own |
| `aman upgrade --check` | Show what would change, and change nothing                                                                |
| `aman upgrade --force` | Upgrade even when the version has not changed                                                             |

## Sign-in password

| Command                          | What it does                                                                         |
| -------------------------------- | ------------------------------------------------------------------------------------ |
| `aman password`                  | Set a new owner password, then sign everyone out. It asks for the new password twice |
| `aman password --instance NAME`  | The same, for one instance when there are several                                    |
| `aman password --password-stdin` | Read the new password from the input instead of asking                               |

Run it on the computer where Aman is installed.

## Bring data in

| Command                                | What it does                                                                                        |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `aman import FILE`                     | Put an exported file (a .zip) into Aman. It makes a backup first, and the app pauses while it works |
| `aman import FILE --dry-run`           | Check the file and say what it would bring, and import nothing                                      |
| `aman import FILE --instance NAME`     | Import into one instance when there are several                                                     |
| `aman import FILE --display-name NAME` | Your name as the imported chats show it                                                             |
| `aman migrate --from-compose FOLDER`   | Export your data from an older Aman that runs from that folder. The old Aman is only read           |

[Move from the old compose stacks](migrate-from-compose.md) walks through a move from an older Aman.

## Installer commands

Some jobs are done by the installer itself. Run these in the folder you installed from.

**People and instances.** Each person gets their own instance, with their own chats, memory and sign-in.

| Command                                                    | What it does                                                                               |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `./installer/install.sh`                                   | Set Aman up on this computer: check it, show the plan, build, and start the first instance |
| `./installer/install.sh --dry-run`                         | Show the plan and change nothing                                                           |
| `./installer/install.sh instance add NAME`                 | Add an instance for another person                                                         |
| `./installer/install.sh instance list`                     | Show every instance                                                                        |
| `./installer/install.sh instance refresh NAME`             | Start an instance again with its current settings                                          |
| `./installer/install.sh instance password NAME`            | Set a new owner password for that instance and sign everyone out                           |
| `./installer/install.sh instance remove NAME`              | Remove an instance. Its data stays                                                         |
| `./installer/install.sh instance remove NAME --purge-data` | Remove an instance and delete its data. It asks you to type the name to confirm            |

**Mail and calendar.** Each command asks for the details, then restarts the instance.

| Command                                                  | What it does                       |
| -------------------------------------------------------- | ---------------------------------- |
| `./installer/install.sh instance email NAME`             | Connect or change an email account |
| `./installer/install.sh instance email NAME --remove`    | Remove the email account           |
| `./installer/install.sh instance calendar NAME`          | Connect a calendar                 |
| `./installer/install.sh instance calendar NAME --remove` | Remove the calendar                |

**Looking after the computer.**

| Command                                | What it does                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------------- |
| `./installer/install.sh backups daily` | Back up every day at 03:30                                                              |
| `./installer/install.sh backups off`   | Stop the daily backup                                                                   |
| `./installer/install.sh docker`        | Install, start or update Docker. It asks before anything that needs your admin password |
| `./installer/install.sh command`       | Put the `aman` command back                                                             |
| `./installer/install.sh tls`           | Renew the https certificates that are due                                               |
| `./installer/install.sh upgrade`       | The same as `aman upgrade`                                                              |

`./installer/install.sh --help` lists every option, such as `--local-only` to keep Aman on this computer only, `--port` to pick its port, and `--no-sandbox` to install without the sandbox. The [install guide](install.mdx) explains them.

## Windows with Aman Setup

On a PC set up with Aman Setup, type these in **PowerShell**. The Start menu entries **Aman**, **Check Aman**, **Update Aman**, **Backups** and **Remove Aman** run the matching commands for you.

| Command              | What it does                                                                                                           |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `aman`               | List these commands                                                                                                    |
| `aman --version`     | Show which version this is                                                                                             |
| `aman status`        | Show what is installed and whether it is running                                                                       |
| `aman open`          | Open Aman in your browser, starting Docker Desktop first if it needs to                                                |
| `aman doctor`        | Check this computer and each instance                                                                                  |
| `aman doctor docker` | Check that Docker is ready for Aman                                                                                    |
| `aman network open`  | Let phones and other devices on your home network reach Aman                                                           |
| `aman network close` | Close Aman to your home network again                                                                                  |
| `aman backup`        | Make a backup now, in the Backups folder on this computer                                                              |
| `aman backups`       | List the backups kept on this computer                                                                                 |
| `aman restore`       | Put Aman back the way it was in one of those backups. It says which backup it will use and waits for you to type `yes` |
| `aman upgrade`       | Update Aman to the newest version                                                                                      |
| `aman verify FILE`   | Check a downloaded file against its signed release record                                                              |
| `aman install`       | Set Aman up on this computer for the first time                                                                        |
| `aman adopt`         | Let the `aman` command manage an Aman that Aman Setup installed                                                        |
| `aman uninstall`     | Remove Aman from this computer. It asks before it deletes your data and keeps your backups unless you say otherwise    |

The [Windows guide](install-windows.md) walks through Aman Setup.

## When a command fails

Every command says what went wrong and the one thing to do next. If that does not help, see [Troubleshooting](troubleshooting.md).
