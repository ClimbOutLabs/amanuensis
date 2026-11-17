# Setup window for Aman Setup on Windows

Status: approved

## Problem

Aman Setup on Windows asks its questions in a black terminal window. People who are not used to a terminal find it hard to read: the password rule is only said in a sentence, nothing shows while the password is typed, and an hour of installer lines scroll past with no sign of how far along the install is.

## Solution

On a first install with a person at the computer, Aman Setup opens a normal Windows window with seven screens: Welcome, Check this computer, About you, Options, Review, Install and Done. The steps are listed down the side. The password rule is ticked off part by part as the password is typed. The Install screen ticks off each stage, with the installer's own lines under "Show details".

The install itself does not change. The window is a different way to ask the same three questions (email, password, phone) and to show the same steps.

## Key design decisions

- **A native window, not a web page.** The window is drawn by Windows PowerShell (WPF), which every supported Windows has. There is no local web server, no port and no browser, so nothing on the network or in a browser can reach the setup.
- **One fixed script.** The program starts Windows PowerShell by its full path inside the Windows folder, with a fixed command line, and feeds it one fixed script on standard input. The script is never written to disk. Nothing a person types and nothing the installer prints is ever made part of the script or of the window description; every word the window shows arrives as a message and is shown as plain text.
- **The program keeps the order.** The window only draws what it is told and sends back what the person did. The program decides which screen is shown and refuses any message the current screen does not allow.
- **One channel, typed frames.** Program and window talk over the window process's standard input and output. Each frame has a kind and a length, and the length is checked before the frame is read. The password travels in a frame kind of its own.
- **The password is bytes.** The window reads the password as protected text, copies it into pinned memory, sends the bytes and wipes them. The program keeps it as bytes, refuses line breaks and other control characters, hands it to the installer on standard input as before, and wipes it. It is never on a command line, in a file, or in a line that is shown.
- **The terminal stays.** `aman install --console` asks on the terminal. The terminal is also used when the window cannot be opened, for example where Windows PowerShell is restricted, and when the window is lost before the install starts. A window the person closes before the install ends the setup. Once the install has started, it runs to its end whether or not the window stays open.
- **Restart.** Docker Desktop is installed and any restart happens on the Check this computer screen, before anything is typed, so nothing typed has to survive a restart.

## Scope

- `packages/aman-installer`: the window (`src/window/`), the first install split into shared steps that report progress, the password kept as bytes, the installer's lines shown as they arrive.
- CI: the Windows build job opens the real window and walks through it.
- Docs: the Windows install guide, the troubleshooting page and the package README.

## Privacy

The email and password are typed on the person's own computer and go only to the installer running on that computer, as before. Nothing is sent anywhere else. The password is not written to disk, not put on a command line, and not shown in any progress line.

## Testing

All tests use made-up data.

- Unit tests for the frames, the messages, the order of the screens and the password handling, with a stand-in window.
- Tests that the script and the window description are fixed text, that what arrives from the program is only shown as plain text, and that the password is read as protected text only.
- On a Windows machine in CI, the real window is opened and walked from Welcome to Done through the Windows accessibility interface, with PowerShell's transcripts and script logging turned on, and a check that nothing typed reached them.

## Out of scope

- A window for Mac or Linux.
- Signing the program with a Windows publisher certificate.
- Setting up email, calendar or a model during the install.
- Any change to the shell installer.
