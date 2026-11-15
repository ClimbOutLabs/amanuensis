import { applyReachRules, joinReasons, type ReachHistory } from '../../../../src/runtime/noticing/reachRules';
import { defaultReachSettings, type ReachSettings } from '../../../../src/schemas/reach';

// 15:00 UTC is 11:00 in New York, outside the default quiet hours.
const DAYTIME = new Date('2026-11-05T15:00:00.000Z');
// 03:00 UTC is 22:00 the evening before in New York, inside quiet hours.
const NIGHT = new Date('2026-11-05T03:00:00.000Z');
const FRESH: ReachHistory = { nudges_today: 0, last_call_at: undefined };

function settings(overrides: Partial<ReachSettings> = {}): ReachSettings {
  return {
    ...defaultReachSettings('America/New_York'),
    channels: { texts: false, calls: true },
    call_kinds: ['mail_always', 'calendar_clash', 'travel'],
    ...overrides,
  };
}

function ask(input: {
  settings?: ReachSettings;
  history?: ReachHistory;
  now?: Date;
  kind?: 'mail_always' | 'bill_due' | 'calendar_clash' | 'approval_waiting';
  evidence?: 'own' | 'verified_sender' | 'content';
  callsAvailable?: boolean;
}) {
  return applyReachRules({
    subject: { kind: input.kind ?? 'calendar_clash', evidence: input.evidence ?? 'own' },
    asked: 'call',
    settings: input.settings ?? settings(),
    history: input.history ?? FRESH,
    now: input.now ?? DAYTIME,
    calls_available: input.callsAvailable ?? true,
  });
}

describe('applyReachRules lowers a model answer of call', () => {
  it('keeps a call when every rule allows it', () => {
    expect(ask({})).toEqual({ decided: 'call', delivered: 'call', steps: [] });
  });

  it('lowers it when the kind is not ticked for calls', () => {
    const result = ask({ settings: settings({ call_kinds: ['travel'] }) });
    expect(result.decided).toBe('nudge');
    expect(result.steps).toEqual(['You have not allowed calls for this kind of event.']);
  });

  it('lowers it when nothing is ticked, which is the default', () => {
    const result = ask({ settings: settings({ call_kinds: [] }) });
    expect(result.delivered).toBe('nudge');
  });

  it('lowers it when the calls channel is off', () => {
    const result = ask({ settings: settings({ channels: { texts: false, calls: false } }) });
    expect(result.delivered).toBe('nudge');
    expect(result.steps).toEqual(['Calls are switched off in Reach me.']);
  });

  it('lowers it during quiet hours', () => {
    const result = ask({ now: NIGHT });
    expect(result.delivered).toBe('nudge');
    expect(result.steps).toEqual(['It is during your quiet hours, so no call.']);
  });

  it('lowers it when a call was decided inside the minimum gap, and allows one after it', () => {
    const recent = new Date(DAYTIME.getTime() - 5 * 3_600_000);
    expect(ask({ history: { nudges_today: 0, last_call_at: recent } }).delivered).toBe('nudge');
    const older = new Date(DAYTIME.getTime() - 7 * 3_600_000);
    expect(ask({ history: { nudges_today: 0, last_call_at: older } }).delivered).toBe('call');
  });

  it('lowers a bill and a waiting approval to a nudge even when ticked', () => {
    const ticked = settings({ call_kinds: ['bill_due', 'approval_waiting'] });
    expect(ask({ kind: 'bill_due', settings: ticked }).decided).toBe('nudge');
    expect(ask({ kind: 'approval_waiting', settings: ticked }).decided).toBe('nudge');
  });

  it('lowers anything resting only on message content to a note', () => {
    const result = ask({ kind: 'bill_due', evidence: 'content' });
    expect(result.delivered).toBe('note');
    expect(result.steps.join(' ')).toContain('stays a note');
  });

  it('keeps a decided call but delivers a nudge while no phone channel is set up', () => {
    const result = ask({ callsAvailable: false });
    expect(result.decided).toBe('call');
    expect(result.delivered).toBe('nudge');
    expect(result.steps).toEqual(['Phone calls are not set up yet, so it came as a nudge.']);
  });

  it('turns a nudge into a note past the daily limit', () => {
    const result = ask({
      settings: settings({ call_kinds: [], max_nudges_per_day: 2 }),
      history: { nudges_today: 2, last_call_at: undefined },
    });
    expect(result.delivered).toBe('note');
    expect(result.steps.at(-1)).toContain('your limit');
  });
});

describe('applyReachRules for reminders', () => {
  const reminder = (urgent: boolean, overrides: Partial<ReachSettings> = {}, asked: 'nudge' | 'call' = 'call') =>
    applyReachRules({
      subject: { kind: 'reminder', urgent },
      asked,
      settings: settings(overrides),
      history: { nudges_today: 99, last_call_at: undefined },
      now: DAYTIME,
      calls_available: true,
    });

  it('is never quieter than a nudge, whatever the daily limit', () => {
    expect(reminder(false, {}, 'nudge').delivered).toBe('nudge');
  });

  it('calls only when marked urgent and the tick is on', () => {
    expect(reminder(true, { call_for_urgent_reminders: true }).delivered).toBe('call');
    expect(reminder(true, { call_for_urgent_reminders: false }).delivered).toBe('nudge');
    expect(reminder(false, { call_for_urgent_reminders: true }).delivered).toBe('nudge');
  });

  it('still obeys quiet hours and the calls switch', () => {
    expect(
      reminder(true, { call_for_urgent_reminders: true, channels: { texts: false, calls: false } }).delivered,
    ).toBe('nudge');
  });
});

describe('joinReasons', () => {
  it('joins sentences and drops blanks', () => {
    expect(joinReasons(['One.', ' ', 'Two.'])).toBe('One. Two.');
  });

  it('cuts to what a delivery holds', () => {
    expect(joinReasons(['x'.repeat(900)]).length).toBe(500);
  });
});
