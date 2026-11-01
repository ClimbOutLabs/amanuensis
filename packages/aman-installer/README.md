# Aman installer

The TypeScript side of the Aman installer. Installing itself is the shell
installer's job (`installer/install.sh` in this repository); this package
reads the state that installer writes, in the layout `installer/STATE.md`
writes down, and it is the home of the `aman setup` wizard: a local web
page that drives the shell installer for the person.

What it can do today:

- `aman --version` prints its version.
- `aman setup` serves the guided setup wizard: a page on this computer
  only (127.0.0.1, a random port, a one-time token in the address) that
  checks the computer, asks who the install is for and the few choices
  that matter, shows the installer's plan, then runs the installer on
  its progress stream (`install.sh --events`) and reports the result.
  `--no-browser` prints the page's address instead of opening it.
  Running `aman` with no command on a computer with nothing installed
  opens the wizard too. The wizard adds no install steps of its own and
  changes nothing on a computer where Aman is already set up.
- `aman doctor` checks this computer (Docker, its runtime, its credential
  store, the images, free disk, memory, the clock, backups, the sandbox
  slots, the folder Aman was installed from, and https) and then each
  instance, by running the instance's own doctor inside its app container.
  `aman doctor --json` prints the same checks as data. With
  `aman doctor --local` the instances' own checks skip the ones that
  reach the network. The doctor changes nothing.
- `aman doctor docker` checks that Docker is installed, running, has its
  Compose tool, has at least 6 GB of memory to work with, and that its
  Engine is new enough for Aman's https on this computer, and reports its
  Engine version. Each failed check says the one thing to do next, in the
  words of the system it is running on.
- `aman status` says what is installed and whether each instance is
  running.

The state reads are folder reads: the state home is a folder on this
computer on every system the installer supports (Mac and Linux; Windows
is reached through WSL2, which is Linux here). The folder lock and its
timing follow the lock contract in `installer/STATE.md`, the same
contract the shell installer follows, so a lock taken by one is honoured
by the other.

Every sentence a person can read lives in `src/messages.ts`. A test checks
each one for plain words and compares them all to the golden file in
`tests/golden/messages.txt`. Every command line a flow would run on a
person's computer goes through a runner that tests can record; the recorded
lines are compared to golden files too.
