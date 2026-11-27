# LongMemEval memory benchmark

The LongMemEval workflow runs the cleaned LongMemEval-S release through Aman's Markdown memory backend. Each question gets its own temporary vault. The runner retains every message with its speaker, date and an opaque session ID, then calls production recall with a 4,096-token budget. This measures the keyword fallback with no embedding model, nightly tidy, chat tools or model-based summarization. Session IDs containing benchmark hints and turn labels such as `has_answer` never enter memory. The temporary vault is removed after each question.

Pull requests touching memory retrieval or the benchmark run all 500 questions without credentials. Each question type has a minimum supporting-session count measured on the pinned release. Scheduled model grading uses a fixed seven-question panel. The panel uses the first question ID in sorted order from each of the six question types and the first abstention question as a separate group. Each case retains its complete distractor history. For these six named answerable cases the gate also compares each question's number of retrieved supporting sessions to its recorded floor. A session hit indicates that at least one message from that session was retrieved. The supporting detail itself can still be missing.

On Mondays the same panel also produces answers from the retrieved text and question date. A separate call grades each answer against its reference using Aman's eval judge format. Gold answers, session labels and question types are withheld from the reader. The job uses the existing protected model-evals environment on main. Scores for each question type and abstention appear in scores.json. The hypotheses.jsonl artifact can also be graded with the upstream evaluator. The reader and judge currently use the same Meta model. These answer scores are observational until a stable model baseline exists. They measure this memory reader and judge combination, rather than Aman's full conversation loop or the paper's GPT-4o judge.

For a full run, use **Actions > LongMemEval > Run workflow** on main and select **full**. It covers all 500 questions and calls the hosted model up to 1,000 times. Weekly runs use 14 calls. A missing key or malformed judge output fails the grading job. An ungraded run reports retrieval only.

To reproduce locally with Python 3.11 or newer, install the workspace dependencies and run both package build:gen scripts listed in the workflow. Download the file from the pinned workflow URL, then run from the repository root:

```sh
work=$(mktemp -d)
python3 scripts/longmemeval/select.py longmemeval_s_cleaned.json "$work/history" "$work/questions"
pnpm eval:longmemeval "$work/history" "$work/recalls"
node scripts/longmemeval/score.mjs "$work/questions" "$work/recalls" "$work/report" panel
```

The selector verifies the upstream SHA-256 before reading the data. Use a fresh work directory for each run. For all questions add `--full` to the selector and use `full` in the scoring command. To include answer grading, set `LONGMEMEVAL_GRADE=1` and provide the eval provider key to the scoring step.

[Upstream benchmark and grading protocol](https://github.com/xiaowu0162/LongMemEval) · [Pinned dataset](https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/tree/98d7416c24c778c2fee6e6f3006e7a073259d48f)
