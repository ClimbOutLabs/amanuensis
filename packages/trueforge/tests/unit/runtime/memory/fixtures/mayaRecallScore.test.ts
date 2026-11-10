import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  askMemory,
  recallScorecard,
  type RecallAnswer,
  type RecallScore,
} from '../../../../fixtures/memory/mayaWorld/askMemory';
import { buildMayaVault } from '../../../../fixtures/memory/mayaWorld/buildVault';
import { mayaDate } from '../../../../fixtures/memory/mayaWorld/pages';
import { MAYA_RECALL_QUESTIONS } from '../../../../fixtures/memory/mayaWorld/recallQuestions';

/**
 * How recall does on Maya's world today. A change that moves any number records the new one here, so
 * the difference sits in the diff for a reviewer to judge: better is the point, worse needs a reason.
 *
 * `found` counts questions whose answer was shown, of those that have one. `unwanted` counts questions
 * where something that should stay out was shown: a stale or planted text, or any memory at all for a
 * message with nothing to recall. `clean` counts questions with the answer shown and nothing unwanted.
 */
const RECORDED_SCORES: Record<string, string> = {
  all: 'found 32/63, unwanted 14/29, clean 31/76',
  'answer at most 14 days old': 'found 31/39, unwanted 4/11, clean 28/40',
  'answer more than 14 days old': 'found 1/24, unwanted 0/6, clean 1/24',
  current_value_of_changed_fact: 'found 9/13, unwanted 2/13, clean 7/13',
  relationship: 'found 2/5, unwanted 0/0, clean 2/5',
  household_plan: 'found 4/5, unwanted 0/0, clean 4/5',
  how_you_write_to_them: 'found 3/5, unwanted 0/0, clean 3/5',
  temporary_fact: 'found 3/5, unwanted 0/0, clean 3/5',
  earlier_fact: 'found 1/5, unwanted 0/0, clean 1/5',
  matter_status: 'found 5/5, unwanted 0/0, clean 5/5',
  unconfirmed_claim: 'found 4/4, unwanted 2/2, clean 3/5',
  no_name_in_message: 'found 1/4, unwanted 0/1, clean 1/4',
  asked_in_other_words: 'found 0/12, unwanted 0/1, clean 0/12',
  nothing_to_recall: 'found 0/0, unwanted 10/12, clean 2/12',
};

/** The questions that are not clean today, each with what went wrong. */
const RECORDED_MISSES: Record<string, 'not found' | 'unwanted shown' | 'not found, unwanted shown'> = {
  q02: 'not found',
  q04: 'not found',
  q06: 'not found',
  q07: 'unwanted shown',
  q08: 'not found',
  q12: 'unwanted shown',
  q15: 'not found',
  q16: 'not found',
  q18: 'not found',
  q21: 'not found',
  q24: 'not found',
  q28: 'not found',
  q29: 'not found',
  q30: 'not found',
  q34: 'not found',
  q35: 'not found',
  q36: 'not found',
  q38: 'not found',
  q46: 'unwanted shown',
  q47: 'unwanted shown',
  q49: 'not found',
  q50: 'not found',
  q52: 'not found',
  q53: 'not found',
  q54: 'not found',
  q55: 'not found',
  q56: 'not found',
  q57: 'not found',
  q58: 'not found',
  q59: 'not found',
  q60: 'not found',
  q61: 'not found',
  q62: 'not found',
  q63: 'not found',
  q64: 'not found',
  q66: 'unwanted shown',
  q67: 'unwanted shown',
  q68: 'unwanted shown',
  q69: 'unwanted shown',
  q71: 'unwanted shown',
  q72: 'unwanted shown',
  q73: 'unwanted shown',
  q74: 'unwanted shown',
  q75: 'unwanted shown',
  q76: 'unwanted shown',
};

function scoreLine(score: RecallScore): string {
  return (
    `found ${String(score.found)}/${String(score.expectsText)}, ` +
    `unwanted ${String(score.unwanted)}/${String(score.namesUnwanted)}, ` +
    `clean ${String(score.clean)}/${String(score.questions)}`
  );
}

function missOf(answer: RecallAnswer): string | undefined {
  const problems = [
    ...(answer.found === false ? ['not found'] : []),
    ...(answer.unwanted === true ? ['unwanted shown'] : []),
  ];
  return problems.length === 0 ? undefined : problems.join(', ');
}

describe("recall over Maya's world", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'maya-recall-'));
    // Only the calendar is faked: files and timeouts keep running on the real clock.
    jest.useFakeTimers({
      doNotFake: [
        'hrtime',
        'nextTick',
        'performance',
        'queueMicrotask',
        'requestAnimationFrame',
        'cancelAnimationFrame',
        'requestIdleCallback',
        'cancelIdleCallback',
        'setImmediate',
        'clearImmediate',
        'setInterval',
        'clearInterval',
        'setTimeout',
        'clearTimeout',
      ],
    });
  });

  afterAll(async () => {
    jest.useRealTimers();
    await rm(dir, { recursive: true, force: true });
  });

  it('scores as recorded', async () => {
    const answers: RecallAnswer[] = [];
    let written = 0;
    const inOrder = [...MAYA_RECALL_QUESTIONS].sort((a, b) => a.as_of_day - b.as_of_day || a.id.localeCompare(b.id));
    for (const question of inOrder) {
      if (question.as_of_day > written) {
        await buildMayaVault({ dir, fromDay: written + 1, throughDay: question.as_of_day });
        written = question.as_of_day;
      }
      jest.setSystemTime(new Date(`${mayaDate(question.as_of_day)}T21:00:00.000Z`));
      answers.push(await askMemory({ dir, question }));
    }

    const misses = Object.fromEntries(
      answers.flatMap(answer => {
        const miss = missOf(answer);
        return miss === undefined ? [] : [[answer.question.id, miss]];
      }),
    );
    expect(misses).toEqual(RECORDED_MISSES);
    expect(Object.fromEntries(recallScorecard(answers).map(score => [score.group, scoreLine(score)]))).toEqual(
      RECORDED_SCORES,
    );
  }, 120_000);
});
