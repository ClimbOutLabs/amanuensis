# Spec: The terminal app

**Status:** draft

## Problem

Aman is used from the web app, but a good deal of a person's work already happens in a terminal. A terminal needs its own way in. Signing in there with the person's password would hand a long-lived program the keys to everything, and there would be no clean way to take one terminal's access away without changing the password everywhere. The terminal also cannot show everything the web app shows, so its approval flow has to prove that nothing is approved unseen.

## Solution

A separate program, `aman-tui`, installed on the person's own computer. It pairs once with a one-time code the person confirms in the web app, and receives a terminal key of its own. The key stands in for the person only on the chat side of Aman. Inside the terminal, the person gets their chat list, streaming replies, tool calls as plain cards, and approvals that show the whole action before they can be answered. A one-shot mode answers a single question and exits.

Two rules do not bend:

1. **A terminal key reaches chats and nothing else.** Settings, connectors, and every owner-only surface refuse it, and the refusal happens on the server, not in the terminal program.
2. **An approval is answered only after the whole action has been shown.** Nothing is cut to fit the window, and Enter never approves, because Enter is how a message is sent.

## 1. Pairing

- `aman-tui login <address>` starts a pairing with `POST /api/v1/terminal-pairings`. The server answers with a pairing id, a one-time code of eight characters, the address of the confirm page with the code in it, and an expiry. Only a hash of the code is kept.
- The terminal shows the code in large clear text with the confirm link, and waits. The person, signed in to the web app as themselves, checks the code matches and confirms. Confirming is signed-in only and is attempt-limited like a password guess. A wrong, expired, or already used code is refused with one plain line that does not say which.
- The waiting terminal collects its key with the pairing id and the code. The key is handed over exactly once. After that the pairing is gone. Failed collections are counted, and a pairing is dropped after five.
- Pairing starts and confirms are rate-limited with the same budgets as the sign-in form. Every pairing, confirm, and revoke writes an audit entry, and no entry carries key material.
- The terminal's name is the name the person gives with `--name`, or the computer's host name when they give none. The name is what the person later sees in Settings.

## 2. Terminal keys

- A terminal key is a long-lived random key with a prefix that marks it as one, one per paired terminal per instance. The server keeps only a hash of it, with the device name and the paired and last used times.
- Both sign-in paths check a terminal-shaped key against that store before anything else. A revoked or unknown key is refused outright.
- Scope is enforced in one place on the server. A terminal key may reach the chat routes and chat search, and it may revoke its own pairing. Two things inside the chat routes are carved out: a chat's repository routes, which can clone code with the person's own account, and the route that downloads a file from a chat's sandbox. Admin and settings routes refuse a terminal key, and routes that exist only for the browser stay browser-only.
- There is no separate memory route for a terminal. Memory reaches a terminal only inside its chats, the way it reaches the web app.

## 3. Revoking a key

- Settings, under Account, lists the paired terminals with their names and paired and last used times, and each one can be revoked there. A revoke lands on the terminal's next request.
- On an Aman that keeps its own sign-in, changing the password takes away every terminal key at once. On an Aman that uses a sign-in service, the server never hears about a password change, so keys there are revoked in Settings, one by one or all together. The docs say this plainly.
- A confirmed pairing whose key is never collected leaves no working key behind. The stored row is revoked when the pairing is dropped.

## 4. Chatting

- The app opens on the active instance and lists its chats newest first, with the persona and when each was last active. Enter opens a chat. A new chat takes its agent from the person's newest chat. On an instance with no chats yet, the terminal says to start the first chat in the web app, because the route that lists agents is outside a terminal key's reach.
- Replies stream in as they are written. Tool calls appear as plain cards: a plain name taken from the tool's own name, one recognisable detail, and how the call ended. A picture or a file is replaced by a line offering the chat's web address to open in a browser.
- When the connection drops mid-reply, the terminal says the connection was lost and rejoins the same turn through the same resync the web app uses. The person can retry the rejoin at once with R. When the rejoin gives up, the line says the reply could not be rejoined and to send the message again. A refusal during the rejoin, such as a key revoked mid-turn, is shown as what it is, not as a lost connection.
- Esc stops a streaming reply through the same cancel the web app uses, and the part of the reply that arrived stays on screen with a line saying it was stopped.
- When the server refuses the key, the terminal shows a plain line saying the key is no longer accepted and naming the login command with the instance's address, instead of a raw error or a retry that can never work.

## 5. Approvals

