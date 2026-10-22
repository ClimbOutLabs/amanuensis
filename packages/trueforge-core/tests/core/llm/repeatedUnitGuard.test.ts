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

const CLOSING = 'Done. ✅ All set for tomorrow.\n';

describe('RepeatedUnitGuard', () => {
  it('streams text that repeats nothing straight through, piece by piece', () => {
    const guard = new RepeatedUnitGuard();
    expect(guard.push('Hello ').text).toBe('Hello ');
    expect(guard.push('there, friend.').text).toBe('there, friend.');
    expect(guard.finish()).toEqual({ text: '', stopped: false });
  });

  it('stops before the third copy of a closing sentence, keeping the first two', () => {
    const result = run(['Summary.\n', ...Array.from({ length: 6 }, () => CLOSING)]);
    expect(result).toEqual({ shown: `Summary.\n${CLOSING.repeat(2)}`, stopped: true });
  });

  it('stops at the same point when the text arrives one character at a time', () => {
    const text = `Summary.\n${CLOSING.repeat(6)}`;
    expect(run(text.split(''))).toEqual({ shown: `Summary.\n${CLOSING.repeat(2)}`, stopped: true });
  });

  it('stops a two-line block before its third copy', () => {
    const block = 'Done. ✅ All set for tomorrow.\nSee you then.\n';
    expect(run([block.repeat(5)])).toEqual({ shown: block.repeat(2), stopped: true });
  });

  it('counts a repeat across the whole reply, not only back to back', () => {
    expect(run(['Ok. Plan. Ok. Plan. Ok. Next.'])).toEqual({ shown: 'Ok. Plan. Ok. Plan.', stopped: true });
  });

  it('stops on a third copy that ends the reply', () => {
    expect(run(['Ok. Plan. Ok. Plan. Ok.'])).toEqual({ shown: 'Ok. Plan. Ok. Plan.', stopped: true });
  });

  it('keeps a sentence that repeats twice and then goes on, exactly as written', () => {
    const text =
      'Let me know if you need anything else. Plan A is set. Let me know if you need anything else. Plan B is next.';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('does not count rules or fences, which are markup rather than sentences', () => {
    const text = '---\n---\n---\nDone.\n';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('stops a third identical short line, since it is a third identical sentence', () => {
    expect(run(['Yes.\nYes.\nYes.\nFine.\n'])).toEqual({ shown: 'Yes.\nYes.\n', stopped: true });
  });

  it('shows a repeat that breaks off before a third copy, so nothing is lost', () => {
    const text = 'Let me know if you need anything else.\nLet me know if you need anything else.\nNext, the review.\n';
    expect(run(text.split(''))).toEqual({ shown: text, stopped: false });
  });

  it('shows a second copy that reaches the end of the reply', () => {
    const text = 'Let me know if you need anything else. Let me know if you need anything else.';
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });

  it('releases a long unit in pieces, so long text does not wait', () => {
    const text = 'x'.repeat(1000);
    expect(run([text])).toEqual({ shown: text, stopped: false });
  });
});
