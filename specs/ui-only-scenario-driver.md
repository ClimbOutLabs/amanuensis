# Spec: UI-Only Scenario Driver (v1)

**Status:** draft

## Problem

The scenario runner performs the user journey (provider setup, persona creation, session creation, turns) through HTTP API calls and opens the browser only to take screenshots. A UI regression in any of those steps goes unnoticed because the browser never performs them.

## Goals

- Every user action in a scenario (add provider, create persona, attach persona, new chat, type, send, approve a tool, read the result) is performed in the browser with Playwright.
- Each step asserts a DOM condition before the next step starts.
- A failed assertion exits non-zero and saves a screenshot of the failing page.
- Scenario files can declare per-turn expectations (tool card, approval, result text).

## Non-goals

- Replacing the app's unit or component tests.
- Visual diffing of screenshots.
- Moving infra steps into the browser: booting the backend and dev server, health polling, and resolving a model id from the provider's `/models` endpoint stay outside the browser.
- Changing server or API behavior.
- Migrating the existing browser UI checks (`ui-test.mjs` and `scenarios/ui/*.mjs`). Those already run in the browser but assert almost nothing (the compaction scenario only warns on a missing signal). They coexist unchanged; moving them onto the same step and assertion helpers is a follow-up.

## Design

### API call inventory (current runner)

| Call                                                             | Class                                               |
| ---------------------------------------------------------------- | --------------------------------------------------- |
| `GET {base}/models` via curl (reachability, model id resolution) | infra, stays                                        |
| `GET /healthz`, `GET /` health polls                             | infra, stays                                        |
| `PUT /api/v1/settings/model-providers`                           | user action, moves to UI                            |
| `GET /api/v1/personas`, `POST /api/v1/personas`                  | user action, moves to UI                            |
| `POST /api/v1/sessions`                                          | user action, moves to UI (new chat)                 |
| `PUT /api/v1/sessions/{id}/persona`                              | user action, moves to UI (persona picker)           |
| `POST /api/v1/sessions/{id}/turns`, `GET .../turns/{id}` polling | user action, moves to UI (composer, DOM completion) |

### Environment

- `SCENARIO_MODEL_BASE_URL`: base URL of an OpenAI-compatible endpoint, usually ending in `/v1`. Required.
- `SCENARIO_MODEL_API_KEY`: key typed into the API key field. Optional (the form allows blank).
- Context length and max output tokens are required by the form. They come from the scenario field `model` (`context_length`, `max_output_tokens`) with named defaults `DEFAULT_CONTEXT_LENGTH` (131072) and `DEFAULT_MAX_OUTPUT_TOKENS` (4096).
- The model id is resolved from `{SCENARIO_MODEL_BASE_URL}/models` outside the browser. The probe uses Node `fetch` with the header set in code, or passes it on stdin. The key never appears in process arguments (the current probe puts `Authorization: Bearer` in curl argv, visible to other local users; this is removed).

### Key handling

- Redaction: every logged error, Playwright call log and trace has the key replaced with `[redacted]` before output. Playwright timeout errors echo `fill` values, so the driver catches them and rethrows with `{ cause }` set to a redacted copy of the caught error (message and stack with the key replaced), never the raw error, so the cause chain survives without the secret. Tracing is off by default; if enabled, snapshots and sources are off.
- Before any failure capture while the provider dialog is open, the driver clears the API key field value. The field is `type=password` (masked), and clearing removes the only copy in the DOM.
- Server logs: the server must not log the key; the test plan scans server output for it.

### Driver flow

Selectors are listed in the next section. Each row is one step; the assertion must hold before continuing.

1. Open the app root. Assert the composer or the first-run screen is visible.
2. Click `Settings` (aria-label). Click the `Models` nav button in `Settings sections`. Assert heading `Models`.
3. Click `Add Custom Provider`. Assert dialog title `Add custom provider`.
4. Fill `Name` (slug from the model id), `Base URL`, `API key`, `Model ID` (`Model name` auto-fills), `Context length`, `Max output tokens`. Assert the `Add provider` button is enabled.
5. Click `Add provider`. Assert the dialog closes and the toast `<name> added` appears. A visible form error fails the run (key field cleared first).
6. If the scenario has a persona: open `Model roles`, click `Add persona`, fill `Name`, choose the provider model in `Model`, fill `Instructions`, click `Create persona`. Assert a row for the persona exists.
7. Click `Back` to leave settings, then `Start new chat`. Assert the empty composer (`Message input`) is visible.
8. If the scenario has a persona: click `Choose who answers this chat`, click the menu item named for the persona. Assert the `active-persona` chip text (existing test id).
9. If no persona: open `Select model`, choose the option `<provider> <model>`. Assert the selector shows it.
10. For each turn: fill `Message input`, click `Send message`. Assert the user message appears, then evaluate the turn `expect` block (below).
11. Wait for completion: the last assistant message root has `data-status="complete"` (per-message status from the runtime, not thread-wide) and `Cancel` is absent. Timeout is scenario field `timeout_s`, default `TURN_TIMEOUT_S` (600). `data-status="incomplete"` or the timeout fails the step.
12. Take screenshots (full page, then scrolled to the end) as today.

