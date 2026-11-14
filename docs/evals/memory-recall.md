# Memory recall test

The memory recall test checks whether Aman puts the right memories in front of the model. It runs with the unit tests. It needs no model, no key and no running Aman.

## What is in it

**Maya's world.** Sixty days of a made-up household's memory, from August 1 to September 29, 2026. Maya lives with her wife Nora and their daughter Zoe. Around them are a plumber and a colleague who are both called Sam, a manager, friends, a client, a trip to Madrid, a kitchen renovation and a tax return. The world is written as about 520 daily-log entries:

- about 155 hand-written entries that tell the story,
- about 365 entries of everyday noise, such as receipts, calendar entries and passing remarks.

The story holds the hard cases on purpose. Facts change, such as the dates of the trip. Some facts are true only for a while, such as a week of leave. The same fact is said twice in different words. Maya sends emails that show how she writes to each person. One email tries to plant an instruction. Maya edits one page by hand, and a later email contradicts it.

**Expected decisions.** Every entry says what should happen to the pages about people and matters when that entry is sorted: a new fact, the same fact again, a changed fact, a fact that ended, something not confirmed, or nothing. The step that sorts entries into pages will be tested against these.

**Questions.** Maya asks 76 questions on different days. Each question names the text that must be in the memory shown to the model. Some also name a text that should not be there, such as the old dates of the trip. Twelve questions are asked in other words: they share no topic word with the entry that holds the answer, such as "Who lives next door to us?" for the neighbour at number 14. Only a search by meaning can answer those.

Twelve more are messages that have nothing to do with memory, such as "What is 17 times 23?". No entry in the world shares a topic word with them. For these, no memory should be shown at all.

**Unrelated messages.** The test also has 300 messages that have nothing to do with memory, such as "explain photosynthesis simply" or "How do I tune a ukulele?". 250 are in English and 50 are in ten other languages. They were written by someone who had never seen Maya's world, so they do not lean on it. Some are near her topics on purpose, such as cooking, travel and money, because real messages are. Twelve questions were too few to measure how often Aman shows a memory to a message that needs none, so these 300 measure it.

The files are in `packages/trueforge/tests/fixtures/memory/mayaWorld/`. The 300 messages are in `unrelatedMessages.ts`, one per line.

## How a question is scored

The test writes the world into an empty memory folder, one day at a time, through the same code Aman uses to save memories. On the day of each question it runs the same step that builds the memory block before every reply. Then it reads the block.

- **Found**: the expected text is in the block. It also counts when the question has a second wording and every part of it is in the block (see the first rule below).
- **Unwanted**: the stale or planted text is in the block and is shown as if it were true now (see the second rule below). For a message that has nothing to do with memory, any memory in the block is unwanted.
- **Clean**: the expected text is there, and nothing unwanted is. For a message that has nothing to do with memory, clean means the block is empty.

The scorecard counts these for all questions, for answers at most 14 days old, for answers older than that, and for each kind of question.

This test reads what the model is shown. It does not read what the model then answers. A test that scores answers needs a model and is a separate step.

### How the unrelated messages are counted

After the 76 questions, the test asks the 300 unrelated messages on day 60. It uses the memory the condition already built for the questions, which by then holds the world through day 60. Each message is asked in its own new chat, with no earlier messages. They are asked last, so they cannot change the answers to the questions.

A message counts when Aman shows it any memory at all, which means the memory block is not empty. The test records this as `shown a memory 123/300`. **Lower is better.** The best number is 0, because none of these messages needs a memory.

The test also records the positions of the messages that were shown a memory, as ranges such as `3-5, 9, 14-20`. Position 1 is the first message in `unrelatedMessages.ts`. When the count moves, the positions show in the diff which messages moved.

### Two scoring rules

**The same answer in a page's words.** A page may state a fact in other words than the daily-log entry did. A question can list that second wording. The answer then counts as found when every part of the wording is in the block. The test also checks that every such wording really appears on the pages of the third condition on the day of asking.

**An old value counts only when it is shown as true now.** A page keeps old values under `Earlier:`. It keeps claims that nobody confirmed under the label for unconfirmed claims, and it marks them "not confirmed". A text in one of these places does not count as unwanted, because the page says plainly that it is old or unsure. A text on a normal line of a page counts. A note from the daily log always counts, because a note does not say that it is out of date.