- When a turn holds an action, the terminal shows the whole action in an approval view before any answer is possible. For an email send that is the account it sends from, who it goes to including copies and hidden copies, the subject, the whole message, and the files sent with it. Other actions show everything the server's card facts carry, in the web card's order and words. The view scrolls with the arrow keys and the page keys. Nothing is truncated.
- A approves once. Shift+A always allows, only when the server offers it, and never on a card about a new recipient: those cards never offer always allow, in the terminal as in the web app, whatever the server's flag says. D is the no choice, labelled the way the web card labels it. Enter does nothing in the approval view. Esc leaves the action unanswered for later.
- Email is a draft first, and sending it is a separate approval, exactly as the server holds it. The terminal never puts the two together.
- Answers go through the same continuation the web app sends, and the outcome is worded the way the web app words it. The three ways an answer can come too late each read in plain words: the chat moved on, the action was already answered, or the request ended. An answer the server refuses as too early leaves the approval on screen for another try.
- An action a scheduled run held for the person is waiting when the chat opens: the terminal reads the newest turn back and offers the same approval view for it.

## 6. One-shot mode

- `aman-tui "question"` asks one question on the active instance in a fresh chat, prints the answer, and exits. The exit code is zero only when an answer printed.
- A one-shot run never approves anything. When the turn ends holding an action, the run prints any partial reply, says the answer is waiting for an approval, and points to the terminal app and the web app. It makes no continuation call.

## 7. Where the key is kept

- The app keeps its own small files in one config folder: `.config/aman-tui` in the home folder on a Mac and on Linux (or the folder XDG_CONFIG_HOME names), and the `aman-tui` folder inside the AppData roaming folder on Windows. The folder is made readable only by the person's account, and the files in it are written the same way.
- On a Mac, the key is kept in the login keychain. On Linux, it is kept in the desktop secret service when one answers, with the key passed on standard input, and the app checks the service answers before trusting it. Everywhere else, including Windows and a Linux desktop with no secret service, the key is kept in a file in the config folder. On Windows that file carries no lock of its own and rests on the AppData folder being private to the person's account.
- One accepted limit on a Mac: the keychain tool that ships with the system takes the key as part of its command, so while the key is being saved, another program running under the same account that lists running program commands could see it. Saving takes under a second. The alternatives are an undocumented prompt flow, which could hang or break saving, or a native helper program, which is a packaging decision for a later version. This version accepts the limit and the docs page states it.
- A key is never printed and never logged, on any platform. Each paired instance keeps its own key under its own address, and switching instances switches the key that is sent.

## 8. Packaging

- The terminal app ships as the npm package `@truefoundry/aman-tui`, which installs the `aman-tui` command. It needs Node 22.14 or newer, the same floor as the rest of Aman. Its version follows the workspace packages' scheme, and the tarball carries only the built program, the readme, and the licence files.
- The app talks to the server through the shared chat package and the generated client, which are published as their own packages at their own versions. Publishing is the maintainers' release act. Until the three packages are published, a registry install cannot be run, and the packed tarball is proven the closest way the workspace allows, with the limit stated in the pull request.

## Privacy

A terminal key is a bearer credential for the chat side of one instance, and that is all it is. The server keeps only its hash. Pairing hands a key out only after the signed-in person confirms a code they can see on both sides, and the code works once and lasts five minutes. Chat content flows between the terminal and the person's own Aman and nowhere else. The terminal program keeps no chat content of its own: its files hold the paired addresses, the device names, which instance is active, and, only where no keychain is offered, the keys themselves. Revoking a key in Settings ends that terminal's access from its next request.

## Testing

All tests use synthetic data, never anyone's real chats, mail, or keys.

- Pairing is tested end to end against a fake that speaks the server's exact shapes, including the waiting then paired handover, the expired code showing the server's own line, and the address refusal shown word for word.
- The chat client is tested through the real generated client and the real shared chat package against a fake fetch that enforces the terminal key scope the server defines, so a call outside the scope fails the suite instead of passing quietly.
- Approvals are tested at the rendered frame: the whole email draft reachable by scrolling, Enter never approving, each continuation failure in its plain words, and a new-recipient card never offering always allow even with the server's flag forced on.
- Key storage is tested through injected command runners: the keychain chosen where offered, the Linux probe falling back to the file, the file written at owner-only modes, and the key absent from everything the app prints.
- The packed tarball is installed outside the repo and run against a standalone fake server: pair, list instances, and ask a one-shot question. The proof and its limits are stated in the packaging pull request.

## Out of scope

- Settings, connectors, skills, and schedule editing in the terminal, and editing memory there.
- Pictures and files shown inline, co-browsing, and voice.
- The change-it answer on an approval card, and picking a different sending account in the terminal. Saying no and asking again in chat covers both, and nothing can run with altered content unapproved.
- A native keychain helper for a Mac, and a credential store integration for Windows beyond the file in the person's own AppData folder.
- Signing, notarising, or store distribution of the terminal app.
