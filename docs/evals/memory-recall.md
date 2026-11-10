# Memory recall test

The memory recall test checks whether Aman puts the right memories in front of the model. It runs with the unit tests. It needs no model, no key and no running Aman.

## What is in it

**Maya's world.** Sixty days of a made-up household's memory, from August 1 to September 29, 2026. Maya lives with her wife Wendy and their daughter Zoe. Around them are a plumber and a colleague who are both called Sam, a manager, friends, a client, a trip to Madrid, a kitchen renovation and a tax return. The world is written as about 520 daily-log entries:

- about 155 hand-written entries that tell the story,
- about 365 entries of everyday noise, such as receipts, calendar entries and passing remarks.

The story holds the hard cases on purpose. Facts change, such as the dates of the trip. Some facts are true only for a while, such as a week of leave. The same fact is said twice in different words. Maya sends emails that show how she writes to each person. One email tries to plant an instruction. Maya edits one page by hand, and a later email contradicts it.

**Expected decisions.** Every entry says what should happen to the pages about people and matters when that entry is sorted: a new fact, the same fact again, a changed fact, a fact that ended, something not confirmed, or nothing. The step that sorts entries into pages will be tested against these.

**Questions.** Maya asks 64 questions on different days. Each question names the text that must be in the memory shown to the model. Some also name a text that should not be there, such as the old dates of the trip. Twelve questions are asked in other words: they share no topic word with the entry that holds the answer, such as "Who lives next door to us?" for the neighbour at number 14. Only a search by meaning can answer those.

The files are in `packages/trueforge/tests/fixtures/memory/mayaWorld/`.

## How a question is scored

The test writes the world into an empty memory folder, one day at a time, through the same code Aman uses to save memories. On the day of each question it runs the same step that builds the memory block before every reply. Then it reads the block.

- **Found**: the expected text is in the block.
- **Unwanted**: the stale or planted text is in the block.
- **Clean**: the expected text is there, and no unwanted text is.

The scorecard counts these for all questions, for answers at most 14 days old, for answers older than that, and for each kind of question.

This test reads what the model is shown. It does not read what the model then answers. A test that scores answers needs a model and is a separate step.

The test runs with the search by words only, because the search by meaning needs a model to be downloaded. So the recorded score for the questions asked in other words is 0 of 12. To see what the search by meaning adds, run the same questions on a machine that has the model.

## The recorded score

Today's numbers are written in `packages/trueforge/tests/unit/runtime/memory/fixtures/mayaRecallScore.test.ts`, together with the list of questions that are not clean. The test fails when any number moves.

When your change moves a number, write the new number in that file in the same pull request. The reviewer then sees the difference. A better score is the point of the change. A worse score needs a reason in the pull request.

## Run it

```sh
pnpm --filter @truefoundry/trueforge test -- tests/unit/runtime/memory/fixtures
```

## Add to it

Add a story entry in `story.ts` with the next free place on its day, and say what it should do to the pages. Add a question in `recallQuestions.ts` and name the entries that hold its answer. The other two tests in the same folder check that the story stays consistent and that no noise entry holds an answer.
