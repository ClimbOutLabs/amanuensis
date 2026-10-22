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
  return { shown: shown + guard.finish(), stopped: false };
}

const CLOSING = 'Done. ✅ All set for tomorrow.\n';

describe('RepeatedUnitGuard', () => {
  it('streams text that repeats nothing straight through, piece by piece', () => {
    const guard = new RepeatedUnitGuard();
    expect(guard.push('Hello ').text).toBe('Hello ');
    expect(guard.push('there, friend.').text).toBe('there, friend.');
    expect(guard.finish()).toBe('');
  });

  it('cuts a closing-line loop at its first copy and reports the stop', () => {
    const result = run(['Summary.\n', ...Array.from({ length: 6 }, () => CLOSING)]);
    expect(result).toEqual({ shown: `Summary.\n${CLOSING}`, stopped: true });
  });

  it('cuts the same loop when the text arrives one character at a time', () => {
    const text = `Summary.\n${CLOSING.repeat(6)}`;
    const result = run(text.split(''));
    expect(result).toEqual({ shown: `Summary.\n${CLOSING}`, stopped: true });
  });

  it('cuts a loop of a two-line block at its first copy', () => {
    const block = 'Done. ✅ All set for tomorrow.\nSee you then.\n';
    const result = run([block.repeat(5)]);
    expect(result.stopped).toBe(true);
    expect(result.shown).toBe(block);
  });

  it('keeps a sentence that repeats twice and then goes on, exactly as written', () => {
    const text =
      'Let me know if you need anything else. Plan A is set. Let me know if you need anything else. Plan B is next.';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('keeps a few short lines in a row untouched', () => {
    const text = 'Yes.\nYes.\nYes.\nFine.\n';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('shows a held repeat when the run breaks, so nothing is lost', () => {
    const text = 'Let me know if you need anything else.\nLet me know if you need anything else.\nNext, the review.\n';
    expect(run(text.split(''))).toEqual({ shown: text, stopped: false });
  });

  it('shows a repeat that reaches the end of the reply with the rest of the reply', () => {
    const text = 'Let me know if you need anything else. Let me know if you need anything else.';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('releases a sentence that never ends, so long text does not wait', () => {
    const text = 'x'.repeat(1000);
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });
});
