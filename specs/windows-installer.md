# Spec: Aman on this PC (Windows)

**Status:** draft

## Problem

The friends release (v0.2.0) waits on Windows. Today's installer (`installer/install.sh` and its libraries, about 8,500 lines of shell) runs on Mac and Linux and on Windows only inside WSL, which means a Linux terminal and a Linux user account. The friends have never opened a terminal and will give up at the first confusing step. The owner wants the simplest thing that gets a friend from a download to a working Aman in v0.2.0, without a second installer that drifts from the first.

## Solution

One file, `Aman-Setup.cmd`, that the friend downloads and double-clicks. It does only the three things that must happen on Windows itself (get Docker Desktop running, ask four questions, make the Aman icon) and then runs today's `install.sh`, unchanged, inside a small Linux container that talks to Docker Desktop. The stack it starts is the same one Mac and Linux get, with Aman's own sign-in, reachable from this PC only at `http://127.0.0.1:8791`. No WSL window, no Linux terminal, no typing commands, no ports, no files to edit.

### What the friend sees

A plain console window titled Aman Setup, one message or question at a time. A first install on a PC with no Docker Desktop:

| Step                     | What the person does                                                                                                                                                                                                 | Clicks | Typed | Wait                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | ----- | ------------------------------------------ |
| Download                 | Clicks Download on the release page. Edge warns about an uncommon file: Keep, Show more, Keep anyway.                                                                                                                | 4      |       | seconds                                    |
| Open                     | Double-clicks `Aman-Setup.cmd`. SmartScreen: More info, Run anyway.                                                                                                                                                  | 3      |       |                                            |
| Docker Desktop           | "Aman runs inside Docker Desktop, which is not on this PC yet. I will install it now. Windows will ask for permission." UAC: Yes.                                                                                    | 1      |       | 3 to 8 min (600 MB download, then install) |
| Restart                  | "Windows needs to restart once to finish. Aman Setup continues on its own after you sign back in." Restart now: Yes. After sign-in the window reopens by itself.                                                     | 1      |       | 2 min                                      |
| Docker Desktop first run | Docker Desktop opens its own window once: Accept the terms, Skip sign-in. The Aman window waits: "Waiting for Docker Desktop to start. Accept its terms in its window if it asks."                                   | 2      |       | 1 min                                      |
| Questions                | "Your email, used to sign in:" "Choose a password (at least 8 characters, not shown):" "Paste your model key (not shown):" with the address to get one printed above it. "Install Aman on this PC now? (yes or no):" |        | 4     |                                            |
| Build                    | "The next part takes 20 to 40 minutes and needs nothing from you. You can keep using this PC. Leave this window open and do not close the laptop lid."                                                               |        |       | 20 to 40 min                               |
| Done                     | "Aman is ready. The Aman icon is on your desktop and in the Start menu." The browser opens at the sign-in page.                                                                                                      |        |       |                                            |

Total: 11 clicks, 4 typed answers, one restart, two long waits. Five of the clicks are the Edge and SmartScreen warnings of an unsigned download; the release page shows those two screens with the buttons circled, and nothing else. A PC that already has Docker Desktop skips three rows and about ten minutes. A mistyped password is fixed with the `aman password` command being built, not by reinstalling.

Each person gets a new instance.

## How it works

**`Aman-Setup.cmd`** is one file of about 250 lines: a two-line batch header that starts PowerShell on the rest of the same file, so a double-click works and nothing has to be installed first. It contains no installer logic. It does, in order:

