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
- `aman open`, on Windows, starts Docker if it needs to, waits for Aman
  to answer, and opens it in the browser. An Aman served over https on
  this computer opens at its https address, after this computer is set
  to trust the authority that made its certificate.
- `aman verify` checks a downloaded file against its signed release
  record.
- `aman upgrade`, on Windows, updates Aman to the newest release whose
  signed record checks out: it gates on the local doctor, asks once
  before anything downloads, swaps the program in with the old one kept
  until the next start, and runs the shell's own upgrade in the setup
  container. The Start menu's Update Aman entry runs it, and so does
  running Aman-Setup.exe again on an installed PC.

Every sentence a person can read lives in `src/messages.ts`. A test checks
each one for plain words and compares them all to the golden file in
`tests/golden/messages.txt`. Every command line a flow would run on a
person's computer goes through a runner that tests can record; the recorded
lines are compared to golden files too.

Build the single executable with `pnpm build:aman-installer` from the
repository root. The bundle is made with esbuild and turned into one file
with Node's single executable support and postject.
