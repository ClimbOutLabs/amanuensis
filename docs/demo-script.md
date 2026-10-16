# Demo script for the judges

Aman, Personal AI track, Nebius x NVIDIA Global AI Hackathon. Live version: 2 minutes. Video version: 3 minutes (same beats, with the two optional pauses marked below). The persona is Maya, an invented person; every name, address and file in the demo world is made up.

Judging criteria, short names used below: **Tech** (technological implementation), **Design**, **Impact** (potential impact), **Idea** (quality of the idea).

## Opening hook (10 seconds)

Screen: the empty New Chat page of the judges' instance, signed in as Maya, model picker showing the Nemotron model.

Presenter: "Your AI assistant knows your mother's birthday, your boss's mood and your secrets. Whose computer is it on? Yours. Aman runs on your machine, remembers you, and asks before every send. NVIDIA Nemotron on Nebius does the thinking."

## Beats

### 1. Memory (20 seconds) serves Idea, Tech

- Type: `Morning. Anything I should keep in mind today?`
- On screen: Aman answers from memory without being told anything in this chat: the 4 pm check-up with Dr. Halloran at the clinic, bring the referral letter and the insurance card from the blue wallet, and Teo's coffee suggestion. The small "recalled from memory" marker shows on the turn.
- Presenter: "New chat, nothing typed yet, and it already knows today. That memory is a folder of text files on this machine."
- Fallback: if recall returns nothing, open the chat "Brief me before my 4 pm appointment" from the left rail; it is the same answer, already stored.

### 2. Inbox triage with a non-English email (25 seconds) serves Impact, Design

- Type: `What's in my inbox? One line each, in English.`
- On screen: a list of one line per message: the flight confirmation, the dentist reminder, the landlord's repair visit, the dinner invitation, and the Hindi message from Priya inviting Maya to her mother's birthday dinner on Sunday the 8th, with a request to bring dessert. The Spanish internet bill shows its amount in euros.
- Presenter: "Eight languages in that mailbox. Aman reads them all and gives Maya her day in one screen."
- Video pause: hover the Hindi line so the original text is visible for a second.
- Fallback: if the model stalls on the full list, type `Read me the message from Priya` and show only that one.

### 3. Draft, approval card, send (35 seconds) serves Tech, Design

- Type: `Reply to Priya in English: I'd love to come, I'll bring the dessert. Keep it warm and short.`
- On screen: the draft appears in the chat with recipient, subject and body, in Priya's thread. Then the approval card: who it goes to, the subject, a body preview, and four buttons: **Approve**, **Approve for this chat**, **Always allow**, **Deny**.
- Presenter: "Nothing leaves this computer until I press this. Approve once, approve for this chat, or always. And a setting you turn off stays off."
- Click **Approve**. On screen: "Sent" in the thread, with the sent reply shown under Priya's message.
- Fallback: if the send fails with a provider error, the card keeps the draft and shows Retry; press it once. If Gmail is disconnected, show the draft only and say "the card is the only door out, and today it stays shut."

### 4. PDF attachment in the sandbox (25 seconds) serves Tech, Impact

- Type: `Summarise the attachment on the Arabic hotel email.`
- On screen: Aman opens the attachment, the sandbox indicator appears briefly, and the summary comes back in English: Palm Oasis Hotel, booking PO-7391, check-in Friday October 30, check-out Sunday November 1, sea-view double room, 420 dollars.
- Presenter: "The PDF never left the machine. It was opened in a sealed box with no network, read, and closed."
- Fallback: if the sandbox is unavailable, Aman says so and offers the open-in-Gmail link; switch to the power bill email, whose body already states the amount, and say the sandbox is the backup reader for scans.

### 5. Scheduled morning brief that waits (25 seconds) serves Idea, Design

- Click: left rail, **Schedules**, then **Run now** on "morning briefing" (the live run takes under a minute; in the video, cut to the finished run).
- On screen: the run's chat ends with a box titled **Needs your OK**: "Aman held these for you. Nothing has been done yet." Inside it, the draft reply to the landlord confirming the plumber visit, with Approve and Deny.
- Presenter: "At 7:30 every morning Aman reads the inbox and prepares replies. It never sends while Maya sleeps. It waits."
- Click **Deny** on the held draft so the demo world stays clean.
- Fallback: open this morning's run from the schedule's history, which already ended in the same box; if no run exists, show the schedule's task text and the seeded briefing chat.

