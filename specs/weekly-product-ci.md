# Weekly product CI

Status: draft for review

A person reviewing the health of Aman should be able to open one scheduled run, see which product behaviors actually ran, read individual failures and inspect evidence at the tested revision. Daily CI supplies deterministic regressions. Every shipped feature needs an end-to-end weekly journey that starts at a supported product entry point and checks an observable outcome. New features extend the same run. Each case needs a positive control and, where the behavior includes refusal, isolation or approval, a negative control.

The weekly run includes live model evaluations, the built product and its signed-in journey, the sandbox and browser, UI inspection, Obsidian, the release upgrade, and LongMemEval. Independent jobs run even if a sibling fails. A case failure makes the strict model job fail even on a first run. A benchmark score, screenshot or passing unit suite alone does not establish a feature journey.

## Coverage still to establish

The nightly inventory at e7fce31c6 names 181 surfaces and leaves 88 without a mapped test. Mapped files also include component and layout checks. This is an inventory, not an executed weekly coverage percentage. Audit new tools and routes outside the inventory too.

| Area | Weekly acceptance evidence |
| --- | --- |
| Memory, briefs and personas | A fact retained in a real chat can be recovered in the right later chat. Exercise corrections, ambiguity, owner isolation and what the scheduled brief actually says. |
| Mail, calendar, reminders and notifications | Read a seeded item and verify a permitted write at a disposable destination. For refusal or cancellation, verify that the destination received nothing. Exercise due-time behavior relative to the fixture clock. |
| Search, browser and connectors | Verify a successful result from a known source, match the answer to its evidence, and show an honest failure when the source cannot be read. Exercise authentication and revocation against a disposable service. |
| Goals and Spaces | Create through the product, inspect persisted state from a fresh session, act through normal approval boundaries and check the new state. Exercise an unchanged or stale revision too. |
| Other surfaces | Track installation, upgrade and restore, sign-in, settings, chat and archive, models, skills, sandbox and code, data export and import, voice, help, mobile and accessibility through user-observable journeys. Record missing cases explicitly. |

## Privacy and evidence

Use synthetic accounts and data. Actions that send, call or change an external account go only to disposable local services. The weekly model and judge can use the configured evaluation provider on synthetic inputs. A real browser or sandbox can be exercised without a model for behavior it owns. Keep credentials out of prompts and artifacts. Record the tested revision, individual case outcomes, absent prerequisites and the evidence needed to reproduce failures.
