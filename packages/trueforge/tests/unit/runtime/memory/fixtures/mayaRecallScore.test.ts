import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  askMemory,
  memoryBlockFor,
  recallScorecard,
  warmEmbeddings,
  type RecallAnswer,
  type RecallScore,
} from '../../../../fixtures/memory/mayaWorld/askMemory';
import { buildMayaVault } from '../../../../fixtures/memory/mayaWorld/buildVault';
import { mayaDate } from '../../../../fixtures/memory/mayaWorld/pages';
import { positionRanges } from '../../../../fixtures/memory/mayaWorld/positionRanges';
import { MAYA_RECALL_QUESTIONS } from '../../../../fixtures/memory/mayaWorld/recallQuestions';
import { MAYA_UNRELATED_MESSAGES } from '../../../../fixtures/memory/mayaWorld/unrelatedMessages';
import {
  readRecordedVectors,
  RECORD_COMMAND,
  RecordedEmbeddingModel,
} from '../../../../fixtures/memory/recordedVectors';

const RECORDED_VECTORS_DIR = path.join(__dirname, '../../../../fixtures/memory/recordedVectors');

/** When set, the test only writes the texts the meaning search asks for to this file, for recording their vectors. */
const TEXTS_FILE = process.env['MEMORY_TEST_TEXTS_FILE'];

/** The day the questions end on, and the day the unrelated messages are asked. */
const LAST_DAY = 60;

type Miss = 'not found' | 'unwanted shown' | 'not found, unwanted shown';

/**
 * How recall does on Maya's world, once for each of three conditions. A change that moves any number
 * records the new one here, so the difference sits in the diff for a reviewer to judge: better is the
 * point, worse needs a reason.
 *
 * `found` counts questions whose answer was shown, of those that have one. `unwanted` counts questions
 * where something that should stay out was shown as current: a stale or planted text, or any memory at
 * all for a message with nothing to recall. `clean` counts questions with the answer shown and nothing
 * unwanted shown.
 *
 * `unrelatedShown` counts the 300 messages that have nothing to do with memory that were shown any memory
 * on day 60, each in a new chat; lower is better. `unrelatedShownAt` lists their positions, 1 to 300, so
 * a reviewer sees which messages moved.
 */
interface Condition {
  name: string;
  /** Whether the vault holds the pages a perfect sorter would write. */
  sorted: boolean;
  /** Whether memory is found by meaning as well as by words. */
  meaning: boolean;
  scores: Record<string, string>;
  misses: Record<string, Miss>;
  unrelatedShown: string;
  unrelatedShownAt: string;
}

/** Condition 1: the daily log only, found by words. The baseline for the other two. */
const LOG_ONLY_BY_WORDS_SCORES: Record<string, string> = {
  all: 'found 48/63, unwanted 25/29, clean 36/76',
  'answer at most 14 days old': 'found 32/39, unwanted 11/11, clean 22/40',
  'answer more than 14 days old': 'found 16/24, unwanted 4/6, clean 12/24',
  nothing_to_recall: 'found 0/0, unwanted 10/12, clean 2/12',
  relationship: 'found 4/5, unwanted 0/0, clean 4/5',
  asked_in_other_words: 'found 0/12, unwanted 0/1, clean 0/12',
  household_plan: 'found 5/5, unwanted 0/0, clean 5/5',
  how_you_write_to_them: 'found 4/5, unwanted 0/0, clean 4/5',
  current_value_of_changed_fact: 'found 13/13, unwanted 12/13, clean 1/13',
  unconfirmed_claim: 'found 4/4, unwanted 2/2, clean 3/5',
  no_name_in_message: 'found 3/4, unwanted 1/1, clean 2/4',
  temporary_fact: 'found 5/5, unwanted 0/0, clean 5/5',
  matter_status: 'found 5/5, unwanted 0/0, clean 5/5',
  earlier_fact: 'found 5/5, unwanted 0/0, clean 5/5',
};

