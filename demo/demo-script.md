# Demo script for the judges

Aman, Personal AI track, Nebius x NVIDIA Global AI Hackathon. Live version: 2 minutes. Video version: 3 minutes (same beats, with the pauses marked below). The persona is Maya, an invented person; every name, address and file in the demo world is made up. She lives in Lisbon. Her inbox is a test Gmail account seeded with invented mail in three languages only: English, Portuguese and Spanish.

Judging criteria, short names used below: **Tech** (technological implementation), **Design**, **Impact** (potential impact), **Idea** (quality of the idea).

Two beats lean on work still being built: calendar reading (read-only Google Calendar) and Word document reading in the sandbox. They are marked **depends on Calendar read and .docx support**, each with a fallback that works today.

## Opening hook (10 seconds)

Screen: the empty New Chat page of the judges' instance, signed in as Maya, model picker showing the Nemotron model.

Presenter: "Your AI assistant knows your mother's birthday, your boss's mood and your secrets. Whose computer is it on? Yours. Aman runs on your machine, remembers you, and asks before every send. NVIDIA Nemotron on Nebius does the thinking."

## Beats

### 1. Memory (20 seconds) serves Idea, Tech

- Type: `Morning. Anything I should keep in mind today?`
- On screen: Aman answers from memory without being told anything in this chat: the 4 pm check-up with Dr. Halloran at the clinic, bring the referral letter and the insurance card from the blue wallet, and Teo's coffee suggestion. The "recalled from memory" marker shows on the turn.
- Presenter: "New chat, nothing typed yet, and it already knows today. That memory is a folder of text files on this machine."
- Fallback: if recall returns nothing, type `What do you remember about how I like my messages written?` and let Aman answer from memory live.

### 2. Inbox triage with a non-English email (20 seconds) serves Impact, Design

- Type: `What's in my inbox? One line each, in English.`
- On screen: one line per message: the flight confirmation, the dentist reminder, the landlord's repair visit, the Portuguese internet bill with its amount in euros, and the Spanish message from Marta asking which day suits for lunch on the weekend.
- Presenter: "Three languages in that mailbox. Aman reads them all and gives Maya her day in one screen."
- Video pause: hover the Spanish line so the original text is visible for a second.
- Fallback: if the model stalls on the full list, type `Read me the message from Marta` and show only that one.

### 3. Draft, approval card, send (30 seconds) serves Tech, Design

- Type: `Reply to Marta in Spanish: Saturday works, 1 pm, her choice of place. Keep it warm and short.`
- On screen: the draft appears in the chat with recipient, subject and body, in Marta's thread. Then the approval card: who it goes to, the subject, a body preview, and four buttons: **Approve**, **Approve for this chat**, **Always allow**, **Deny**.
- Presenter: "Nothing leaves this computer until I press this. Approve once, approve for this chat, or always. And a setting you turn off stays off."
- Click **Approve**. On screen: "Sent" in the thread, with the reply shown under Marta's message.
- Fallback: if the send fails with a provider error, the card keeps the draft and shows Retry; press it once. If Gmail is disconnected, show the draft only and say "the card is the only door out, and today it stays shut."

### 4. Attachments in the sandbox (30 seconds) serves Tech, Impact

- Type: `How much is the power bill and when is it due? Read the attached statement.`
- On screen: Aman opens the PDF, the sandbox indicator appears briefly, and the answer comes back: 184.62 dollars due November 5, account number and usage from the statement.
- Presenter: "The PDF never left the machine. It was opened in a sealed box with no network, read, and closed."
- Then type: `And the Word document the landlord sent?` **Depends on Calendar read and .docx support.** On screen: a two-line summary of the repair notice: the plumber comes on a weekday morning next week, please confirm.
- Presenter: "Same box, any file."
- Fallback: if the sandbox is unavailable, Aman says so and offers the open-in-Gmail link; the bill's amount is also in the email body, so ask Aman to read the message and say the sandbox is the backup reader for scans. If Word reading is not merged, skip the second question.

### 5. Scheduled morning brief that waits (30 seconds) serves Idea, Design

- Click: left rail, **Schedules**, then **Run now** on "morning briefing" (the live run takes under a minute; in the video, cut to the finished run).
- On screen: the run's chat lists today's mail and calendar, then notes that her mother's birthday is in three days (**depends on Calendar read**), and ends with a box titled **Needs your OK**: "Aman held these for you. Nothing has been done yet." Inside it: a draft birthday message to her mother, and a draft reply confirming the plumber visit, each with Approve and Deny.
- Presenter: "Every morning Aman reads the inbox and the calendar and prepares what Maya would want sent. It never sends while she sleeps. It waits."
- Click **Deny** on both held drafts so the demo world stays clean.
- Fallback: if Calendar is not merged, the brief holds only the plumber reply, which works today. If the run stalls, press **Run now** again, or type the schedule's task text into a new chat and let Aman do it live.

### 6. Close (10 seconds) serves Idea

