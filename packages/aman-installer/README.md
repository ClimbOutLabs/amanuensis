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
  `aman doctor --json` prints the same checks as data. It changes nothing.
- `aman doctor docker` checks that Docker is installed, running, has its
  Compose tool, has at least 6 GB of memory to work with, and reports its
  Engine version. Each failed check says the one thing to do next, in the
  words of the system it is running on.

Every sentence a person can read lives in `src/messages.ts`. A test checks
each one for plain words and compares them all to the golden file in
`tests/golden/messages.txt`. Every command line a flow would run on a
person's computer goes through a runner that tests can record; the recorded
lines are compared to golden files too.

Build the single executable with `pnpm build:aman-installer` from the
repository root. The bundle is made with esbuild and turned into one file
with Node's single executable support and postject.
