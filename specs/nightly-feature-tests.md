# Spec: Nightly tests for every feature

**Status:** approved

## Problem

A pull request runs only the test suites its changed files select. A suite broken from another package can stay red on `main` with nobody seeing it: a browser test for the chat screen stopped passing after a server change, and no run picked it up. Nothing runs every suite together, nothing says which features have an end-to-end test and which have none, and a failed browser test leaves no picture of what the screen looked like.

## Solution

One nightly run on `main` that tests every feature, proves that it does, and keeps pictures of what it saw. It lands in small pull requests that all link this spec.

1. **Nightly run.** `.github/workflows/nightly.yml` runs each night and can be started by hand. It calls the CI workflow with the path filters switched off, so every package suite, the store suites and every browser test run. The frontend suite also runs on pull requests that change the server, core or chat UI packages, because its browser tests load all three.
2. **Failure issue.** A failed run opens one issue titled "Nightly tests failed" that lists the failed jobs and links the run. Later failures are added to it. The next passing run closes it. A run that was cancelled changes nothing. An open issue always means the last finished run did not pass.
3. **Coverage map.** The help check already reads every surface a person can reach from the code: Settings panels, approval card kinds, email and calendar presets, Home cards and pills, installer commands and server route groups. A coverage map names, for each surface, its feature set (Chat, Reminders, Persona, Memory and so on) and the test that exercises it. A CI check fails when a surface has no entry, when a named test does not exist, or when the test does not mention the surface. Surfaces with no test yet sit in a separate list, and the check prints both counts.
4. **Screenshots.** Tests save a picture at each named step through one helper that takes the surface id. The nightly run files them as `<year>/<month>/<day>/<time>/<feature set>/<surface>--<step>.png`, in UTC, so two runs on one day stay apart. A failed step saves a picture with `FAILED` in its name. The folder gets an `index.html` contact sheet grouped by feature set and a results file a later run can be compared with. Each job that takes pictures hands them to one last job, which builds the contact sheet and uploads the folder as one artifact, kept for 30 days.
5. **Filling the map.** Tests are added by area until the not-yet list is empty: a signed-in journey on the built app (sign in through the real sign-in service, first run, add a model, chat, come back, sign out), which runs after the build on every pull request as well as nightly, every Settings panel, every Home card, pill and approval kind, every email and calendar preset against stand-in servers, every installer command in Docker including backup then restore, then the remaining route groups.

## Design decisions

- **One owner for the job list.** The nightly workflow reuses the CI workflow through `workflow_call` instead of copying its jobs, so a suite added to CI is in the nightly run with no second edit.
- **Scripted model and stand-ins only.** The nightly run uses the scripted model server and local stand-in servers. It needs no keys or accounts and calls no outside host. It proves each feature works end to end inside Aman. It does not prove a real provider behaves; that would be a separate, keyed workflow.
- **The feature list comes from the code.** The coverage check reuses the help check's surface reader, so a new panel, preset, card, command or route group is a new required row the day it is added.
- **Folder names come from the map.** A test names a surface, and the map gives its feature set. A test cannot file pictures under a name that is not a feature set.
- **Pictures are run artifacts, not commits.** Nightly pictures in git would grow a public repository without limit and could never be removed from its history.
- **The journey uses the sign-in service Aman ships.** It runs the Dex image the compose file pins, with the one fixed person `pnpm dev:login` uses, so the sign-in pages and token checks are the real ones. Both read their Dex settings from `scripts/login-service-config.mjs`.
- **Upgrade from the last release.** A second nightly job builds the newest release tag, fills it with one of each thing a person keeps, and starts the new code on the same data folder. Everything must read back and one more of each must save. Every other suite starts from empty tables, so only this job sees a database change that fails once a table has rows. It also runs on pull requests that change a migration.
- **Not a required check.** The nightly run does not run on pull requests, so it cannot gate a merge. The coverage check and the tests themselves run on pull requests and can.
- **The issue is found by title and author.** The report reuses an open issue with the nightly title opened by the workflow's own account, so no label has to exist first.

## Privacy

The run reads source code and drives the app with a scripted model and synthetic chats, mail and calendar entries. Screenshots and results show only that test data. The failure issue holds job names and a link to the run. No personal data is involved, and nothing leaves GitHub's runners.

## Testing

- `tests/nightly-report.test.mjs` (`pnpm run test:nightly-report`) covers the issue decisions with synthetic inputs: first failure, repeat failure, a failure with no failed job, a cancelled run, pass with and without an open issue, which jobs count as failed, and which issue is reused.
- The coverage check and the contact sheet builder each get a test over synthetic fixture trees, including the real repository passing its own check.
- `pnpm test:journey` is the signed-in journey. It needs `pnpm build` and Docker.
- Every browser test uses synthetic data, never a person's real data.

## Out of scope

- Tests against real model providers, real mail or calendar accounts, or real phone services.
- Publishing screenshots to a public web page.
- Visual comparison of screenshots between runs.
- An upgrade test from the previous release; it needs a first release to exist.
