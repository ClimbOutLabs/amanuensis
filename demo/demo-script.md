# Demo script for the judges

Aman, Personal AI track, Nebius x NVIDIA Global AI Hackathon. Live version: 2 minutes. Video version: 3 minutes (same beats, with the pauses marked below). The persona is Maya, an invented person; every name, address and file in the demo world is made up. She lives in Lisbon. Her inbox is a test Gmail account seeded with invented mail in three languages only: English, Portuguese and Spanish.

Judging criteria, short names used below: **Tech** (technological implementation), **Design**, **Impact** (potential impact), **Idea** (quality of the idea).

## Opening hook (10 seconds)

Screen: the empty New Chat page of the judges' instance, signed in as Maya, model picker showing the Nemotron model.

Presenter: "Your AI assistant knows your mother's birthday, your boss's mood and your secrets. Whose computer is it on? Yours. Aman runs on your machine, remembers you, and asks before every send. NVIDIA Nemotron on Nebius does the thinking."

## Beats

"On screen" says what the presenter types and which parts of the interface appear. It never fixes Aman's wording or figures: the answers are generated live. The facts each answer should carry are listed per fixture in `fixtures/mailbox/EXPECTATIONS.md`; check them there during rehearsal.

The demo day is Monday 19 October 2026. Maya rents at Travessa das Gaivotas 4 in Lisbon and has a GP appointment on Thursday 22 October 2026 at 09:30 with Dra. Helena Rocha at Brightwater Family Clinic.

### 1. Memory (20 seconds) serves Idea, Tech

- Type: `Morning. Anything I should keep in mind this week?`
- On screen: Aman answers without being told anything in this chat, drawing on Maya's memory notes and her mail. The memory marker shows on the turn. Rehearsal check: Thursday's GP appointment and what to bring come up (fixtures 02 and 25 in EXPECTATIONS.md).
- Presenter: "New chat, nothing typed yet, and it already knows her week. That memory is a folder of text files on this machine."
- Fallback: if recall returns nothing, type `What do you remember about how I like my messages written?` and let Aman answer from memory live.

### 2. Inbox triage across three languages (20 seconds) serves Impact, Design

- Type: `What's in my inbox? One line each, in English.`
- On screen: one line per message, in English. Among them: the GP confirmation from Brightwater Family Clinic (sent in English and again in Portuguese), the Luz do Tejo electricity bill and Teresa Matos's repair visit (both Portuguese), and Lucía Navarro's lunch invitation (Spanish). Check each line against EXPECTATIONS.md.
- Presenter: "Three languages in that mailbox. Aman reads them all and gives Maya her week in one screen."
- Video pause: hover the Spanish line so the original text is visible for a second.
- Fallback: if the model stalls on the full list, type `Read me the message from Lucía` and show only that one.

### 3. Draft, approval card, send (30 seconds) serves Tech, Design

- Type: `Reply to Lucía in Spanish: Thursday works, she picks the place. Keep it warm and short.`
- On screen: a draft in Lucía's thread with recipient, subject and body, written by Aman live. Then the approval card: who it goes to, the subject, a body preview, and four buttons: **Approve**, **Approve for this chat**, **Always allow**, **Deny**.
- Presenter: "Nothing leaves this computer until I press this. Approve once, approve for this chat, or always. And a setting you turn off stays off."
- Click **Approve**. On screen: the thread shows the reply as sent, under Lucía's message.
- Fallback: if the send fails with a provider error, the card keeps the draft and shows Retry; press it once. If Gmail is disconnected, show the draft only and say "the card is the only door out, and today it stays shut."

### 4. Attachments in the sandbox (30 seconds) serves Tech, Impact

- Type: `How much is the electricity bill and when is it due? Read the attached statement.`
- On screen: Aman opens the Luz do Tejo PDF, the sandbox indicator appears briefly, and the answer gives the amount, the due date and how to pay. Check the facts against fixture 03 in EXPECTATIONS.md.
- Presenter: "The PDF never left the machine. It was opened in a sealed box with no network, read, and closed."
- Then type: `And the Word document Teresa sent?` On screen: a short summary of Teresa Matos's repair notice (fixture 04 in EXPECTATIONS.md).
- Presenter: "Same box, any file."
- Fallback: if the sandbox is unavailable, Aman says so and offers the open-in-Gmail link; the bill's details are also in the email body, so ask Aman to read the message and say the sandbox is the backup reader for scans.

### 5. Scheduled morning brief that waits (30 seconds) serves Idea, Design

