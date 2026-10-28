# Space eval

The space eval replays a few prompts that ask Aman to build a space. It then reads the stored space back and scores it. Use it to see whether a change makes large space writes more reliable.

It uses the same eval-mode instance, sign-in file, and runner code as the [token eval](token-eval.md). Read that page first for how to start a second Aman with `AMAN_EVAL_MODE=true`. The runner stops if the instance is not in eval mode.

## What is in the set

The prompts live in `packages/trueforge/evals/space-set.json`. Each prompt has:

- an `id` and the `prompt` text the person types,
- an optional `follow_up`, sent as a second turn in the same chat,
- `expect`, the targets the stored space should meet.

The targets are `rows`, `duplicate_rows`, `table_valid`, `formatting_changed`, `completed`, `refused_or_failed_calls`, and `pictures_min` (at least this many pictures). A run meets its targets when every one holds.

The set is versioned. Change it only in a new version, so results stay comparable.

## Run it

```sh
pnpm eval:spaces -- --instance http://localhost:8800 --model <provider/model> --label "baseline" --runs 3
```

The flags are the same as the token eval, plus `--keep`. `--set` picks another prompt file, `--out` picks another output folder, and `--temperature` defaults to 0.

Each run is its own chat. The runner lists the spaces before the chat starts. It then reads the chat's own stored tool results and finds the spaces its successful `create_space` calls made. Only those spaces are scored and deleted, and only if they were not in the first list. A space you or anyone else makes during the run is never touched. If the first list cannot be read, nothing is deleted and the run's `error` says so. `--keep` skips the delete so you can open the spaces. If a delete fails, `error` names the space so you can remove it by hand.

The model name decides which provider is used. Run the set once for each model you want to compare, for example Nemotron on Token Factory and DeepSeek on vLLM. Keys stay in the instance and in `.env.eval-tokens`, never in the repo.

## What you get

The run writes `eval-results/<label>-<time>/`, which git ignores.

- `replies.csv` has one row per run. The columns are listed below.
- `summary.md` has a table per prompt, how many runs met the targets, and each final reply.

| Column                                    | Meaning                                                                                                                                                                           |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`                                  | Whether the chat finished, or why it did not.                                                                                                                                     |
| `completed`                               | The chat finished, a new space exists, and the final reply is not empty.                                                                                                          |
| `create_calls`, `edit_calls`              | Calls to `create_space` and `edit_space`, across both turns.                                                                                                                      |
| `refused_or_failed_calls`                 | Tool results of kind `error`, `unavailable`, or `refused`.                                                                                                                        |
| `guard_fired`                             | The first safety check that blocked a tool call.                                                                                                                                  |
| `steps`, `input_tokens`, `wall_time_ms`   | Totals across both turns.                                                                                                                                                         |
| `rows`                                    | Table data rows. Markdown: pipe rows minus each header and separator. HTML: `<tr>` rows outside `<thead>`.                                                                        |
| `duplicate_rows`                          | Rows beyond the first with the same key. The key is the first cell, or the second when the first is only a number, with `*`, `_`, and backticks removed, trimmed, and lowercased. |
| `table_valid`                             | Markdown: every table has a separator and rows as wide as its header. HTML: a table with balanced row tags.                                                                       |
| `raw_list_markers`                        | Lines that start with a list marker such as `-` or `1.`.                                                                                                                          |
| `bold_lines`                              | Lines that are only bold text, standing in for a heading.                                                                                                                         |
| `pictures`                                | Image links in the body.                                                                                                                                                          |
| `closing_line`                            | The final reply is not empty and names the space.                                                                                                                                 |
| `formatting_changed`                      | After the follow-up, the body differs once whitespace is collapsed. Empty when there is no follow-up.                                                                             |
| `rows_lost`                               | The first stored revision where a row key from the revision before is gone, as `revision n: key`. Empty when none.                                                                |
| `expectations_met`, `failed_expectations` | Whether every target held, and the ones that did not.                                                                                                                             |

Empty means "not measured", for example when the instance sent no metrics. It does not mean zero.

`rows_lost` reads every revision with `GET /api/v1/spaces/{space_id}?revision=n`. The instance keeps a limited history, so revisions it no longer keeps are skipped.

## Baselines

Before a change to space writes merges, run the set on each model with `--runs 3` and keep the folder as `eval-results/baseline-*`. Compare the next run against it.
