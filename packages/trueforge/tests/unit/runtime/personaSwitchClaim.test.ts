import { EventType, ModelMessageEventSchema, type ModelMessageEvent } from '@truefoundry/trueforge-core/core';
import {
  guardSwitchClaim,
  PersonaSwitchLog,
  switchTextForContext,
  UNSWITCHED_REPLY,
} from '../../../src/runtime/personaSwitchClaim';

function output(content: string | { type: 'text'; text: string }[]): ModelMessageEvent {
  return ModelMessageEventSchema.parse({
    type: EventType.MODEL_MESSAGE,
    id: 'evt-1',
    thread_id: 'main',
    created_at: '2026-10-29T00:00:00.000Z',
    content,
  });
}

const CLAIM = 'Using your existing Theo. Now talking with Theo.';

describe('guardSwitchClaim', () => {
  it('replaces a claimed switch when no switch ran', () => {
    const guarded = guardSwitchClaim({ output: output(CLAIM), log: new PersonaSwitchLog() });
    expect(guarded?.content).toBe(UNSWITCHED_REPLY);
  });

  it('replaces the claiming text part and keeps the others', () => {
    const guarded = guardSwitchClaim({
      output: output([
        { type: 'text', text: 'Sure thing.' },
        { type: 'text', text: CLAIM },
      ]),
      log: new PersonaSwitchLog(),
    });
    expect(guarded?.content).toEqual([
      { type: 'text', text: 'Sure thing.' },
      { type: 'text', text: UNSWITCHED_REPLY },
    ]);
  });

  it('leaves the reply alone when a switch ran', () => {
    const log = new PersonaSwitchLog();
    log.markSwitched();
    expect(guardSwitchClaim({ output: output(CLAIM), log })).toBeUndefined();
  });

  it('leaves ordinary replies alone', () => {
    expect(
      guardSwitchClaim({ output: output('Happy to help with that.'), log: new PersonaSwitchLog() }),
    ).toBeUndefined();
    expect(
      guardSwitchClaim({ output: output('We are now talking about June.'), log: new PersonaSwitchLog() }),
    ).toBeUndefined();
  });
});

describe('switchTextForContext', () => {
  it('stores a real switch as a host note, not as assistant prose to copy', () => {
    const log = new PersonaSwitchLog();
    log.markSwitched();
    const stored = switchTextForContext({ text: CLAIM, log });
    expect(stored).not.toContain('Now talking with');
    expect(stored).not.toContain('Using your existing');
    expect(stored).toContain('The persona tool switched this chat to Theo.');
  });

  it('stores an unbacked claim as the plain refusal', () => {
    expect(switchTextForContext({ text: CLAIM, log: new PersonaSwitchLog() })).toBe(UNSWITCHED_REPLY);
  });

  it('leaves other text alone', () => {
    expect(switchTextForContext({ text: 'Hello', log: new PersonaSwitchLog() })).toBe('Hello');
  });
});
