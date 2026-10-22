# Token eval

The token eval runs a fixed set of 18 prompts against a running Aman instance. It records how many tokens and steps each reply used, so we can compare changes to token use over time.

You run it yourself, against your own instance. Nothing in the eval calls a real account. The prompts use invented people, places, and documents.

## What is in the set

The prompts live in `packages/trueforge/evals/token-set.json`. Each prompt has:

- an id and a group (calendar, email, map, web_search, shared_doc, or adversarial),
- the text the person types,
- an approval policy: `approve` answers any approval card with yes, and `decline` answers no,
- a pass checklist of 3 to 5 yes-or-no items.

The set is versioned. Change it only in a new version, so results from different runs stay comparable.

## Before you run it

1. Start your Aman instance and note its address, for example `http://localhost:8790`.
2. If your instance asks you to sign in, put your sign-in token in a file named `.env.eval-tokens` at the repo root, as `TRUEFORGE_TOKEN=...`. You can also set `TRUEFORGE_TOKEN` as an environment variable. Never type the token on the command line.

The file `.env.eval-tokens` is ignored by git. Keep it that way.

## Run it

```sh
pnpm eval:tokens -- --instance http://localhost:8790 --model <provider/model> --label "baseline" --runs 3 --temperature 0
```

The flags:

- `--instance` is the address of your instance. It must start with `http://` or `https://`.
- `--model` is the model to use for every prompt.
- `--label` names this run. Use a short name you will recognize later.
- `--runs` is how many times to run each prompt. The default is 1.
- `--temperature` is the randomness setting, from 0 to 2. Use 0 to make runs as repeatable as the model allows.
- `--set` and `--out` are optional. `--set` picks another prompt file. `--out` picks another output folder.

Each prompt runs as its own chat, so one prompt does not carry context into the next.

## What you get

The run writes a folder named `eval-results/<label>-<time>/` at the repo root. The folder is ignored by git. It holds two files.

- `replies.csv` has one row per reply. The columns are:
  - `run`, `prompt_id`, `group`, `label`, `model`: which reply this is.
  - `status`: whether the chat finished, or why it did not.
  - The metric columns: `steps`, `sub_agent_steps`, `input_tokens`, `cached_input_tokens`, `output_tokens`, `reasoning_tokens`, `last_call_input_tokens`, `tool_calls_by_tool`, `results_by_kind`, `guard_fired`, `claim_mismatch`, `wall_time_ms`, `time_to_first_token_ms`.
  - `reply`: the text the assistant wrote.
  - `checklist`: the checklist items for that prompt, joined with `|`.
  - `pass`: left empty for you to fill in.
  - `error`: the error text, if the reply failed.
- `summary.md` lists each prompt with its checklist and its reply text. The pass line is blank for you to grade.

Some metric columns are empty on purpose. `cached_input_tokens` and `reasoning_tokens` are empty when the provider does not report them. Do not read an empty value as zero.

## What the metrics mean

- `steps` counts model calls in the reply, including sub-agent calls. `sub_agent_steps` counts only the sub-agent calls.
- `input_tokens` and `output_tokens` add up every model call in the reply.
- `results_by_kind` counts tool results as `ok`, `refused`, `unavailable`, or `error`.
- `guard_fired` names the first safety check that blocked a tool call. It is empty when none did.
- `claim_mismatch` is `true` when the last tool call did not succeed. It is a rough flag, not a judgment about the reply's accuracy.
- `wall_time_ms` is the time from start to finish. `time_to_first_token_ms` is the wait before the first word appeared.

When a reply pauses for an approval, the runner answers the card using the prompt's approval policy. It then adds up the metrics across all the turns in that reply.

## How to grade

Open `summary.md` or `replies.csv`. For each reply, read the checklist and the reply text. Put `yes` in `pass` only when every checklist item holds. Put `no` otherwise. Grading is done by a person, not by the runner.
