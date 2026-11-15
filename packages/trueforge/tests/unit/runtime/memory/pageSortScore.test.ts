import { execFileRunner } from '@truefoundry/trueforge-core/core';
import { createLogger } from 'winston';

import { sortNote, type SortModel } from '../../../../src/runtime/memory/pageSorter';
import type { ExpectedDecision } from '../../../fixtures/memory/decisionSchema';
import { MAYA_ENTRIES } from '../../../fixtures/memory/mayaWorld/entries';
import {
  describeScore,
  MAYA_STORY_ENTRIES,
  scoreSorter,
  statementIdFor,
  type SorterUnderTest,
} from '../../../fixtures/memory/mayaWorld/sortScore';

/** The decision as the model would write it: an existing statement is named by the id the prompt shows. */
async function asModelDecision({ vaultDir, decision }: { vaultDir: string; decision: ExpectedDecision }) {
  switch (decision.decision) {
    case 'same': {
      const { matches_text: text, ...rest } = decision;
      return { ...rest, statement_id: await statementIdFor({ vaultDir, about: decision.about, text }) };
    }
    case 'changed':
    case 'ended': {
      const { old_text: text, ...rest } = decision;
      return { ...rest, statement_id: await statementIdFor({ vaultDir, about: decision.about, text }) };
    }
    default:
      return decision;
  }
}

function sorterAnswering(answer: (input: Parameters<SorterUnderTest>[0]) => Promise<unknown>): SorterUnderTest {
  return async input => {
    const reply = JSON.stringify({ decisions: await answer(input) });
    const askModel: SortModel = () => Promise.resolve({ ok: true, reply });
    return sortNote({
      mode: 'report',
      note: input.note,
      askModel,
      similarPages: () => Promise.resolve(input.expectedPages),
      options: {
        vaultDir: input.vaultDir,
        runner: execFileRunner,
        today: input.note.day,
        logger: createLogger({ silent: true }),
      },
    });
  };
}

const perfect = sorterAnswering(({ vaultDir, entry }) =>
  Promise.all(entry.expected.map(decision => asModelDecision({ vaultDir, decision }))),
);

const ignoresEverything = sorterAnswering(() => Promise.resolve([{ decision: 'ignore', reason: 'Nothing to keep.' }]));

describe('scoring a sorter over Maya’s world', () => {
  it('has decision cases of every kind', () => {
    const kinds = new Set(MAYA_STORY_ENTRIES.flatMap(entry => entry.expected.map(decision => decision.decision)));
    expect([...kinds].sort()).toEqual(['changed', 'ended', 'ignore', 'new', 'same', 'unconfirmed']);
  });

  it('marks every story entry right for a model that answers perfectly', async () => {
    const score = await scoreSorter({ sorter: perfect });
    expect(score.misses).toEqual([]);
    expect(score.right).toBe(MAYA_STORY_ENTRIES.length);
    expect(describeScore(score)).toContain(`${String(score.total)} of ${String(score.total)} right`);
  }, 120_000);

  it('marks every noise entry right for a model that answers perfectly', async () => {
    const noise = MAYA_ENTRIES.filter(entry => !MAYA_STORY_ENTRIES.includes(entry));
    const score = await scoreSorter({ sorter: perfect, entries: noise });
    expect(score.misses).toEqual([]);
  }, 120_000);

  it('counts only the entries with nothing to put on a page for a model that ignores everything', async () => {
    const score = await scoreSorter({ sorter: ignoresEverything });
    const nothingToKeep = MAYA_STORY_ENTRIES.filter(entry =>
      entry.expected.every(decision => decision.decision === 'ignore'),
    ).length;
    expect(score.right).toBe(nothingToKeep);
    expect(score.total - score.right).toBe(score.misses.length);
    expect(score.byKind.ignore).toEqual({ expected: nothingToKeep, right: nothingToKeep });
    expect(score.byKind.new.right).toBe(0);
    expect(score.byKind.new.expected).toBeGreaterThan(0);
    for (const miss of score.misses) {
      expect(miss.note.length).toBeLessThanOrEqual(80);
    }
  }, 120_000);
});