- Click: left rail, **Schedules**, then **Run now** on "morning briefing" (the live run takes under a minute; in the video, cut to the finished run).
- On screen: the run's chat covers this week's mail and calendar, including Thursday's GP appointment, and her mother's birthday in three days. It ends with the **Needs your OK** box, with Aman's held drafts inside, each with Approve and Deny. Rehearsal check: the drafts include a reply to Teresa Matos about the plumber visit; the brief should mention the GP visit and the allergy Maya's memory holds (fixture 25 in EXPECTATIONS.md).
- Presenter: "Every morning Aman reads the inbox and the calendar and prepares what Maya would want sent. It never sends while she sleeps. It waits."
- Click **Deny** on every held draft so the demo world stays clean.
- Fallback: if the run stalls, press **Run now** again, or type the schedule's task text into a new chat and let Aman do it live.

### 6. Close (10 seconds) serves Idea

- Screen: Settings, Memory, with the vault list and the recall toggle visible.
- Presenter: "Memory, mail, files, schedules: all on Maya's machine. The model is NVIDIA Nemotron on Nebius Token Factory, the only thing that ever sees a prompt, and it sees only what Maya approves. Aman is open source, one command to install."

## Recorded backup

Record the full 3-minute version once on the judges' instance the day before, at the same zoom, with the cursor visible. Keep it open in a second browser tab during the live demo. If any beat fails twice, switch tabs, play from that beat's timestamp, and keep talking over it. Note the start time of each beat while recording.

## Demo world by beat

Only the demo set is delivered to Maya's account: English, Portuguese and Spanish. The other fixtures stay in the repo for tests. The demo set is `fixtures/mailbox/demo-set.json`.

| Beat    | Data in the demo world                                                                                                                                                                             |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| all     | Maya in Lisbon: rental at Travessa das Gaivotas 4, memory notes (short friendly style, penicillin allergy, the GP appointment on Thursday 22 October 2026 at 09:30).                               |
| all     | The judges' instance sends only to a fixed list of invented addresses: Lucía Navarro, Teresa Matos and Maya's mother.                                                                              |
| 1, 5    | GP appointment with Dra. Helena Rocha at Brightwater Family Clinic, Thursday 22 October 2026 at 09:30: fixture 02 (English) and fixture 25 (Portuguese, then English).                             |
| 2, 3    | Lunch invitation from Lucía Navarro, in Spanish: fixture 23. The reply goes to her thread.                                                                                                         |
| 2, 4    | Electricity bill from Luz do Tejo Energia, in Portuguese, with the PDF statement: fixture 03.                                                                                                      |
| 2, 4, 5 | Repair visit from the landlord Teresa Matos, in Portuguese, with the notice as a .docx: fixture 04.                                                                                                |
| 2       | The rest of the demo set (flight, parcel, dinner, camera order, phishing test, hiking thread, design review, scanned note, Portuguese homework, bakery order, photo walk).                         |
| 3       | Gmail connected on the judges' instance with read and send grants, and the demo set imported into Maya's account.                                                                                  |
| 5       | A schedule named "morning briefing" at 07:30 in the instance time zone, task: "Read my inbox and my calendar for the week. Draft anything I would want to send and hold it for me. Keep it short." |
| 5       | Google Calendar connected read-only on the judges' instance, with an all-day event "Mum's birthday" three days after the demo day.                                                                 |
| 6       | Nothing beyond the seed.                                                                                                                                                                           |

## Pre-demo checklist

1. Reset and reseed the world (run on the judges' machine, from the repo root):
   ```
   ./installer/install.sh instance demo-seed --reset --instance main
   ./installer/install.sh instance demo-seed --instance main
   ```
2. Clear Maya's mailbox of yesterday's sent replies and held drafts, then reload the demo set: `pnpm demo:import-mailbox --dry-run`, check that only the English, Portuguese and Spanish messages are listed, then `pnpm demo:import-mailbox`.
3. Model: `aman doctor` shows Token Factory on with the Nemotron model, and a test chat answers in under 5 seconds. The key was given at install time with `--token-factory-key-stdin`; never paste it on screen.
4. Gmail and Calendar: Settings, Connectors shows Gmail connected with read and send, and Calendar connected read-only; the send allowlist holds Lucía Navarro, Teresa Matos and Maya's mother; the morning schedule has run once today without error.
5. Sandbox: Settings, Sandbox shows the image downloaded and the signature verified; press Re-check.
6. Memory: Settings, Memory shows recall on and the seeded notes present.
7. Browser: a fresh window, 125 percent zoom, sidebar open, no other tabs except the backup recording, notifications off, dark or light theme matching the slides.
8. Presenter machine: screen sharing tested at the same zoom, laptop on power, clock set to the instance time zone.
9. Backup video opened and paused at 0:00 in the second tab.
10. Say the hook out loud once before going on.
