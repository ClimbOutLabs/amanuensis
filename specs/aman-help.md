# aman help

Status: draft

## Problem

On Mac and Linux, typing `aman` with a command it does not know, or `aman help`, printed the
usage text of every command at once: about 25 lines of flags, with no grouping. It was hard to
find the one command you wanted, and `aman help` was not a command at all (it printed
"Unknown command: help" and then the wall).

## The change

- `aman help`, `aman -h`, `aman --help` and a bare `aman` print one short screen: every command
  once, in four groups (every day, when something is wrong, your data, advanced), one plain line
  each. The screen has no flags on it.
- `aman help COMMAND` and `aman COMMAND --help` print that command's page: what it does, its
  usage line, and each option with one line. `aman doctor` shows its topics and the sandbox
  options too.
- A mistyped command or option prints the mistake and "Run aman help to see what each command
  does." on the error output, and exits 2 as before. The usage wall is gone.
- The text lives in `installer/lib/help.sh` and uses the shared terminal style (`ui.sh`), so it
  gets the same color, plain-locale and non-terminal behavior as the rest of the installer.
  `aman help` writes to the standard output and exits 0.

## Scope

New commands (such as `aman address`) add one row to the overview and one page to `help.sh`.
A test fails when the aman command dispatches a command that has no page.

## Privacy

Fixed text only. Nothing is read from instances or sent anywhere.

## Testing

`installer/tests/lib/help.test.sh`: the overview lists every command once; the flags and a bare
`aman` show the same overview; every command has a page from both forms; unknown names exit 2
with the hint; color, no color and ASCII modes; no line wider than the screen; the help file is
installed with the command. Tests use no personal data.

## Out of scope

The Windows `Aman-Setup.exe` command line, and any change to what the commands do.
