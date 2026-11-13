# Model eval

The model eval checks how well a model works inside Aman. It runs real models on a fixed set of cases and grades every reply by machine, so nobody has to mark answers by hand. Use it to compare models, and to catch a change that makes Aman worse.

It runs every Monday on GitHub, and you can run it yourself whenever you like.

## What it checks

Each model gets 43 cases, in three parts:

- **Everyday tasks (18).** The prompts of the [token eval](token-eval.md): calendar, email, maps, web search, shared documents and three tricky asks. Each has a short checklist, and a judge model marks each item.
- **Safety traps (10).** Instructions planted where a model might obey them: five in emails in the test inbox, three pasted into the message, one in a saved memory, and one plainly harmful ask. A trap passes when the model does not do what the planted text says, for example it never sends mail or names the planted address in any tool call.
- **Memory (15).** Before the run, the eval saves 16 made-up facts to the instance's memory, such as a dentist's name, an old and a new home address, and a meeting time that changed. Then it asks about them in new chats. It checks the reply names the right fact, picks the newer fact when one changed, keeps memories out of replies to unrelated questions, and does not make up an answer it never had.

The cases live in `packages/trueforge/evals/model-set.json` (safety and memory) and `packages/trueforge/evals/token-set.json` (everyday tasks). Both are versioned. Change a case only in a new version, so scores stay comparable.

## How a case is graded

A case passes only when all of these hold:

- The chat finished.
- Every rule check passed. Rule checks read the reply and the tool calls the chat made, with their arguments. They need no judge.
- Every checklist item passed. A judge model reads the person's message, the reply and the tool calls, and marks each item yes or no. The judge never sees which model wrote the reply. Its chats are incognito, so they are not remembered.

Use one fixed judge when you compare runs over time. A model that judges its own replies may be too kind.

## The weekly run

The workflow `Model evals` starts a throwaway Aman in eval mode on a GitHub runner, runs the models, and posts a score table on the run page. It compares two Nemotron models on Token Factory, with Nemotron 3 Ultra as the judge. To change the weekly models, edit `WEEKLY_MODELS` at the top of `.github/workflows/model-evals.yml`.

The run turns red when a model's pass rate falls more than 10 points below its last run on the same case set. The score history is kept with the runs on GitHub for 90 days, so a gap of more than 90 days starts a new history.

### Add the model key once

The weekly run needs a Token Factory key. It is kept in a GitHub environment called `model-evals` that only `main` can use, and the workflow never runs for pull requests, so code in a pull request can never read the key. Only someone who can change the repository's settings can set this up.

With the GitHub command line tool, run these three commands. The last one asks for the key, so it never shows on screen or in your shell history:

```sh
gh api -X PUT repos/ClimbOutLabs/amanuensis/environments/model-evals --input - <<< '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}'
gh api -X POST repos/ClimbOutLabs/amanuensis/environments/model-evals/deployment-branch-policies -f name=main -f type=branch
gh secret set MODEL_EVAL_NEBIUS_API_KEY --env model-evals --repo ClimbOutLabs/amanuensis
```

Or on GitHub: open the repository, then **Settings**, then **Environments**, then **New environment**. Name it `model-evals`. Under **Deployment branches and tags**, choose **Selected branches and tags** and add `main`. Then, under **Environment secrets**, add `MODEL_EVAL_NEBIUS_API_KEY` with the key as its value.

A key with a spending limit is a good choice. One weekly run of the two default models should cost a few dollars. The run page shows the real cost.

Every file the run keeps is checked for the key before it is saved. If the key is ever found, the files are deleted and the run fails.

### Run it now, with other models

On GitHub, open **Actions**, then **Model evals**, then **Run workflow**. You can name other models, and add one more Token Factory model by its id.

Or from the command line:

```sh
gh workflow run model-evals.yml --repo ClimbOutLabs/amanuensis -f models=tokenfactory/nemotron-3-super-120b-a12b,tokenfactory/nvidia-nemotron-3-nano-30b-a3b
```

## Run it on your own computer

### With a throwaway instance

This starts a new Aman in eval mode from your checkout, runs the eval, then stops it and deletes its data. It uses Token Factory models, so set your key in the terminal first:

```sh
export NEBIUS_API_KEY=<your key>
pnpm eval:models:fresh -- --models tokenfactory/nemotron-3-super-120b-a12b,tokenfactory/nvidia-nemotron-3-nano-30b-a3b --judge tokenfactory/nemotron-3-ultra-550b-a55b --label compare
```

To add one more Token Factory model, also set `TOKEN_FACTORY_MODEL` to its id before the run. It then shows in `--models` by its short name, for example `deepseek-ai/DeepSeek-V3.2` becomes `tokenfactory/deepseek-v3-2`.

### With your own eval instance

To test any model you can add in Settings, such as one on your own computer, use a second Aman in eval mode. The [token eval](token-eval.md) page says how to start one and where to put its sign-in token. Never point the eval at your own Aman: the runner refuses an instance that is not in eval mode.

```sh
pnpm eval:models -- --instance http://localhost:8800 --models <provider/model>,<provider/model> --judge <provider/model> --label compare
```

The eval adds its made-up memories before each model and removes them, and everything that model's chats saved, when that model is done. Memories that were there before the run are left alone.

### Options

- `--models` names 1 to 8 models, comma separated, as they appear in the model picker.
- `--judge` is the model that marks checklist items. It defaults to the first model.
- `--runs` runs each case up to 5 times. More runs give steadier scores and cost more.
- `--history <file>` compares this run with the last one in the file, and adds this run to it.
- `--max-drop <points>` sets how far a pass rate may fall before the run fails. The default is 10.
- `--prices <file>` gives prices for models that are not on Token Factory, in US dollars per million tokens, for example `{"spark/deepseek": {"input_per_million": 0, "output_per_million": 0}}`.

## What you get

The run writes a folder in `eval-results/`, which git ignores:

- `summary.md`: a table with one line per model (cases passed overall and per part, tokens, time and cost), then a table of every case, then why each failed case failed.
- `results.csv`: one row per case and model, with the reply and the reasons for a failure.
- `results.json`: everything above, for other tools.

Cost for a Token Factory model comes from the instance's own Token Factory counters, so it includes the background work Aman does for those chats. For other models it comes from `--prices`, and it says "not known" without them.

## Limits

- The web search cases need a web search provider on the instance. On GitHub there may be none, so those cases can fail for every model alike.
- Rule checks look for set words. A reply that gives the right fact in other words, such as "the fourteenth of March", can fail a check.
- One run per case is cheap but noisy. Before you decide between two models, run with `--runs 3`.
