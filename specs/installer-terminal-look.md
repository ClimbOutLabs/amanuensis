# Installer and doctor terminal look

Status: approved

## Problem

On Mac and Linux, Aman is installed, upgraded and checked from the terminal:
`installer/install.sh`, `aman upgrade` and `aman doctor`. Their output is plain
lines under bold headings. A long install is hard to scan: the steps blend into
each other, the moment the run stops to ask a question is easy to miss, and the
result at the end does not stand out. `aman upgrade` has no headings at all, and
`aman doctor` leaves its problems scattered through a long report.

## The change

One look for all three commands, set in the shared style file
`installer/lib/ui.sh`:

- A banner at the top in a box: the name, then what the run does.
- Each step sits in a framed panel. The panel's top line carries a badge such
  as `4 of 6`, the step in bold, and at its right end a bar that fills up as
  the run goes on. Each part of the doctor report is a panel too, with the
  part's name and a count of what it found, such as `4 ok, 1 problem`.
- A command the run starts inside a step, such as the doctor's summary or the
  sandbox setup, prints its lines inside that step's panel, not a panel of its
  own (`AMAN_UI_FRAMED=1` tells it so).
- A line too long for the panel, such as a fingerprint, keeps only the left
  side, so the long word stays whole.
- A separator line, "Your answer is needed", before each group of questions,
  so a person sees at once that the run waits for them. The rules or hints for
  a question sit under it. Questions stand outside the step's panel: it closes
  before them and a plain panel opens again for the lines after them.
- Elapsed times line up at the right edge.
- The verdict at the end sits in a box colored by how the run went (green,
  yellow or red). Only the verdict is boxed in the closing block: the
  addresses and commands under it stay unframed, so they copy cleanly. A closing rule ends the block, with the
  total time.
- `aman upgrade` gets the same banner, four numbered steps and verdict box.
- `aman doctor` lists every problem and warning again in its closing block,
  each with its Next step.
- Commands a person should copy are printed on a line of their own and never
  wrapped.

Fallbacks:

- Colors are the terminal's own 16 colors, so they follow its light or dark
  theme.
- `NO_COLOR` turns color off; the badges become `[ 4 of 6 ]` and the bar uses
  two kinds of line for done and to do.
- Output that is not a terminal (a pipe or a log) has no color codes.
- Without a UTF-8 language setting, boxes, bars and markers are plain ASCII.

Nothing the commands do changes: the same checks, questions, defaults, exit
codes and files. Only the way the output looks changes.

## Privacy

No data is involved. The output is printed on the person's own terminal and
nothing is sent anywhere.

## Testing

The installer suite runs the real installer against stubs, with synthetic
names, emails and addresses only. `installer/tests/ui-fixtures.txt` pins the
exact rendering of each style helper in color, without color, not on a
terminal, and in ASCII. `installer/tests/lib/look.test.sh` runs install,
upgrade and the doctor end to end in color, with `NO_COLOR`, and into a pipe,
checks the question separator on a terminal, and checks that every box closes
at the same width. It runs in CI and every night.

## Out of scope

- A full-screen terminal interface. It would lose the scrollback and break
  copy and paste, SSH sessions and scripts.
- The wording of the doctor's individual checks, which the Windows installer
  shares.
- The Windows installer program in `packages/aman-installer`.
