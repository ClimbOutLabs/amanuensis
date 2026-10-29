# Aman installer

One executable that sets up Aman on Windows, Mac and Linux. It is built from
this package and grows around the shell installer: at first it only answers
questions about the computer it runs on, and later stages move the install
jobs into it one at a time.

What it can do today:

- `aman --version` prints its version.
- `aman doctor` checks this computer (Docker, its runtime, its credential
  store, the images, free disk, memory, the clock, backups, the sandbox
  slots, the folder Aman was installed from, and https) and then each
  instance, by running the instance's own doctor inside its app container.
  On Windows it also checks that the folders Aman keeps on the PC itself
  can be read by the person's own account only. `aman doctor --json`
  prints the same checks as data. With `aman doctor --local` the
  instances' own checks skip the ones that reach the network, as the
  health gate before an upgrade needs. `aman doctor --fix` makes the
  Windows folders private when they are not; that is the one fix the
  doctor applies itself, and it belongs to that check only. Apart from
  it, the doctor changes nothing.
- `aman doctor docker` checks that Docker is installed, running, has its
  Compose tool, has at least 6 GB of memory to work with, and that its
  Engine is new enough for Aman's https on this computer, and reports its
  Engine version. Each failed check says the one thing to do next, in the
  words of the system it is running on.
- `aman status` says what is installed and whether each instance is
  running.
- `aman install`, on Windows, is the first install, what Aman-Setup.exe
  does on a computer with no Aman yet: it installs Docker Desktop first
  when it is missing (the download is checked against Docker Inc's
  signature before it runs, and a resume entry is set so an install a
  restart stops is carried on from), checks Docker's memory before
  asking anything, asks the four questions (an email, a password, the
  model key, and whether to open Aman to the phone), and runs the
  shell's installer in the setup container with https on this computer
  and daily backups. Then the steps the earlier commands added run in
  their order: the adopt step puts the command and the Start menu
  entries in place, the folder Aman keeps on the PC is made private,
  Aman opens in the browser, and the home network is opened when the
  phone answer was yes. At the end a short getting started page opens
  in the browser; the page is also saved in the Amanuensis folder.
  `aman install --dry-run` prints what it would do and does nothing.
  Running Aman-Setup.exe with no command does what the computer in
  front of it needs: this install, the adopt step on a starter PC, or
  the upgrade on an installed one.
- `aman open`, on Windows, starts Docker if it needs to, waits for Aman
  to answer, and opens it in the browser. An Aman served over https on
  this computer opens at its https address, after this computer is set
  to trust the authority that made its certificate.
- `aman open`, on Windows, starts Docker if it needs to, waits for Aman
  to answer, and opens it in the browser. An Aman served over https on
  this computer opens at its https address, after this computer is set
  to trust the authority that made its certificate.
- `aman verify` checks a downloaded file against its signed release
  record.
- `aman network open`, on Windows, opens Aman to the devices on the
  home network: it hands the installer this computer's private
  addresses (the setup container cannot see its adapters), lets those
  devices through the Windows firewall on Aman's ports, and prints
  the address and the scan code a phone uses. The Start menu entry
  "Use Aman on my phone" prints them again. `aman network close`
  closes Aman to the network again.
- `aman upgrade`, on Windows, updates Aman to the newest release whose
  signed record checks out: it gates on the local doctor, asks once
  before anything downloads, swaps the program in with the old one kept
  until the next start, and runs the shell's own upgrade in the setup
  container. The Start menu's Update Aman entry runs it, and so does
  running Aman-Setup.exe again on an installed PC.
- `aman backup`, on Windows, makes a backup now: it runs the shell's
  own backup in the setup container with the backups folder on the PC
  itself mounted where the shell writes, so the backup lands on the
  Windows disk, under the folder access the doctor's files check
  guards, and the shell's keep-the-last-seven rule prunes that folder.
  A daily Task Scheduler task, made by `aman adopt`, runs this command
  at 03:30 while the person is signed in; adopt also records the daily
  choice in the state record and adds a Backups entry to the Start
  menu. On Windows the doctor's backup check looks for that task and
  reads the ages of the backups from the folder they land in.
- `aman backups`, on Windows, lists the backups kept on the PC,
  newest first. The Start menu's Backups entry opens the folder.

Every sentence a person can read lives in `src/messages.ts`. A test checks
each one for plain words and compares them all to the golden file in
`tests/golden/messages.txt`. Every command line a flow would run on a
person's computer goes through a runner that tests can record; the recorded
lines are compared to golden files too.

Build the single executable with `pnpm build:aman-installer` from the
repository root. The bundle is made with esbuild and turned into one file
with Node's single executable support and postject.
