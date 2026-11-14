import { DRAFTING_HEADING, UNCONFIRMED_LABEL } from '../../../../../src/runtime/memory/memoryPageLoader';
import { judgeBlock } from '../../../../fixtures/memory/mayaWorld/askMemory';
import { RecallQuestionSchema, type RecallQuestion } from '../../../../fixtures/memory/mayaWorld/schema';

const OLD = 'Thursday mornings';

function question(fields: Record<string, unknown>): RecallQuestion {
  return RecallQuestionSchema.parse({
    id: 'q99',
    as_of_day: 20,
    message: 'Which day does the plumber come?',
    category: 'current_value_of_changed_fact',
    source_entry_ids: ['d18_e01'],
    ...fields,
  });
}

const staleQuestion = question({ expected_text: 'Tuesday afternoons', must_not_text: OLD });

function block(...lines: string[]): string {
  return ['<aman-memory>', 'Background.', ...lines, '(memory: 3 items; 1 pages)', '</aman-memory>'].join('\n');
}

const HEADER = '[page: Sam Rossi — person; also called: plumber]';

describe('an old value counts only when it is shown as current', () => {
  it('does not count under Earlier', () => {
    const shown = block(
      HEADER,
      'Now:',
      '- Sam Rossi comes on Tuesday afternoons. (you said, since 2026-08-18)',
      'Earlier:',
      `- Sam Rossi comes on ${OLD}. (you said, 2026-08-02 to 2026-08-18)`,
    );
    expect(judgeBlock({ block: shown, question: staleQuestion })).toEqual({ found: true, unwanted: false });
  });

  it('does not count under the unconfirmed label', () => {
    const shown = block(
      HEADER,
      'Now:',
      '- Sam Rossi comes on Tuesday afternoons. (you said, since 2026-08-18)',
      `${UNCONFIRMED_LABEL}:`,
      `- Sam Rossi comes on ${OLD}. (from mail, not confirmed, seen 2026-08-10)`,
    );
    expect(judgeBlock({ block: shown, question: staleQuestion }).unwanted).toBe(false);
  });

  it('does not count on a line marked not confirmed under Now', () => {
    const shown = block(HEADER, 'Now:', `- Sam Rossi comes on ${OLD}. (from mail, not confirmed, seen 2026-08-10)`);
    expect(judgeBlock({ block: shown, question: staleQuestion }).unwanted).toBe(false);
  });

  it('counts as current under Now', () => {
    const shown = block(HEADER, 'Now:', `- Sam Rossi comes on ${OLD}. (you said, since 2026-08-02)`);
    expect(judgeBlock({ block: shown, question: staleQuestion }).unwanted).toBe(true);
  });

  it('counts in a note from the daily log after the pages, even right after Earlier', () => {
    const shown = block(
      HEADER,
      'Earlier:',
      '- Sam Rossi comes on Wednesdays. (you said, 2026-07-01 to 2026-08-02)',
      `[2026-08-02] Sam Rossi comes on ${OLD}.`,
    );
    expect(judgeBlock({ block: shown, question: staleQuestion }).unwanted).toBe(true);
  });

  it('counts in the drafting part, which ends the page', () => {
    const shown = block(
      HEADER,
      'Earlier:',
      '- Sam Rossi comes on Wednesdays. (you said, 2026-07-01 to 2026-08-02)',
      DRAFTING_HEADING,
      'Sam Rossi:',
      `- Write about ${OLD}.`,
    );
    expect(judgeBlock({ block: shown, question: staleQuestion }).unwanted).toBe(true);
  });

  it('counts on the next page after an Earlier part', () => {
    const shown = block(
      HEADER,
      'Earlier:',
      `- Sam Rossi comes on ${OLD}. (you said, 2026-08-02 to 2026-08-18)`,
      '[page: Nora — person]',
      'Now:',
      `- Nora hears about ${OLD}. (you said, since 2026-08-02)`,
    );
    expect(judgeBlock({ block: shown, question: staleQuestion }).unwanted).toBe(true);
  });

  it('keeps the rule for a message with nothing to recall: any block is unwanted', () => {
    const nothing = question({ category: 'nothing_to_recall', source_entry_ids: [] });
    expect(judgeBlock({ block: block(HEADER, 'Now:', '- Something. (you said)'), question: nothing }).unwanted).toBe(
      true,
    );
    expect(judgeBlock({ block: '', question: nothing }).unwanted).toBe(false);
  });
});

describe("an answer in a page's words", () => {
  const wording = question({
    expected_text: 'Tuesday afternoons',
    page_wording: ['Sam Rossi comes on Tuesday', 'since 2026-08-18'],
  });

  it('counts when every string of the wording is in the block, ignoring case', () => {
    const shown = block(HEADER, 'Now:', '- sam rossi comes on tuesday mornings. (you said, since 2026-08-18)');
    expect(judgeBlock({ block: shown, question: wording }).found).toBe(true);
  });

  it('does not count when one string is missing', () => {
    const shown = block(HEADER, 'Now:', '- Sam Rossi comes on Tuesday mornings. (you said, since 2026-08-19)');
    expect(judgeBlock({ block: shown, question: wording }).found).toBe(false);
  });

  it('counts the plain expected text without any wording', () => {
    expect(judgeBlock({ block: block('[2026-08-18] He comes on Tuesday afternoons.'), question: wording }).found).toBe(
      true,
    );
  });
});