1. **Docker Desktop.** If `docker info` answers, skip ahead. If Docker Desktop is installed but not running, start it and wait. Otherwise download `Docker Desktop Installer.exe` from `desktop.docker.com` over https, check its Authenticode signature (status valid, signer Docker Inc) before anything runs elevated, and run it elevated with `install --quiet --accept-license --backend=wsl-2` after one plain sentence: "Docker Desktop is made by Docker Inc. Its terms apply to it; Aman only runs inside it." When Docker's installer asks for a restart, write one `RunOnce` value under `HKCU` that reopens Aman Setup after sign-in from the copy it keeps in `%LOCALAPPDATA%\Amanuensis`, and restart. Nothing secret crosses the restart: the questions come after. Then wait, polling `docker info`, while Docker Desktop shows its terms. Windows 10 22H2 and Windows 11, Home included, since WSL2 needs no Hyper-V. If virtualization is off in the PC's firmware: "This PC has virtualization turned off, which Docker Desktop needs. It is a setting in the PC's startup menu. Ask the person who helps you with this computer, then run Aman Setup again."
2. **The questions.** Email, password, model key and the confirmation, read in PowerShell; the password and the key are read hidden and handed to the installer on its standard input, never as arguments, which is how `install.sh` already takes them (`--password-stdin`, `--token-factory-key-stdin`). The memory check runs before the first question: Docker Desktop under 6 GB is told so at once, with "Open Docker Desktop, Settings, Resources, and give it at least 6 GB, then run Aman Setup again."
3. **The installer container.** Build a tiny setup image from a Dockerfile embedded in the file (the official `docker:cli` image pinned by digest, plus `bash`, `git`, `curl` and `tar`), then run it with Docker Desktop's socket mounted, two named volumes (`aman_home` at `/root/.amanuensis`, `aman_source` at `/src`) and a bounded keep-awake request to Windows so the PC does not sleep mid-build. Inside, it clones the release tag with `git clone --depth 1 --branch <tag>` and runs:

   ```
   installer/install.sh --yes --local-only --backups off --name main --email <email> --password-stdin --token-factory-key-stdin
   ```

   That one command line is the whole contract between the Windows file and the installer. Everything after it is today's installer, unchanged: the plan, the image builds, the sandbox slots, the sign-in service, the health wait, the doctor. `--local-only` means no certificate, no trust page, no firewall rule and no phone setup. `--backups off` because v0.2.0 has no automatic backups on Windows; Export in Settings still works. The port check inside the container sees the container's own loopback, so the Windows side first checks that 8791 and 5556 are free on the PC and, if not, hands the installer the next free pair with `--port` and `--login-port`; the person is never asked.

4. **The icon.** A desktop shortcut and a Start menu entry, both running `Aman-Setup.cmd open`: start Docker Desktop if it is not running, wait until `http://127.0.0.1:8791/healthz` answers (the containers restart with Docker Desktop on their own), then open the browser there. `Aman-Setup.cmd doctor` runs `aman doctor` in the same container for the owner's phone support.

**Upgrade** is running the same file again. It asks GitHub for the newest release tag (keeping the installed one when offline), clones it, and `install.sh` sees a checkout newer than the recorded release and takes its existing upgrade path: back up, rebuild, restart, roll back on failure. Data lives in the same named volumes as on Mac and Linux and is kept. Running the file again after a closed window or a failed build also just continues: finished images are kept, and the window says "Continuing where it left off."

**Sandbox.** The slot setup already detects a Docker Desktop host and needs no sudo, no AppArmor and no slot disks there; gVisor runs with systrap, which needs nothing from the host. The owner has confirmed this on Docker Desktop for Mac. The first nightly test proves it on Windows: if the slots pass `aman doctor sandbox`, v0.2.0 ships with run code on; if not, the file passes `--no-sandbox` and run code shows as off in the app, as it does today. One flag, decided once.

**Why this and not PowerShell doing the work.** Rendering the compose files, picking ports, hashing the password and configuring sign-in in PowerShell would be a second installer that drifts from the first, which the owner rules out. Running the real installer in a container reuses all of it, keeps one place to fix bugs, and the Windows file stays small enough for one reviewer to read in full. The cost is that `~/.amanuensis` lives in a Docker volume the friend cannot see in Explorer, which is fine while there are no backups to find there, and that Docker Desktop's "Clean / Purge data" button would delete it, which the docs say in one sentence.

## Privacy

The installer reads no chats, memories, mail or audio. It handles the owner email, the password (hashed once inside the app image, never stored), the model key (written only to the instance `.env`, mode 600, inside the Docker volume), generated secrets, and install state and logs. Nothing of that is written to the Windows filesystem; `%LOCALAPPDATA%\Amanuensis` holds only the copy of `Aman-Setup.cmd` and the icon. Reach is this PC only: the app and sign-in service are published on `127.0.0.1`, no firewall rule is added, no other device can connect. The file contacts only GitHub (the release tag and the source), `desktop.docker.com` (Docker Desktop), the hosts the installer's plan prints for the builds, and Token Factory only through the app. No telemetry, no scanning.