/** The questions that are not clean in condition 1, each with what went wrong. */
const LOG_ONLY_BY_WORDS_MISSES: Record<string, Miss> = {
  q01: 'unwanted shown',
  q03: 'unwanted shown',
  q04: 'unwanted shown',
  q05: 'unwanted shown',
  q06: 'unwanted shown',
  q07: 'unwanted shown',
  q08: 'unwanted shown',
  q09: 'unwanted shown',
  q10: 'unwanted shown',
  q11: 'unwanted shown',
  q12: 'unwanted shown',
  q13: 'unwanted shown',
  q16: 'not found',
  q28: 'not found',
  q46: 'unwanted shown',
  q47: 'unwanted shown',
  q50: 'not found',
  q52: 'unwanted shown',
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

/** Condition 2: the daily log only, found by meaning as well as by words. */
const LOG_ONLY_BY_MEANING_SCORES: Record<string, string> = {
  all: 'found 46/63, unwanted 16/29, clean 48/76',
  'answer at most 14 days old': 'found 26/39, unwanted 11/11, clean 19/40',
  'answer more than 14 days old': 'found 20/24, unwanted 5/6, clean 17/24',
  nothing_to_recall: 'found 0/0, unwanted 0/12, clean 12/12',
  relationship: 'found 5/5, unwanted 0/0, clean 5/5',
  asked_in_other_words: 'found 5/12, unwanted 1/1, clean 5/12',
  household_plan: 'found 5/5, unwanted 0/0, clean 5/5',
  how_you_write_to_them: 'found 2/5, unwanted 0/0, clean 2/5',
  current_value_of_changed_fact: 'found 9/13, unwanted 13/13, clean 0/13',
  unconfirmed_claim: 'found 4/4, unwanted 2/2, clean 3/5',
  no_name_in_message: 'found 3/4, unwanted 0/1, clean 3/4',
  temporary_fact: 'found 5/5, unwanted 0/0, clean 5/5',
  matter_status: 'found 4/5, unwanted 0/0, clean 4/5',
  earlier_fact: 'found 4/5, unwanted 0/0, clean 4/5',
};

/** The questions that are not clean in condition 2. */
const LOG_ONLY_BY_MEANING_MISSES: Record<string, Miss> = {
  q01: 'not found, unwanted shown',
  q02: 'unwanted shown',
  q03: 'unwanted shown',
  q04: 'not found, unwanted shown',
  q05: 'unwanted shown',
  q06: 'unwanted shown',
  q07: 'unwanted shown',
  q08: 'unwanted shown',
  q09: 'not found, unwanted shown',
  q10: 'unwanted shown',
  q11: 'unwanted shown',
  q12: 'not found, unwanted shown',
  q13: 'unwanted shown',
  q25: 'not found',
  q26: 'not found',
  q28: 'not found',
  q35: 'not found',
  q41: 'not found',
  q46: 'unwanted shown',
  q47: 'unwanted shown',
  q51: 'not found',
  q53: 'not found',
  q54: 'not found',
  q55: 'not found',
  q60: 'not found',
  q62: 'not found',
  q63: 'not found',
  q64: 'not found, unwanted shown',
};

/** Condition 3: the pages a perfect sorter would write, found by meaning as well as by words. */
const PAGES_SORTED_BY_MEANING_SCORES: Record<string, string> = {
  all: 'found 57/63, unwanted 0/29, clean 70/76',
  'answer at most 14 days old': 'found 34/39, unwanted 0/11, clean 35/40',
  'answer more than 14 days old': 'found 23/24, unwanted 0/6, clean 23/24',
  nothing_to_recall: 'found 0/0, unwanted 0/12, clean 12/12',
  relationship: 'found 5/5, unwanted 0/0, clean 5/5',
  asked_in_other_words: 'found 6/12, unwanted 0/1, clean 6/12',
  household_plan: 'found 5/5, unwanted 0/0, clean 5/5',
  how_you_write_to_them: 'found 5/5, unwanted 0/0, clean 5/5',
  current_value_of_changed_fact: 'found 13/13, unwanted 0/13, clean 13/13',
  unconfirmed_claim: 'found 4/4, unwanted 0/2, clean 5/5',
  no_name_in_message: 'found 4/4, unwanted 0/1, clean 4/4',
  temporary_fact: 'found 5/5, unwanted 0/0, clean 5/5',
  matter_status: 'found 5/5, unwanted 0/0, clean 5/5',
  earlier_fact: 'found 5/5, unwanted 0/0, clean 5/5',
};

/** The questions that are not clean in condition 3. */
const PAGES_SORTED_BY_MEANING_MISSES: Record<string, Miss> = {
  q53: 'not found',
  q54: 'not found',
  q55: 'not found',
  q57: 'not found',
  q58: 'not found',
  q62: 'not found',
};

const LOG_ONLY_BY_WORDS: Condition = {
  name: 'log only, by words',
  sorted: false,
  meaning: false,
  scores: LOG_ONLY_BY_WORDS_SCORES,
  misses: LOG_ONLY_BY_WORDS_MISSES,
  unrelatedShown: 'shown a memory 269/300',
  unrelatedShownAt: '1-86, 88-255, 257-259, 261-263, 265, 271, 272, 274, 275, 296, 297, 299, 300',
};
const LOG_ONLY_BY_MEANING: Condition = {
  name: 'log only, by meaning',
  sorted: false,
  meaning: true,
  scores: LOG_ONLY_BY_MEANING_SCORES,
  misses: LOG_ONLY_BY_MEANING_MISSES,
  unrelatedShown: 'shown a memory 30/300',
  unrelatedShownAt:
    '1, 5, 6, 16, 20, 30, 34, 46, 55, 56, 62, 68, 73, 102, 112, 113, 124, 125, 136, 138, 141, 157, 177, 178, 216, 218, 235, 236, 238, 239',
};
const PAGES_SORTED_BY_MEANING: Condition = {
  name: 'pages sorted, by meaning',
  sorted: true,
  meaning: true,
  scores: PAGES_SORTED_BY_MEANING_SCORES,
  misses: PAGES_SORTED_BY_MEANING_MISSES,
  unrelatedShown: 'shown a memory 20/300',
  unrelatedShownAt: '1, 5, 20, 62, 73, 78, 102, 112, 121, 124, 125, 136, 138, 141, 177, 200, 218, 238, 258, 270',
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
  const dirs: string[] = [];
  let model = new RecordedEmbeddingModel(new Map());

  async function vaultDir(): Promise<string> {
    const dir = await mkdtemp(path.join(tmpdir(), 'maya-recall-'));
    dirs.push(dir);
    return dir;
  }

  async function ask(condition: Condition): Promise<{ answers: RecallAnswer[]; unrelatedShown: number[] }> {
    const dir = await vaultDir();
    const answers: RecallAnswer[] = [];
    let written = 0;
    const inOrder = [...MAYA_RECALL_QUESTIONS].sort((a, b) => a.as_of_day - b.as_of_day || a.id.localeCompare(b.id));
    for (const question of inOrder) {
      if (question.as_of_day > written) {
        await buildMayaVault({
          dir,
          fromDay: written + 1,
          throughDay: question.as_of_day,
          sorted: condition.sorted,
        });
        written = question.as_of_day;
      }
      jest.setSystemTime(new Date(`${mayaDate(question.as_of_day)}T21:00:00.000Z`));
      const embeddings = condition.meaning ? await warmEmbeddings({ dir, model }) : undefined;
      answers.push(await askMemory({ dir, question, embeddings }));
    }
    if (written !== LAST_DAY) {
      throw new Error(
        `The questions end on day ${String(written)}, not day ${String(LAST_DAY)}. Change LAST_DAY to match.`,
      );
    }
    // The questions end on day 60, so this vault is ready. Asked last, so nothing here can change an answer above.
    jest.setSystemTime(new Date(`${mayaDate(LAST_DAY)}T21:00:00.000Z`));
    const embeddings = condition.meaning ? await warmEmbeddings({ dir, model }) : undefined;
    const unrelatedShown: number[] = [];
    for (const [index, message] of MAYA_UNRELATED_MESSAGES.entries()) {
      const block = await memoryBlockFor({
        dir,
        message,
        earlierMessages: [],
        chatId: `unrelated-${String(index + 1)}`,
        embeddings,
      });
      if (block !== '') {
        unrelatedShown.push(index + 1);
      }
    }
    return { answers, unrelatedShown };
  }

  function expectRecorded({
    condition,
    asked: { answers, unrelatedShown },
  }: {
    condition: Condition;
    asked: { answers: RecallAnswer[]; unrelatedShown: number[] };
  }): void {
    const misses = Object.fromEntries(
      answers.flatMap(answer => {
        const miss = missOf(answer);
        return miss === undefined ? [] : [[answer.question.id, miss]];
      }),
    );
    expect(misses).toEqual(condition.misses);
    expect(Object.fromEntries(recallScorecard(answers).map(score => [score.group, scoreLine(score)]))).toEqual(
      condition.scores,
    );
    expect(`shown a memory ${String(unrelatedShown.length)}/${String(MAYA_UNRELATED_MESSAGES.length)}`).toBe(
      condition.unrelatedShown,
    );
    expect(positionRanges(unrelatedShown)).toBe(condition.unrelatedShownAt);
  }

  function expectNothingMissing(): void {
    const missing = model.missingTexts.length;
    if (missing > 0) {
      throw new Error(
        `${String(missing)} texts have no recorded search vector, so the numbers would not be a measurement. Run \`${RECORD_COMMAND}\` with the folder that holds the downloaded search model, then commit the two files it writes.`,
      );
    }
  }

  beforeAll(async () => {
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
    // Asking for the texts must work before any vector is recorded.
    model = new RecordedEmbeddingModel(
      TEXTS_FILE === undefined ? await readRecordedVectors({ dir: RECORDED_VECTORS_DIR }) : new Map(),
    );
  });

  afterAll(async () => {
    jest.useRealTimers();
    await Promise.all(dirs.map(async dir => rm(dir, { recursive: true, force: true })));
  });

  if (TEXTS_FILE !== undefined) {
    it('lists the texts the meaning search asks for', async () => {
      await ask(LOG_ONLY_BY_MEANING);
      await ask(PAGES_SORTED_BY_MEANING);
      await mkdir(path.dirname(TEXTS_FILE), { recursive: true });
      await writeFile(TEXTS_FILE, `${JSON.stringify(model.requestedTexts)}\n`, 'utf8');
    }, 300_000);
    return;
  }

  it(`scores as recorded: ${LOG_ONLY_BY_WORDS.name}`, async () => {
    expectRecorded({ condition: LOG_ONLY_BY_WORDS, asked: await ask(LOG_ONLY_BY_WORDS) });
  }, 120_000);

  it.each([LOG_ONLY_BY_MEANING, PAGES_SORTED_BY_MEANING])(
    'scores as recorded: $name',
    async condition => {
      const asked = await ask(condition);
      expectNothingMissing();
      expectRecorded({ condition, asked });
    },
    300_000,
  );
});
