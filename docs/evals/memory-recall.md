# Memory recall test

The memory recall test checks whether Aman puts the right memories in front of the model. It runs with the unit tests. It needs no model, no key and no running Aman.

## What is in it

**Maya's world.** Sixty days of a made-up household's memory, from August 1 to September 29, 2026. Maya lives with her wife Wendy and their daughter Zoe. Around them are a plumber and a colleague who are both called Sam, a manager, friends, a client, a trip to Madrid, a kitchen renovation and a tax return. The world is written as about 520 daily-log entries:

- about 155 hand-written entries that tell the story,
- about 365 entries of everyday noise, such as receipts, calendar entries and passing remarks.

The story holds the hard cases on purpose. Facts change, such as the dates of the trip. Some facts are true only for a while, such as a week of leave. The same fact is said twice in different words. Maya sends emails that show how she writes to each person. One email tries to plant an instruction. Maya edits one page by hand, and a later email contradicts it.

**Expected decisions.** Every entry says what should happen to the pages about people and matters when that entry is sorted: a new fact, the same fact again, a changed fact, a fact that ended, something not confirmed, or nothing. The step that sorts entries into pages will be tested against these.

**Questions.** Maya asks 76 questions on different days. Each question names the text that must be in the memory shown to the model. Some also name a text that should not be there, such as the old dates of the trip. Twelve questions are asked in other words: they share no topic word with the entry that holds the answer, such as "Who lives next door to us?" for the neighbour at number 14. Only a search by meaning can answer those.

Twelve more are messages that have nothing to do with memory, such as "What is 17 times 23?". No entry in the world shares a topic word with them. For these, no memory should be shown at all.

The files are in `packages/trueforge/tests/fixtures/memory/mayaWorld/`.

## How a question is scored

The test writes the world into an empty memory folder, one day at a time, through the same code Aman uses to save memories. On the day of each question it runs the same step that builds the memory block before every reply. Then it reads the block.

- **Found**: the expected text is in the block. It also counts when the question has a second wording and every part of it is in the block (see the first rule below).
- **Unwanted**: the stale or planted text is in the block and is shown as if it were true now (see the second rule below). For a message that has nothing to do with memory, any memory in the block is unwanted.
- **Clean**: the expected text is there, and nothing unwanted is. For a message that has nothing to do with memory, clean means the block is empty.

The scorecard counts these for all questions, for answers at most 14 days old, for answers older than that, and for each kind of question.

This test reads what the model is shown. It does not read what the model then answers. A test that scores answers needs a model and is a separate step.

### Two scoring rules

**The same answer in a page's words.** A page may state a fact in other words than the daily-log entry did. A question can list that second wording. The answer then counts as found when every part of the wording is in the block. The test also checks that every such wording really appears on the pages of the third condition on the day of asking.

**An old value counts only when it is shown as true now.** A page keeps old values under `Earlier:`. It keeps claims that nobody confirmed under the label for unconfirmed claims, and it marks them "not confirmed". A text in one of these places does not count as unwanted, because the page says plainly that it is old or unsure. A text on a normal line of a page counts. A note from the daily log always counts, because a note does not say that it is out of date.

This rule does not measure whether the model then uses a value shown under `Earlier:` in the right way. It only measures what the model is shown.

## Three conditions

The same 76 questions are asked three times. Each time the memory is set up in a different way, and each has its own recorded score.

1. **Log only, by words.** The memory holds only the daily log. Memories are found by their words. This is how the test ran before the other two were added. Its numbers must not move.
2. **Log only, by meaning.** The memory is the same, but memories are also found by meaning. This shows what the search by meaning adds on its own.
3. **Pages sorted, by meaning.** The memory also holds the pages about people and matters. Memories are found by meaning as well.

The pages in the third condition are the ones a perfect sorter would write. They are built from the expected decisions of every entry, up to the end of the day of the question. So the numbers of the third condition are the best that sorting can reach. They are not what a real sorter reaches. A real sorter can only do worse or the same.

### Recorded vectors in place of the model

The search by meaning needs a model of about 120 MB, and unit tests cannot download it. So the test uses vectors that were recorded from the real model once. They are in `packages/trueforge/tests/fixtures/memory/recordedVectors/`, in two files: a list of the texts and the numbers for each.

Record them again when a text in the test changed, or when the model changed. A text that changed is a daily-log entry, a question, or a page. The test tells you when a text has no recorded vector. Record them with this one command, and name the folder that holds the downloaded model:

```sh
pnpm --filter @truefoundry/trueforge memory:record-vectors --model-dir <folder>
```

Then commit the two files it writes.

## The recorded score

Today's numbers for all three conditions are written in `packages/trueforge/tests/unit/runtime/memory/fixtures/mayaRecallScore.test.ts`, together with the list of questions that are not clean in each condition. The test fails when any number moves.

When your change moves a number, write the new number in that file in the same pull request. If the numbers of the first condition move, something other than your change is wrong, so find out why before you record them. The reviewer then sees the difference. A better score is the point of the change. A worse score needs a reason in the pull request.

## Run it

```sh
pnpm --filter @truefoundry/trueforge test -- tests/unit/runtime/memory/fixtures
```

## Add to it

Add a story entry in `story.ts` with the next free place on its day, and say what it should do to the pages. Add a question in `recallQuestions.ts` and name the entries that hold its answer. For a message that has nothing to do with memory, use the kind `nothing_to_recall` and name no entries. The other tests in the same folder check that the story stays consistent, that no noise entry holds an answer, that no entry shares a topic word with such a message, that the sorted pages read back correctly, and that the recorded vectors and the two scoring rules work.