### Per-turn expectation steps (in order)

1. `tool`: wait for the tool card whose title is the value (`span[title="run_code"]`, scoped to the card by `data-tool-name`). Fails if the model never invokes the tool. Whether the model chooses the tool is part of what the scenario tests.
2. `approval`: `run_code` requires explicit approval, so assert the heading `Permission needed` is visible, then click the `Approve` button. Assert the approval card is replaced or shows an approved state.
3. Expand the card (`Expand step` inside the tool card) when collapsed, then assert the card text contains each `result_contains` string (substring, whitespace-normalised).
4. `assistant_contains`: assert the assistant message text contains each string.

### Failure handling

Any timeout or failed assertion logs the step name and the expected value, saves a `fail-<step>.png` screenshot, and exits with code 1. Unexpected page errors (`pageerror`, a visible failure toast) fail the current step.

## Scenario file format changes

Existing fields (`title`, `persona`, `turns`, `shots`) stay valid. A turn may be a string or an object with an optional `expect`. Scenarios without `expect` only require turn completion; tool execution is not verified for them.

```json
{
  "title": "Docker unavailable message test",
  "turns": [
    {
      "user": "Use the run_code tool to run this Python code: print('hello-docker-test')",
      "expect": {
        "tool": "run_code",
        "approval": "required",
        "result_contains": ["I can't run code on this machine because Docker isn't available."]
      }
    }
  ],
  "shots": 2
}
```

`expect` keys: `tool` (string), `approval` (`"required"` or `"none"`), `result_contains` (string[]), `assistant_contains` (string[]). `approval: "required"` fails if no approval card appears; `"none"` fails if any approval UI appears (the Tier 3 card or the generic approval bar). Unknown keys fail validation at load. Other new fields: `model` (`context_length`, `max_output_tokens`) and `timeout_s`.

## UI inventory and selectors

Paths are relative to `packages/trueforge-ui/src`. "Stable" means role, label, or existing test id.

| Element                   | Component                                                                  | Selector                                                                                                                                                       | Status        |
| ------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Settings button           | `atoms/ShellActions.tsx:54`                                                | role button, name `Settings`                                                                                                                                   | stable        |
| Models nav                | `containers/SettingsBuilder/index.tsx:172`                                 | nav `Settings sections`, button `Models`                                                                                                                       | stable        |
| Add custom provider       | `containers/SettingsBuilder/ModelSettings.tsx:306`                         | button `Add Custom Provider`                                                                                                                                   | stable        |
| Provider dialog           | `CustomModelProviderForm.tsx:274`                                          | dialog title `Add custom provider`                                                                                                                             | stable        |
| Name / Base URL / API key | `CustomModelProviderForm.tsx:297,323,346`                                  | labels `Name`, `Base URL`, `API key`; ids `custom-provider-name`, `-base-url`, `-api-key`                                                                      | stable        |
| Model ID / name           | `CustomModelProviderForm.tsx:432,457`                                      | ids `custom-provider-model-0-id`, `-0-name`                                                                                                                    | stable        |
| Context / max output      | `CustomModelProviderForm.tsx:509,536`                                      | ids `...-0-context-length`, `...-0-max-output-tokens` (both required, expanded by default)                                                                     | stable        |
| Submit                    | `CustomModelProviderForm.tsx:648`                                          | button `Add provider`                                                                                                                                          | stable        |
| Persona list and form     | `SettingsBuilder/PersonaSettings.tsx:218,69,97,117,320`                    | button `Add persona`; ids `persona-display-name`, `persona-model` (select), `persona-instructions`; button `Create persona`. Section lives under `Model roles` | stable        |
| New chat                  | `layouts/SidebarLayout.tsx:119`                                            | button `Start new chat`                                                                                                                                        | stable        |
| Model picker (new chat)   | `atoms/draft/DraftModelSelector.tsx:143`, `DraftModelCatalogPanel.tsx:173` | button `Select model`; option aria-label `<provider> <model>`                                                                                                  | stable        |
| Persona picker            | `atoms/ActivePersonaIndicator.tsx:227,232,257,276`                         | button `Choose who answers this chat`; menuitem by persona name; chip `active-persona`                                                                         | stable        |
| Composer input            | `containers/ComposerContainer.tsx:119`                                     | label `Message input`                                                                                                                                          | stable        |
| Send                      | `atoms/ComposerSections.tsx:80`                                            | button `Send message`; while running it is replaced by `Cancel` (line 63)                                                                                      | stable        |
| Tool card (`run_code`)    | `atoms/ToolCallCard.tsx:113`                                               | title `span[title="run_code"]`; card root has a test id only when a prefix is passed, and the generic path passes none                                         | PARTIAL       |
| Expand                    | `atoms/agent-chat/AgentStepRow.tsx:85`                                     | button `Expand step` (needs card scope)                                                                                                                        | stable        |
| Approval card             | `sentinel/Tier3ApprovalCard.tsx:51,95`                                     | heading text `Permission needed`; button `Approve`                                                                                                             | stable (text) |
| Assistant completion      | `containers/AssistantMessageContainer.tsx:196`                             | root has only `data-role="assistant"`; `useThreadIsRunning` (line 119) is thread-wide; per-message `message.status.type` (line 123) is not exposed in the DOM  | MISSING       |

