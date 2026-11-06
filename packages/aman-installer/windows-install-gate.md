# Windows install gate

Aman Setup is checked by hand on real Windows computers before each
release that changes it. This page is the checklist for that run and the
table where each run is recorded.

A run passes when every step does what [the Windows guide](../../docs/install-windows.md)
says, and every line the installer prints is one a non-technical person
understands and that says the one thing to do next. Anything else is a
bug. Note it in the run's row, file it, and fix it before the release
goes out. A fix to the code or the guide means that machine is run again.

## Before the first run

- [ ] The release page for the tag under test has `Aman-Setup.exe`,
      `SHA256SUMS`, `manifest.json` and `manifest.json.minisig`.
- [ ] On a computer that already has the `aman` command, download those
      four files into one folder. `aman verify Aman-Setup.exe` says the
      file matches the signed release record.
- [ ] `sha256sum -c SHA256SUMS` (or `Get-FileHash Aman-Setup.exe` in
      PowerShell, compared by eye) matches.
- [ ] A Together AI key is ready to paste.
- [ ] A phone is on the same Wi-Fi as the computer under test.
- [ ] A stopwatch, or the computer's clock, to time each run.

## The three computers

| Machine | Windows | Starts with |
| --- | --- | --- |
| A | Windows 11 Home, clean | No Docker Desktop, no WSL |
| B | Windows 10 22H2, clean | No Docker Desktop, no WSL |
| C | Windows 10 or 11 | Docker Desktop installed and running |

Machine C checks that Aman Setup uses the Docker Desktop that is already
there and does not install it again.

## Steps for each computer

Write down the clock time at step 1 and at step 12.

1. **Download.** Open the release page in the browser and download
   `Aman-Setup.exe`. Note the release tag.
2. **SmartScreen.** Open the file. Windows shows "Windows protected your
   PC". Choose **More info**, then **Run anyway**. Note the publisher
   Windows shows.
3. **Docker Desktop** (A and B only). Aman Setup downloads and installs
   Docker Desktop by itself. Note any window Docker's own installer
   shows, and whether it asks to turn on WSL or any other Windows
   feature.
   On C: confirm Aman Setup does not download or install Docker Desktop,
   and that Docker Desktop's version is the same before and after.
4. **Restart and resume** (A and B, when asked). Aman Setup says:
   "Docker Desktop needs your computer to restart before it can run.
   Restart your computer, and Aman Setup will open again by itself and
   carry on." Restart. After signing in again, Aman Setup opens by itself
   and says "Continuing where it left off." Note how long it took to
   appear after sign-in.
5. **The four questions.** In order:
   - "Your email, used to sign in:"
   - "Choose a password (at least 8 characters, not shown):", then
     "Type it again:"
   - "Paste your model key (not shown):" — on A and C leave it empty and
     press Enter (the Together key goes in at step 8). On B paste the
     Together key here, and note whether chat works after sign-in
     without adding it again in Settings.
   - "Also use Aman from your phone and other devices on your home
     Wi-Fi? (yes or no):" — answer **yes**.
   Also try one short password and one mismatched pair on one machine,
   and check the wording of what comes back.
6. **Aman opens.** The install runs, Aman opens in the browser at its
   https address with no certificate warning, and the getting started
   page opens. The last line is "Aman is installed, and the getting
   started page is open in your browser." Note whether Windows asked
   whether to trust a certificate, and whether the firewall asked for
   permission.
7. **Sign in** with the email and password from step 5.
8. **Add the Together key** in **Settings, Models** (A and C), and send
   one chat message that gets a reply.
9. **Daily brief.** Run the daily brief once and confirm it renders.
10. **Update Aman** from the Start menu. On the newest release it says
    "Aman is already up to date." When a newer test tag exists, it asks
    once, updates, and the chat from step 8 is still there.
11. **Use Aman on my phone** from the Start menu. It prints the phone
    address and scan code. Open it on the phone, on the same Wi-Fi, and
    sign in.
12. **Check Aman** from the Start menu. Every check passes, or the ones
    that do not say what to do. Stop the clock.

Then, on each computer:

- Restart the computer once more, sign in, and open Aman from the Start
  menu. Note whether it comes back without any other step.
- Check the Start menu has Aman, Check Aman, Update Aman, Backups and
  Use Aman on my phone, and that each opens what its name says.

## Watch for

- Any line that names a tool, a file path, a container, a port number
  without saying what it is, or a command a person would have to type.
- Any window from Docker Desktop's own setup that the guide does not
  mention (its licence page, its sign-in page, its WSL update).
- Any Windows setting the run changes that the person did not choose
  themselves.
- The getting started page: every place it names is where it says.

## Launch gate table

Fill one row per computer. Time is from step 1 to step 12, restarts
included. Result is Pass, or Fail with the bug links.

| Machine | Windows build | Release tag | Date | Who | Time | Docker Desktop before / after | Result | Bugs and doc fixes |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| A: Win 11 Home, clean | | | | | | none / | | |
| B: Win 10 22H2, clean | | | | | | none / | | |
| C: Docker Desktop running | | | | | | / | | |
