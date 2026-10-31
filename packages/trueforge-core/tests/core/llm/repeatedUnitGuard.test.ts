import { RepeatedUnitGuard } from '../../../src/core/llm/repeatedUnitGuard';

/** Feeds pieces through the guard the way the stream does, returning what would be shown. */
function run(pieces: string[]): { shown: string; stopped: boolean } {
  const guard = new RepeatedUnitGuard();
  let shown = '';
  for (const piece of pieces) {
    const step = guard.push(piece);
    shown += step.text;
    if (step.stopped) {
      return { shown, stopped: true };
    }
  }
  const rest = guard.finish();
  return { shown: shown + rest.text, stopped: rest.stopped };
}

const CLOSING = 'Let me know if there is anything else you need.\n';
const SENTENCE = 'Let me know if you need anything else.';
const PLAN = 'Plan A is set. ';
const LONG_SENTENCE = 'The pantry list now holds pasta, tomatoes, basil, garlic, olive oil and parmesan cheese.';
const TWELVE_WORDS = 'Your space is ready with the headings and lines you asked for.';
const ELEVEN_WORDS = 'Your space is ready with the headings and lines you asked.';

describe('RepeatedUnitGuard', () => {
  it('streams text that repeats nothing straight through, piece by piece', () => {
    const guard = new RepeatedUnitGuard();
    expect(guard.push('Hello ').text).toBe('Hello ');
    expect(guard.push('there, friend.').text).toBe('there, friend.');
    expect(guard.finish()).toEqual({ text: '', stopped: false });
  });

  it('stops before the third copy of a closing sentence, keeping the first two', () => {
    const result = run(['Summary of the day here.\n', ...Array.from({ length: 6 }, () => CLOSING)]);
    expect(result).toEqual({ shown: `Summary of the day here.\n${CLOSING.repeat(2)}`, stopped: true });
  });

  it('stops at the same point when the text arrives one character at a time', () => {
    const text = `Summary of the day here.\n${CLOSING.repeat(6)}`;
    expect(run(text.split(''))).toEqual({ shown: `Summary of the day here.\n${CLOSING.repeat(2)}`, stopped: true });
  });

  it('stops a two-line block before its third copy', () => {
    const block = 'Let me know if there is anything else you need.\nSee you at the next review.\n';
    expect(run([block.repeat(5)])).toEqual({ shown: block.repeat(2), stopped: true });
  });

  it('counts a repeat across the whole reply, not only back to back', () => {
    expect(run([`${SENTENCE} ${PLAN}${SENTENCE} ${PLAN}${SENTENCE} Next step is ready.`])).toEqual({
      // The space before the held third copy is part of that copy, so it is not shown either.
      shown: `${SENTENCE} ${PLAN}${SENTENCE} ${PLAN.trimEnd()}`,
      stopped: true,
    });
  });

  it('stops on a third copy that ends the reply', () => {
    expect(run([`${SENTENCE} ${SENTENCE} ${SENTENCE}`])).toEqual({
      shown: `${SENTENCE} ${SENTENCE}`,
      stopped: true,
    });
  });

  it('keeps a sentence that repeats twice and then goes on, exactly as written', () => {
    const text = `${SENTENCE} ${PLAN}${SENTENCE} Plan B is next.`;
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('does not count rules or fences, which are markup rather than sentences', () => {
    const text = '---\n---\n---\nDone.\n';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('stops a third identical line of six or more words', () => {
    const line = 'Please check the build output again.\n';
    expect(run([`${line}${line}${line}Fine.\n`])).toEqual({ shown: line.repeat(2), stopped: true });
  });

  it('never counts sentences shorter than six words, however often they repeat', () => {
    const text = 'Done. Yes. Done. Yes. Done. Yes. Done.';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('shows a repeat that breaks off before a third copy, so nothing is lost', () => {
    const text = `${SENTENCE}\n${SENTENCE}\nNext, the review is due.\n`;
    expect(run(text.split(''))).toEqual({ shown: text, stopped: false });
  });

  it('shows a second copy that reaches the end of the reply', () => {
    const text = `${SENTENCE} ${SENTENCE}`;
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('releases a long unit in pieces, so long text does not wait', () => {
    const text = 'x'.repeat(1000);
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('passes a numbered list with the same item text through uncut', () => {
    const list = Array.from({ length: 4 }, () => '1. Check the build output for any errors today.\n').join('');
    expect(run([list])).toEqual({ shown: list, stopped: false });
  });

  it('passes a bulleted list of one-word items through uncut', () => {
    const list = '- Yes\n'.repeat(5);
    expect(run([list])).toEqual({ shown: list, stopped: false });
  });

  it('passes a code block with repeated lines through uncut, streamed by character', () => {
    const block = '```bash\n' + 'echo this line is repeated in the script.\n'.repeat(4) + '```\n';
    expect(run(block.split(''))).toEqual({ shown: block, stopped: false });
  });

  it('passes a table with repeated rows through uncut', () => {
    const table = '| Task | Status |\n|---|---|\n' + '| Check the build output again | Pass |\n'.repeat(4);
    expect(run([table])).toEqual({ shown: table, stopped: false });
  });

  it('does not count a line that is only inline code', () => {
    const text = '`npm test -- --watch in the package folder`.\n'.repeat(4);
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('stops before the second copy of a long sentence, keeping only the first', () => {
    const result = run(['Here is the result.\n', `${LONG_SENTENCE}\n`, `${LONG_SENTENCE}\n`, 'Anything else?\n']);
    expect(result).toEqual({ shown: `Here is the result.\n${LONG_SENTENCE}\n`, stopped: true });
  });

  it('holds a second copy of a long sentence that arrives in small pieces, then stops it', () => {
    const text = `Result follows.\n${LONG_SENTENCE}\n${LONG_SENTENCE}\n`;
    expect(run(text.split(''))).toEqual({ shown: `Result follows.\n${LONG_SENTENCE}\n`, stopped: true });
  });

  it('stops a paragraph of long sentences before its second copy', () => {
    const paragraph =
      `${LONG_SENTENCE} ` + 'Saturday dinner moved to the garden table because the kitchen gets far too warm.\n';
    expect(run([paragraph, paragraph, paragraph])).toEqual({ shown: paragraph, stopped: true });
  });

  it('still shows a short sentence twice and stops only at the third copy', () => {
    const short = 'The train for Lisbon leaves at nine tonight.';
    expect(run([`${short} ${short} ${short}`])).toEqual({ shown: `${short} ${short}`, stopped: true });
  });

  it('treats a sentence of exactly twelve words as long, so its second copy stops the reply', () => {
    expect(run([`${TWELVE_WORDS}\n`, `${TWELVE_WORDS}\n`])).toEqual({
      shown: `${TWELVE_WORDS}\n`,
      stopped: true,
    });
  });

  it('treats a sentence of eleven words as short, so it stops only at the third copy', () => {
    const line = `${ELEVEN_WORDS}\n`;
    expect(run([line, line, line])).toEqual({ shown: line.repeat(2), stopped: true });
  });

  describe('a reply stuck signing off', () => {
    const ANSWER =
      'Your errands are on the calendar today from 11:00 to 12:00, with all four stops listed in the task.\n\n';
    const LOOP =
      "That's it. All set. Everything's neat. Ready when you are. Set. Ready. All set. Done. That's it. All set. Done. " +
      "Everything's neat. Ready when you are. Set. Ready. ✓\n\nDone. ✓\n\nFinal. ✓\n\nDone. ✓\n\nStop.\n";

    it('stops once several short sign-offs keep repeating, keeping the answer', () => {
      const result = run([ANSWER, LOOP]);
      expect(result.stopped).toBe(true);
      expect(result.shown.startsWith(ANSWER)).toBe(true);
      expect(result.shown).not.toContain('Final.');
      expect(result.shown.length).toBeLessThan(ANSWER.length + 200);
    });

    it('stops at the same point when the loop arrives one character at a time', () => {
      // Only the blank before the next sentence may differ, since it streams before that sentence is known.
      const byChar = run((ANSWER + LOOP).split(''));
      const whole = run([ANSWER, LOOP]);
      expect(byChar.stopped).toBe(true);
      expect(byChar.shown.trimEnd()).toBe(whole.shown.trimEnd());
    });

    it('never shows part of the short sentence it stops before', () => {
      const { shown } = run((ANSWER + LOOP).split(''));
      expect(shown.trimEnd()).toMatch(/[.✓]$/);
    });

    it('counts "Done.", "Done ✓" and "done!" as one sentence', () => {
      const loop = 'Done. All set! Ready. Done ✓.\nAll set. Ready! done! all set. Ready. Done. All set. Ready.\n';
      expect(run([loop]).stopped).toBe(true);
    });

    it('keeps one short line repeated under each day', () => {
      const days = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
      const text = days.map(day => `**${day}**\nFree.\n`).join('') + days.map(day => `${day}: Busy.\n`).join('');
      expect(run([text])).toEqual({ shown: text, stopped: false });
    });

    it('keeps bold labels repeated across the days of a plan', () => {
      const text = Array.from(
        { length: 5 },
        (_, day) =>
          `Day ${day + 1}\n**Morning**\nWalk on site ${day}.\n**Afternoon**\nLunch spot ${day}.\n**Evening**\nDinner ${day}.\n`,
      ).join('');
      expect(run([text])).toEqual({ shown: text, stopped: false });
    });
  });
});