## Required DOM hooks

| Hook                                                                                           | File:line                                      | Reason                                                                                 |
| ---------------------------------------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------- |
| `data-testid="tool-call-card"` and `data-tool-name={toolName}` (only when no prefix is passed) | `atoms/ToolCallCard.tsx:113`                   | Scopes `Expand step` and result text to one card; the title alone is not a card handle |
| `data-status={messageStatus}` on the existing assistant root                                   | `containers/AssistantMessageContainer.tsx:196` | Per-message completion; values `running`, `requires-action`, `complete`, `incomplete`  |

One new test id and one data attribute. The generic approval bar needs no hook: the approval step requires the `Permission needed` card, and a different card fails the step, which keeps the explicit-approval contract under test. Prefix-based ids are unchanged.

## Privacy

The key comes from the environment, is typed into a masked field, and is never printed, logged, or placed in process arguments (see Key handling). Scenarios use synthetic prompts only.

## Test plan

All tests use synthetic data.

- Positive: `docker-no-docker` passes with a valid endpoint and key: `run_code` card, `Approve` clicked, result contains `I can't run code on this machine because Docker isn't available.`, exit 0.
- Absent text: `result_contains` set to `zzz-absent-text` exits 1, writes `fail-*.png`, and logs the step and expected text.
- Tool never invoked: a prompt that does not call a tool, with `tool: "run_code"`, exits 1 at the tool step.
- Approval mismatch: `approval: "none"` on a turn that needs approval exits 1.
- Timeout path: `timeout_s: 5` against a slow turn exits 1 with a timeout log line and screenshot.
- Setup failure: wrong base URL or key shows the dialog error, exits 1, screenshot taken.
- Unknown keys: an `expect` containing an unknown key is rejected at load with exit 1 before any browser starts.
- Key leakage: with a distinctive fake key, stdout, stderr, every `fail-*.png` (key field empty in the capture) and the server output contain no occurrence of it, including after a forced timeout during `fill`.
- Regression guard: root script `test:scenario-driver` runs the driver self-checks above against a stub OpenAI-compatible endpoint. For the renamed-label check, the test intercepts the page and renames the `Add provider` button with a DOM script before step 5, so no source is edited; the run must fail at step 5. The implementation PR keeps the new script in sync with the repo's script rules.
- Component tests (`packages/trueforge-ui/test`, mirroring `src`): `ToolCallCard` without a prefix renders `data-testid="tool-call-card"` and `data-tool-name` equal to `toolName`; with a prefix the id is the prefixed one and no `tool-call-card` exists. The assistant message root has `data-status="running"` while streaming and `"complete"` after, per message, with a running second message not changing the first.

## Decisions

1. A fresh chat with one configured model may preselect it. The driver skips step 9 when the selector already shows the model.
2. The persona step always creates the persona, since each run starts from an empty app state.
3. The driver expands a collapsed tool card before reading the result; product behavior does not change.

## Open questions

1. If `run_code` approval does not render the `Permission needed` card in practice, the scenario fails and the contract question goes to the maintainers; the driver does not add a fallback branch.
2. The Tier 3 card requires the Sentinel state provider to be mounted in the app shell; if absent, the approval step fails, which is the intended signal.
