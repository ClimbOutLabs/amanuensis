import { resolveUsagePeriod, summarizeUsage, type UsageEntry } from '../../../src/runtime/usageSummary';

// Wednesday 2026-10-21 02:00 UTC is still Tuesday 2026-10-20 19:00 in Los Angeles (PDT).
const NOW = new Date('2026-10-21T02:00:00Z');
const LOS_ANGELES = 'America/Los_Angeles';

function entry(overrides: Partial<UsageEntry> & Pick<UsageEntry, 'created_at'>): UsageEntry {
  return {
    session_id: 'session-a',
    title: 'Trip plan',
    model_id: 'nvidia/Nemotron-3-Nano-30B-A3B',
    display_name: 'Nemotron 3 Nano',
    input_tokens: 0,
    output_tokens: 0,
    cost_usd: null,
    ...overrides,
  };
}

describe('resolveUsagePeriod', () => {
  it('starts today at local midnight in the client zone', () => {
    const period = resolveUsagePeriod({ input: { period: 'today' }, now: NOW, timeZone: LOS_ANGELES });
    expect(period).toEqual({
      fromDate: '2026-10-20',
      toDate: '2026-10-20',
      from: new Date('2026-10-20T07:00:00Z'),
      to: new Date('2026-10-21T07:00:00Z'),
      timeZone: LOS_ANGELES,
    });
  });

  it('starts this week on Monday, local time', () => {
    const period = resolveUsagePeriod({ input: { period: 'this_week' }, now: NOW, timeZone: LOS_ANGELES });
    expect(period.fromDate).toBe('2026-10-19');
    expect(period.from).toEqual(new Date('2026-10-19T07:00:00Z'));
    expect(period.toDate).toBe('2026-10-20');
  });

  it('starts this month on the first, local time', () => {
    const period = resolveUsagePeriod({ input: { period: 'this_month' }, now: NOW, timeZone: LOS_ANGELES });
    expect(period.fromDate).toBe('2026-10-01');
    expect(period.from).toEqual(new Date('2026-10-01T07:00:00Z'));
  });

  it('reads a date range inclusively in the client zone', () => {
    const period = resolveUsagePeriod({
      input: { period: 'date_range', start_date: '2026-09-01', end_date: '2026-09-30' },
      now: NOW,
      timeZone: LOS_ANGELES,
    });
    expect(period.from).toEqual(new Date('2026-09-01T07:00:00Z'));
    expect(period.to).toEqual(new Date('2026-10-01T07:00:00Z'));
  });

  it('falls back to UTC when no zone is known', () => {
    const period = resolveUsagePeriod({ input: { period: 'today' }, now: NOW, timeZone: undefined });
    expect(period).toMatchObject({ fromDate: '2026-10-21', timeZone: 'UTC' });
    expect(period.from).toEqual(new Date('2026-10-21T00:00:00Z'));
  });
});