- Screen: Settings, Memory, with the vault list and the recall toggle visible.
- Presenter: "Memory, mail, files, schedules: all on Maya's machine. The model is NVIDIA Nemotron on Nebius Token Factory, the only thing that ever sees a prompt, and it sees only what Maya approves. Aman is open source, one command to install."

## Recorded backup

Record the full 3-minute version once on the judges' instance the day before, at the same zoom, with the cursor visible. Keep it open in a second browser tab during the live demo. If any beat fails twice, switch tabs, play from that beat's timestamp, and keep talking over it. Note the start time of each beat while recording.

## Demo-world data each beat needs

Status key: **exists** (already in the demo seed or the mailbox fixtures on the test-mailbox branch), **add** (must be created before the demo). The mailbox fixtures in Arabic, Hindi, Japanese, Sinhala, Chinese, Russian and Persian are not delivered to Maya's account.

| Beat | Data                                                                                                                                                                                                                                               | Status                                                    |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| all  | Persona name "Maya", living in Lisbon. The seed names her Mara Hollis in Barcelona and the mailbox fixtures address Alex Rivera; both must say Maya, and the seed's places must move to Lisbon (seed world, fixture generator, expectations file). | add                                                       |
| all  | The judges' instance limits sends to a fixed list of invented addresses. Marta, Maya's mother and the landlord must be on it.                                                                                                                      | add                                                       |
| 1    | Memory notes: short friendly style, leaves 15 minutes early for medical visits, today's 4 pm check-up with Dr. Halloran, referral letter, blue wallet, Teo's coffee.                                                                               | exists (demo seed)                                        |
| 2    | Email, Portuguese: from Fibra Casa, subject "A sua fatura de outubro", body "42,18 euros debitados a 3 de novembro, fibra e linha móvel", with the bill as a PDF. Fixture 17 is the same bill in Spanish; translate it.                            | add (adapt fixture 17)                                    |
| 2, 3 | Email, Spanish: from Marta Jiménez, subject "¿Comemos el fin de semana?", body "¿Sábado o domingo? Elige el día y yo elijo el sitio." She is a friend visiting from Madrid; the reply goes to her thread.                                          | add                                                       |
| 2    | Emails, English: flight confirmation (fixture 01), dentist reminder (02), landlord repair visit (04). Fixture dates are fixed to October 2026; regenerate them a week ahead of the demo day.                                                       | exists, dates to refresh                                  |
| 3    | Gmail connected on the judges' instance with read and send grants, and the fixtures delivered to Maya's account with the send script.                                                                                                              | add                                                       |
| 4    | Email, English: from Metro Power and Light, subject "Your October bill is ready", body the amount and due date, with the PDF statement attached.                                                                                                   | exists (fixture 03, PDF included)                         |
| 4    | Email, English: from the landlord Maria Santos, subject "Repair notice", body "the notice is attached", with a one-page Word document stating the plumber's visit on a weekday morning next week.                                                  | add (depends on .docx support)                            |
| 5    | A schedule named "morning briefing" at 07:30 in the instance time zone, task: "Read my inbox and my calendar for the week. Draft anything I would want to send and hold it for me. Keep it short."                                                 | add (the seeded schedule maps a route; it drafts nothing) |
| 5    | Google Calendar connected read-only on the judges' instance, with an all-day event "Mum's birthday" three days after the demo day.                                                                                                                 | add (depends on Calendar read)                            |
| 5    | Email, English: from the landlord Maria Santos, subject "Kitchen faucet repair visit", body asking Maya to confirm a plumber visit on a weekday morning next week.                                                                                 | exists (fixture 04), date to refresh                      |
| 6    | Nothing beyond the seed.                                                                                                                                                                                                                           | exists                                                    |

## Pre-demo checklist

1. Reset and reseed the world (run on the judges' machine, from the repo root):
   ```
   ./installer/install.sh instance demo-seed --reset --instance main
   ./installer/install.sh instance demo-seed --instance main
   ```
2. Clear Maya's mailbox of yesterday's sent replies and held drafts, then redeliver the fixtures: `pnpm send-test-mailbox --dry-run`, check that only the English, Portuguese and Spanish messages are listed, then `pnpm send-test-mailbox`.
3. Model: `aman doctor` shows Token Factory on with the Nemotron model, and a test chat answers in under 5 seconds. The key was given at install time with `--token-factory-key-stdin`; never paste it on screen.
4. Gmail and Calendar: Settings, Connectors shows Gmail connected with read and send, and Calendar connected read-only; the send allowlist holds Marta, Maya's mother and the landlord; the morning schedule has run once today without error.
5. Sandbox: Settings, Sandbox shows the image downloaded and the signature verified; press Re-check.
6. Memory: Settings, Memory shows recall on and the seeded notes present.
7. Browser: a fresh window, 125 percent zoom, sidebar open, no other tabs except the backup recording, notifications off, dark or light theme matching the slides.
8. Presenter machine: screen sharing tested at the same zoom, laptop on power, clock set to the instance time zone.
9. Backup video opened and paused at 0:00 in the second tab.
10. Say the hook out loud once before going on.
