# @truefoundry/aman-tui

Aman in the terminal. Pair once with a one-time code, then read and write chats from the command line, with replies streaming in as they are written.

## Pairing

Run `aman-tui login <address>` with the address Aman is opened at. The terminal starts a pairing, shows a one-time code and a link in large clear text, and waits while you confirm the code in the web app. The code works once and lasts five minutes. When you confirm, the terminal receives its own key for that instance.

The key lives in the system keychain where the platform offers one this app can reach (the macOS keychain, or the Linux secret service through `secret-tool`), and in an owner-only file in the app's config folder where it does not. The key is never printed and never logged. Each paired instance keeps its own key and device name. Pair another instance with `aman-tui login` again, list them with `aman-tui instances`, and switch the active one with `aman-tui use <address>` or inside the app.

## Chatting

Run `aman-tui` with no command. The app lists your chats, newest first, with the persona and when each was last active. Open one, or start a new chat. Inside a chat, type a message and the reply streams in. Tool calls appear as plain cards in the flow, with what the tool is doing and how it ended. A picture or a file in a chat is replaced by a line offering the chat's web address to open in a browser, and a turn that is waiting for an approval says so and points at the web app, where approvals are answered in this version.

The app talks to the server only through `@truefoundry/trueforge-chat` and the generated SDK, using the same resync the web app uses, so a dropped connection rejoins the turn instead of losing the reply. The two pairing calls are plain fetches, because the generated SDK has no terminal pairing methods yet.

## License

[MPL-2.0](https://github.com/ClimbOutLabs/amanuensis/blob/main/LICENSE). Portions derived from TrueForge are MIT licensed. See [NOTICE](https://github.com/ClimbOutLabs/amanuensis/blob/main/NOTICE).
