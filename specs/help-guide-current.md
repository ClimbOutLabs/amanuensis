# Keep the help guide current

Status: approved

## Problem

The **Help, I'm stuck** button opens Iris, the Aman guide. Her knowledge is a generated pack built from hand-written topics, the public docs pages and the Tour cards. Nothing stopped the pack, the topics or the labels they name from drifting away from the product, so the guide could send a person to a panel that was renamed or explain a screen that changed.

## Change

1. **Fresh pack.** `pnpm guide:check` builds the pack into a scratch file and fails when it differs from the committed one: "The help pack is out of date. Run `pnpm guide:build` and commit the result."
2. **Coverage.** `pnpm test:help-coverage` reads every surface from the code: Settings panels, email and calendar presets, Tour cards, Home pills, approval card kinds, installer commands and server route groups. A topic names what it explains in its `covers` list as `kind:name`. `packages/trueforge/guide/coverage.json` holds the few mappings that point at a docs page, the exemptions (each with a one-line reason) and twelve fixed "stuck" questions mapped to topics. A surface with no topic and no exemption fails with its name and the next step.
3. **Screen changes carry guide changes.** A separate **Help guide** workflow fails a pull request that changes the UI containers or atoms, the frontend, the server routes or the installer's user-facing text, and no topic or Tour card, unless it carries the `help: no change needed` label.
4. **Labels and paths stay true.** The label test also checks every "Settings, then X" path against the real Settings panels, every `aman` command against both installer front ends, every `pnpm` script against `package.json`, and every web address against the external-hosts allowlist as a link.
5. **Honest state.** The help check gains a `state` block: setup steps (`model`, `about_you`), each connector with whether it answered and its last error in plain words, the Google login, whether the sandbox is ready, and the app version and build. Iris's first hidden message carries these under the same field names, and her instructions name them.

CI runs the first, second and fourth checks in one always-on job.

## Not in this change

- Rewriting topics. Exemptions marked "No topic yet" are pages still to write.
- The latest release, the last backup time and the installer mode in the help check. The app has no source for them yet: the latest release needs an outbound call, and backup times wait for encrypted backups.
- MCP presets as a surface, until they exist.
- The nightly button run (open the button from Home, Settings and a chat with a held action; ask the twelve questions; check the help check's JSON and the mapped topic, never the model's wording). It rides on the end-to-end suite, which is built separately; this change supplies its question table.

## Privacy

The help check still sends only names and fixed plain sentences: no token, address or message content leaves the server. A connector's last error is one of three fixed sentences, not the error text. The hidden message carries only the check, the screen name and the last error the person saw.

## Testing

Synthetic fixtures only:

- A hand-edited pack is stale; `guide:build` makes it fresh again.
- A fixture with one uncovered Settings panel fails with its name; an exemption with a reason passes; stale rows fail.
- A fixture diff touching a container with no topic fails; with the label it passes.
- A renamed panel breaks the page that names it; a page naming a command that does not exist fails.
- Each new help check field is present and typed by the schema, the frontend refuses a mistyped one, and the guide's instructions name only fields the check reports.