## Testing

There is no Windows CI and GitHub Actions does not run on this repository. Everything is proven on Linux, then on the owner's PC from a nightly build.

- **On Linux, every PR.** The PowerShell body runs under PowerShell Core with Pester, with `docker`, `Start-Process`, the registry and the shortcut calls stubbed, so every branch (Docker missing, installed but stopped, running; restart; ports busy; each failure message) is exercised and every command line it would run is compared to a golden file. `PSScriptAnalyzer` lints it. The existing `installer/tests` gain one test that runs `install.sh` with exactly the command line above against the existing stub Docker, so the contract between the two files is tested on both sides. All test data is synthetic.
- **Nightly, on the owner's PC.** A scheduled cloud session publishes a GitHub pre-release `nightly-<date>` through the Releases API (no Actions needed) on each day with a merge, keeping the last seven, with `Aman-Setup.cmd`, its SHA-256 and `TEST-SHEET.md`: the checks added by that day's PRs in plain steps with one "Screenshot:" line each, then the standing checks below. Failures become next-day fix PRs. A `.cmd` needs no build, so the nightly is the file itself.
- **The standing checks**, all before v0.2.0 on a PC that starts with no Docker Desktop, with a stopwatch and a click counter:
  - N1. Sandbox: `Aman-Setup.cmd doctor` shows the sandbox passing, and a chat runs a Python snippet. This decides the sandbox flag.
  - N2. The full first install from the release page, counting clicks and waits against the table, reading every message aloud for jargon.
  - N3. Restart the PC; the desktop icon opens a working Aman.
  - N4. Close the window mid-build; run the file again; it continues.
  - N5. Run the file again on an installed PC: "Already up to date." Then against a second tag: the upgrade runs and the chats are still there.
  - N6. Edge, Chrome and Firefox open `http://127.0.0.1:8791` with no warning.
  - N7. Failure paths: Docker Desktop closed when the icon is clicked; a PC with virtualization off.

## Build plan

Target: 2 to 3 days. Each PR gets the six standing reviewers (SCOPE/USER, SECURITY, EFFICIENCY/CODE QUALITY, INTEGRATION, PM, QA/TEST) and merges after them; there is no CI gate. Mac and Linux are untouched.

1. **`installer/windows/Aman-Setup.cmd` and the nightly.** The file above with install, `open` and `doctor`; the embedded setup Dockerfile with pinned digests; `pnpm test:installer-windows` (Pester on Linux) and `pnpm lint:installer-windows` (PSScriptAnalyzer); the `install.sh` contract test; `pnpm installer:nightly-windows` that publishes the pre-release with the SHA-256 and the sheet from `installer/windows/owner-tests/`; a Windows section in `docs/install.mdx` with the two warning screenshots, the click count, the build wait and the one sentence on building from source; the README pointing Windows people at the release page. Proven on Linux as above. Owner: N1 to N7 from the first nightly. N1 decides the sandbox flag, which goes in as a one-line follow-up if needed.
2. **Fixes from the nightly, and the release page.** Whatever N1 to N7 find, plus uploading `Aman-Setup.cmd` and its SHA-256 to the v0.2.0 release through the Releases API. Owner: N2 from the real release page on a clean PC. v0.2.0 is cut when that pass is clean.

## Later, if friends need it

A full cross-platform installer in TypeScript, one executable per platform with Windows ACLs, Task Scheduler backups, a local certificate authority with a trust page for phones on the home network, upgrade with self-update, removal through Settings, and the shell installer retired behind it, is designed in the earlier revision of this spec: [commit fca8605](https://github.com/ClimbOutLabs/amanuensis/blob/fca8605ec84f4e78a65bf34d5a3b5cfc6bf7de60/specs/windows-installer.md). It becomes worth building when a friend wants Aman on their phone, wants backups they can see, or when the owner wants Mac and Linux off the shell. Everything in this spec carries over: the state layout, the Docker volumes and the install command line stay the same.
