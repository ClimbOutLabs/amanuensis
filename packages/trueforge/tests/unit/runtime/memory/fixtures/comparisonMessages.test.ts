import { COMPARISON_MESSAGES } from '../../../../../src/runtime/memory/comparisonMessages';
import { MAYA_RECALL_QUESTIONS } from '../../../../fixtures/memory/mayaWorld/recallQuestions';
import { MAYA_UNRELATED_MESSAGES } from '../../../../fixtures/memory/mayaWorld/unrelatedMessages';

/** Lower-cased, with every run of characters that are not letters or digits turned into one space. */
function plain(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

describe('comparison messages', () => {
  it('hold 460 different messages', () => {
    expect(COMPARISON_MESSAGES).toHaveLength(460);
    expect(new Set(COMPARISON_MESSAGES.map(plain)).size).toBe(460);
  });

  it('are not any message the memory test asks', () => {
    const asked = new Map(
      [...MAYA_RECALL_QUESTIONS.map(question => question.message), ...MAYA_UNRELATED_MESSAGES].map(text => [
        plain(text),
        text,
      ]),
    );
    const same = COMPARISON_MESSAGES.filter(text => asked.has(plain(text))).map(text => [text, asked.get(plain(text))]);
    expect(same).toEqual([]);
  });
});