This rule does not measure whether the model then uses a value shown under `Earlier:` in the right way. It only measures what the model is shown.

## Three conditions

The same 76 questions are asked three times. Each time the memory is set up in a different way, and each has its own recorded score.

1. **Log only, by words.** The memory holds only the daily log, and it is searched by shared words alone. It runs without the meaning model, so a change to the search by meaning does not move its numbers. Use it as the baseline.
2. **Log only, by meaning.** The memory is the same, but notes are found by meaning. A note is shown only when the message comes clearly closer to it than 460 ordinary messages do, and a message that is close to nothing remembered is shown no note at all. Shared words alone show nothing.
3. **Pages sorted, by meaning.** The memory also holds the pages about people and matters, and a list of the notes the sorter has already handled: every note saved before the day of the question counts as handled, because the sorter runs one day behind, and the notes of that day do not. A handled note is recorded as put on a page when its expected decision puts something on a page, and as put on no page when the decision is to ignore it. Single statements on the pages and the notes that are still eligible are judged together, under the same two rules (see `specs/memory-pages.md`, section 3). A note put on a page is not shown again from the log. A handled note put on no page is shown only when it is the person's own words.

The log-only conditions still hold the one page the person typed by hand, so a question that names that page through an earlier message of the chat is found in all three conditions.

The pages in the third condition are the ones a perfect sorter would write. They are built from the expected decisions of every entry, up to the end of the day of the question. So the numbers of the third condition are the best that sorting can reach. They are not what a real sorter reaches. A real sorter can only do worse or the same.

### Recorded vectors in place of the model

The search by meaning needs a model of about 120 MB, and unit tests cannot download it. So the test uses vectors that were recorded from the real model once. They are in `packages/trueforge/tests/fixtures/memory/recordedVectors/`, in two files: a list of the texts and the numbers for each.

Record them again when a text in the test changed, or when the model changed. A text that changed is a daily-log entry, a question, an unrelated message, a comparison message, or a page. The test tells you when a text has no recorded vector. Record them with this one command, and name the folder that holds the downloaded model:

```sh
pnpm --filter @truefoundry/trueforge memory:record-vectors --model-dir <folder>
```

Then commit the two files it writes.

## The recorded score

Today's numbers for all three conditions are written in `packages/trueforge/tests/unit/runtime/memory/fixtures/mayaRecallScore.test.ts`, together with the list of questions that are not clean in each condition and the two numbers for the unrelated messages. The test fails when any number moves.

When your change moves a number, write the new number in that file in the same pull request. If the numbers of the first condition move, check that your change is meant to change the search by words, because that condition does not use the meaning model. The reviewer then sees the difference. A better score is the point of the change. A worse score needs a reason in the pull request.

## Run it

```sh
pnpm --filter @truefoundry/trueforge test -- tests/unit/runtime/memory/fixtures
```

## Score the sorter

The same story is used to score the sorter that puts a saved note onto pages. For each story entry, the vault holds the pages a perfect sorter would have made from the earlier entries. A case is right when the decision kinds, the pages and, for same, changed and ended, the statement match what the story says. The text of new statements is not compared. Tests check the scorer with no model: one that answers perfectly gets every case right, and one that answers ignore to everything gets only the ignore cases right.

To score a real model, run this by hand. Nothing runs it automatically.

```sh
pnpm --filter @truefoundry/trueforge memory:sort-score -- --base-url <url> --model <name> [--api-key-env <NAME>] [--out <file>] [--all]
```

`--base-url` is an OpenAI-compatible endpoint. The key is read from the environment variable named by `--api-key-env` and is never printed. The command prints "N of M right" and a line per decision kind. It writes every miss to the `--out` file with the entry, what was expected and what the model said, and at most the first 80 characters of the note. `--all` adds the unrelated entries. This run finds pages by name only, so it understates the product, which also searches by meaning.

## Add to it

Add a story entry in `story.ts` with the next free place on its day, and say what it should do to the pages. Add a question in `recallQuestions.ts` and name the entries that hold its answer. For a message that has nothing to do with memory, use the kind `nothing_to_recall` and name no entries. The other tests in the same folder check that the story stays consistent, that no noise entry holds an answer, that no entry shares a topic word with such a message, that the sorted pages read back correctly, that the 300 unrelated messages are all different from each other and from the questions, that none of the 460 comparison messages is the same as a question or an unrelated message, and that the recorded vectors and the two scoring rules work.