### 6. Close (10 seconds) serves Idea

- Screen: Settings, Memory, with the vault list and the recall toggle visible.
- Presenter: "Memory, mail, files, schedules: all on Maya's machine. The model is NVIDIA Nemotron on Nebius Token Factory, the only thing that ever sees a prompt, and it sees only what Maya approves. Aman is open source, one command to install."

## Recorded backup

Record the full 3-minute version once on the judges' instance the day before, at the same zoom, with the cursor visible. Keep it open in a second browser tab during the live demo. If any beat fails twice, switch tabs, play from that beat's timestamp, and keep talking over it. Timestamps to note while recording: start of each beat.

## Demo-world data each beat needs

Status key: **exists** (already in the demo seed or the mailbox fixtures), **add** (must be created before the demo).

| Beat | Data                                                                                                                                                                                                                                      | Status                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| all  | Persona name "Maya". The seed names her Mara Hollis and the mailbox fixtures address Alex Rivera; both must say Maya (seed world, fixture generator, expectations file).                                                                  | add                                                       |
| 1    | Memory notes: short friendly style, leaves 15 minutes early for medical visits, today's 4 pm check-up with Dr. Halloran, referral letter, blue wallet, Teo's coffee.                                                                      | exists (demo seed)                                        |
| 1    | A pre-written chat "Brief me before my 4 pm appointment" as the fallback.                                                                                                                                                                 | exists (demo seed)                                        |
| 2    | Email, Hindi: from Priya Nair, subject an invitation, body "Mother's birthday dinner at home on Sunday November 8, from 6 pm, bring your favourite dessert."                                                                              | exists (fixture 14)                                       |
| 2    | Email, Spanish: from Fibra Hogar, subject "Your October bill is ready", body "42.18 euros charged on November 3 for fibre and a mobile line."                                                                                             | exists (fixture 17)                                       |
| 2    | Emails, English: flight confirmation (fixture 01), dentist reminder (02), landlord repair visit (04), dinner plans from Jordan (07). Dates in the fixtures are fixed to October 2026; regenerate with dates a week ahead of the demo day. | exists (fixtures), dates to refresh                       |
| 3    | Gmail connected on the judges' instance with read and send grants, and the fixtures delivered to that mailbox with the send script.                                                                                                       | add                                                       |
| 4    | Email, Arabic: from Palm Oasis Hotel, subject a booking confirmation, body the booking PO-7391 for October 30 to November 1, with a text PDF repeating the confirmation.                                                                  | exists (fixture 13, PDF included)                         |
| 5    | A schedule named "morning briefing" at 07:30 in the instance time zone, task: "Read my inbox. For anything that needs a reply, draft one in my voice and hold it for me."                                                                 | add (the seeded schedule maps a route; it drafts nothing) |
| 5    | Email, English: from the landlord Maria Santos, subject "Kitchen faucet repair visit", body asking Maya to confirm a plumber visit on a weekday morning next week.                                                                        | exists (fixture 04), date to refresh                      |
| 6    | Nothing beyond the seed.                                                                                                                                                                                                                  | exists                                                    |

## Pre-demo checklist

1. Reset and reseed the world (run on the judges' machine, from the repo root):
   ```
   ./installer/install.sh instance demo-seed --reset --instance main
   ./installer/install.sh instance demo-seed --instance main
   ```
2. Clear the demo mailbox of yesterday's sent replies, then redeliver the fixtures: `pnpm send-test-mailbox --dry-run`, check the list, then `pnpm send-test-mailbox`.
3. Model: `aman doctor` shows Token Factory on with the Nemotron model, and a test chat answers in under 5 seconds. The key was given at install time with `--token-factory-key-stdin`; never paste it on screen.
4. Gmail: Settings, Connectors shows Gmail connected with read and send; the morning schedule has run once today without error.
5. Sandbox: Settings, Sandbox shows the image downloaded and the signature verified; press Re-check.
6. Memory: Settings, Memory shows recall on and the seeded notes present.
7. Browser: a fresh window, 125 percent zoom, sidebar open, no other tabs except the backup recording, notifications off, dark or light theme matching the slides.
8. Presenter machine: screen sharing tested at the same zoom, laptop on power, clock set to the instance time zone.
9. Backup video opened and paused at 0:00 in the second tab.
10. Say the hook out loud once before going on.
