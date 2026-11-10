# The Aman guide

The **Help, I'm stuck** button opens Iris, the Aman guide. Everything she knows about Aman comes from this folder, the public docs pages under `docs/` and the Tour cards in `packages/trueforge-ui/src/components/tourPrompts.ts`. CI keeps that knowledge true to the product on every pull request.

## What is here

- `topics/`: one Markdown page per topic, in plain words. Each starts with front matter: `id`, `title` and `covers`.
- `coverage.json`: surfaces that a topic cannot name itself, the exemptions, and the fixed "stuck" questions.
- `ui-labels.json`: every bold label a page tells the person to click, with the UI file that shows it.
- `required-cards.json`: Tour cards that must have a page, or the build fails.

## The checks

| Check                      | Run it with                 | Fails when                                                                                                              |
| -------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Help pack is up to date    | `pnpm guide:check`          | `knowledgePack.generated.ts` differs from what `pnpm guide:build` writes. Run `pnpm guide:build` and commit the result. |
| Every surface has a topic  | `pnpm test:help-coverage`   | A surface has no topic and no exemption, or a row names a surface or topic that no longer exists.                       |
| Labels and paths stay true | `pnpm test:aman-guide`      | A page names a label, a "Settings, then X" panel, an `aman` command, a `pnpm` script or a web address that is not real. |
| Help changed with screens  | the **Help guide** workflow | A pull request changes a screen and no topic or Tour card.                                                              |

### Surfaces

`scripts/check-help-coverage.mjs` reads the surfaces from the code, so a new one shows up on its own:

| Surface                                       | Read from                                                         |
| --------------------------------------------- | ----------------------------------------------------------------- |
| `settings:<id>`                               | the Settings tabs in `SettingsBuilder/index.tsx`                  |
| `email-preset:<key>`, `calendar-preset:<key>` | the email and calendar provider presets                           |
| `tour:<key>`                                  | the Tour cards                                                    |
| `pill:<id>`                                   | the Home pills                                                    |
| `approval:<kind>`                             | the approval card kinds in `sentinel/types.ts`                    |
| `command:<name>`                              | the commands the installer program and the `aman` script dispatch |
| `route:<group>`                               | each `*Routes.ts` file under `packages/trueforge/src/routes`      |

A topic names what it explains in its own `covers` list, so the mapping lives with the page: `covers: brief, settings:models, route:firstRunGuide`. Tour cards stay bare keys. Use `coverage.json` `covers` only to point a surface at a docs page's entry in the pack, such as `docs-install`.

An exemption is a row in `coverage.json` `exempt` with a one-line reason. It is reviewed like code. A reason that starts with "No topic yet" is a page still to write.

### Screen changes

The **Help guide** workflow fails a pull request that changes `packages/trueforge-ui/src/containers`, `packages/trueforge-ui/src/atoms`, `packages/frontend/src`, `packages/trueforge/src/routes`, `packages/aman-installer/src/messages.ts` or `installer/lib/*.sh`, and changes nothing under `topics/` or `tourPrompts.ts`. When no topic needs to change, add the label `help: no change needed` and say why in the pull request.

### Links

Every web address a page names must be on `scripts/external-hosts.allowlist.json` under a link-only category, such as `docs_link` or `setup_guide`.

## The help check

When the button opens, the app calls `GET /api/v1/help/health-check` and hands Iris its result in a hidden first message. Its `state` holds what she needs to say the one thing to do next:

- `setup_steps`: whether a model is chosen (`model`) and your name is saved (`about_you`).
- `connectors`: each connector, whether it answered, and its `last_error` in plain words.
- `google_login`: whether the built-in Google login answered.
- `sandbox_ready`: whether the sandbox can read files and run code.
- `app_version` and `build_ref`: the version this server runs.

Iris's instructions name these fields, and a test fails if they name one the check does not report.

## The nightly run

`coverage.json` `questions` holds twelve fixed "stuck" questions, each mapped to the topic that answers it. The nightly end-to-end run opens the button from Home, from Settings and from a chat with a held action, checks the help check's JSON, then asks each question and checks that the mapped topic is in the answer. It checks topics and fields, never the model's wording.
