# Spec: Sandbox commands are not refused for their shape

**Status:** approved

## Problem

Before a sandbox command runs, the host reads it. Some forms were refused outright before any card: a loop over `$(...)`, a redirect, a heredoc, `tee`, a shell wrapper such as `bash -c` or `eval`, and inline code such as `python3 -c` or `node -e`. Skills often write their steps this way. Each new skill could bring a form the list didn't cover, and each fix added another exception. Refusing a form also kept nothing safe that the sandbox didn't already keep safe, because a Python script approved on its card can do everything those forms do.

## Solution

The sandbox walls decide what a command can reach. The shape of the command never causes a refusal.

1. **No refusals by shape.** The host no longer refuses commands for using substitution, redirection, heredocs, `tee`, shell or evaluator wrappers, or inline interpreter code.
2. **A command the host can't read asks, with its exact text.** A command the parser can't read as one plain command is rated Tier 3. Its card shows the full raw command. It is barred from any standing grant, so **Always allow** is never offered and each run asks. Its approval binds the exact text, as before. A command like this is never rated as a read, so it never skips its card.
3. **Running without a card is unchanged.** Only the safe read-only list, and the scripts Aman wrote that the **Sandbox** switch covers in a sealed sandbox, run without a card. Inline code never does.
4. **A check stays honest.** A `verify` call whose result the host can't read is run as ordinary execution, behind its card, and never counts as a verification. Such a check uses a redirect, substitution, backgrounding, inline code or `tee`. So it can't authorize a later commit.
5. **Kept as they are:** package installs always ask. `git commit` and `git push` stay separate calls. A commit or push purpose needs a plain git command. Custom environment variables ask. An offline sandbox still refuses a plain network command before a card. A web search connector still steers `curl` to its tool, unless a skill's websites are approved.

What contains a command is the sandbox itself. It can reach only the websites approved for the chat's skills and the package mirrors allowed for the chat, and it can't see anything outside the workspace. A push with the person's GitHub sign-in is built by the host only from a git command it can read, so a command it can't read never gets the sign-in.

## Privacy

No new data is collected or sent. Commands still run only inside the sandbox, with the same network limits as before.

## Testing

All tests use synthetic commands and made-up sites.

- **Classifier:** a loop with `$(...)`, a heredoc, `bash -c` and inline code with a redirect each give Tier 3. The card shows the exact command, and a standing grant is barred.
- **Sandbox:** each removed form asks, and after approval runs exactly that text, including a skill-style loop under a skill's website grant.
- **Inline code** asks and then runs.
- **Offline:** inline network code in an offline sandbox asks and doesn't run before approval.
- **Verify:** an unreadable `verify` is rated `execute`, while a plain one stays `verify`.
- **Commit:** a commit-purpose call hidden in a wrapper is still refused.
- **Wrappers:** nested and indirect wrappers are never rated as a read.

## Out of scope

- An automatic restore point for files in the workspace before a run.
- Changing when a run with a skill's websites approved asks. It still asks every time.