describe('summarizeUsage', () => {
  const period = {
    fromDate: '2026-10-01',
    toDate: '2026-10-21',
    from: new Date('2026-10-01T00:00:00Z'),
    to: new Date('2026-10-22T00:00:00Z'),
    timeZone: 'UTC',
  };

  const priced = entry({
    session_id: 'session-a',
    title: 'Trip plan',
    model_id: 'nvidia/nemotron-3-super-120b-a12b',
    display_name: 'Nemotron 3 Super',
    input_tokens: 1000,
    output_tokens: 500,
    cost_usd: 0.002,
    created_at: '2026-10-10T10:00:00Z',
  });
  const pricedAgain = entry({
    session_id: 'session-a',
    title: 'Trip plan',
    model_id: 'nvidia/nemotron-3-super-120b-a12b',
    display_name: 'Nemotron 3 Super',
    input_tokens: 2000,
    output_tokens: 0,
    cost_usd: 0.004,
    created_at: '2026-10-11T10:00:00Z',
  });
  const unpriced = entry({
    session_id: 'session-b',
    title: null,
    model_id: 'acme/private-model',
    display_name: 'private-model',
    input_tokens: 300,
    output_tokens: 100,
    cost_usd: null,
    created_at: '2026-10-10T12:00:00Z',
  });

  it('totals tokens and sums the known cost, counting unpriced tokens apart', () => {
    const summary = summarizeUsage({ entries: [priced, pricedAgain, unpriced], period, cap: undefined });
    expect(summary.total).toEqual({
      input_tokens: 3300,
      output_tokens: 600,
      total_tokens: 3900,
      cost_usd: 0.006,
      unpriced_tokens: 400,
    });
  });

  it('splits by model, most tokens first, with cost null where no price is known', () => {
    const summary = summarizeUsage({ entries: [unpriced, priced, pricedAgain], period, cap: undefined });
    expect(summary.by_model.map(model => model.model_id)).toEqual([
      'nvidia/nemotron-3-super-120b-a12b',
      'acme/private-model',
    ]);
    expect(summary.by_model[0]).toMatchObject({ total_tokens: 3500, cost_usd: 0.006, unpriced_tokens: 0 });
    expect(summary.by_model[1]).toMatchObject({ total_tokens: 400, cost_usd: null, unpriced_tokens: 400 });
  });

  it('splits by day in ascending order', () => {
    const summary = summarizeUsage({ entries: [pricedAgain, unpriced, priced], period, cap: undefined });
    expect(summary.by_day).toEqual([
      { date: '2026-10-10', total_tokens: 1900, cost_usd: 0.002, unpriced_tokens: 400 },
      { date: '2026-10-11', total_tokens: 2000, cost_usd: 0.004, unpriced_tokens: 0 },
    ]);
  });

  it('lists the most expensive chats by title, untitled ones named, at most five', () => {
    const others = Array.from({ length: 5 }, (_, index) =>
      entry({
        session_id: `session-extra-${String(index)}`,
        title: `Chat ${String(index)}`,
        input_tokens: 10,
        output_tokens: 0,
        cost_usd: 0.0001 * (index + 1),
        created_at: '2026-10-12T09:00:00Z',
      }),
    );
    const summary = summarizeUsage({ entries: [unpriced, priced, pricedAgain, ...others], period, cap: undefined });
    expect(summary.top_chats).toHaveLength(5);
    expect(summary.top_chats[0]).toEqual({
      title: 'Trip plan',
      total_tokens: 3500,
      cost_usd: 0.006,
      unpriced_tokens: 0,
    });
    expect(summary.top_chats.map(chat => chat.title)).not.toContain('Untitled chat');
  });

  it('names an untitled chat when it is listed', () => {
    const summary = summarizeUsage({ entries: [unpriced], period, cap: undefined });
    expect(summary.top_chats).toEqual([
      { title: 'Untitled chat', total_tokens: 400, cost_usd: null, unpriced_tokens: 400 },
    ]);
  });

  it('reports zero cost, not an unknown price, when nothing was used', () => {
    const summary = summarizeUsage({ entries: [], period, cap: undefined });
    expect(summary.total).toEqual({
      input_tokens: 0,
      output_tokens: 0,
      total_tokens: 0,
      cost_usd: 0,
      unpriced_tokens: 0,
    });
    expect(summary.by_model).toEqual([]);
    expect(summary.by_day).toEqual([]);
    expect(summary.top_chats).toEqual([]);
  });

  it('shows what is left under the daily cap, never below zero', () => {
    const left = summarizeUsage({
      entries: [priced],
      period,
      cap: { capTokens: 10_000, usedTokens: 9_000 },
    });
    expect(left.daily_cap).toEqual({ cap_tokens: 10_000, remaining_tokens: 1_000, scope: 'instance' });

    const over = summarizeUsage({ entries: [priced], period, cap: { capTokens: 10_000, usedTokens: 12_000 } });
    expect(over.daily_cap?.remaining_tokens).toBe(0);
  });

  it('reports no daily cap when none is set', () => {
    expect(summarizeUsage({ entries: [priced], period, cap: undefined }).daily_cap).toBeNull();
  });
});
