import { describe, expect, it } from 'vitest';

import {
  describeHelperCalls,
  describeTokenSplit,
  formatCostUsd,
  formatTokens,
  providerLabel,
  summarizeModelUsage,
} from '@/utils/modelUsage.js';
import { NANO_COMPACTION_EVENT, NANO_SUMMARY_EVENT, SUPER_EVENT } from '../fixtures/modelUsageEvents.js';

describe('formatting', () => {
  it('groups digits and keeps four decimals under a dollar', () => {
    expect(formatTokens(2140)).toBe('2,140');
    expect(formatCostUsd(0.0011)).toBe('$0.0011');
    expect(formatCostUsd(0)).toBe('$0.0000');
    expect(formatCostUsd(0.00001)).toBe('<$0.0001');
    expect(formatCostUsd(12.3456)).toBe('$12.35');
    expect(describeTokenSplit({ inputTokens: 1800, outputTokens: 340 })).toBe('1,800 in, 340 out');
  });

  it('names the known providers and passes others through', () => {
    expect(providerLabel('tokenfactory')).toBe('Token Factory');
    expect(providerLabel('custom')).toBe('Custom provider');
    expect(providerLabel('somethingnew')).toBe('somethingnew');
  });
});

describe('summarizeModelUsage', () => {
  it('is undefined when the turn recorded nothing', () => {
    expect(summarizeModelUsage(undefined)).toBeUndefined();
    expect(summarizeModelUsage([])).toBeUndefined();
  });

  it('totals the answer and its helper calls, with the answer model first', () => {
    const summary = summarizeModelUsage([NANO_SUMMARY_EVENT, SUPER_EVENT, NANO_COMPACTION_EVENT]);

    expect(summary?.answer).toEqual({ displayName: 'Nemotron 3 Super', providerLabel: 'Token Factory' });
    expect(summary?.inputTokens).toBe(1800 + 500 + 4000);
    expect(summary?.outputTokens).toBe(340 + 50 + 300);
    expect(summary?.costUsd).toBeCloseTo(0.000846 + 0.000042 + 0.000312, 12);
    expect(summary?.rows.map(row => [row.roleLabel, row.displayName])).toEqual([
      ['Answer', 'Nemotron 3 Super'],
      ['Memory summary', 'Nemotron 3 Nano'],
      ['Compaction', 'Nemotron 3 Nano'],
    ]);
    expect(summary?.helperCalls).toBe(2);
    expect(summary?.helperModelNames).toEqual(['Nemotron 3 Nano']);
    expect(summary && describeHelperCalls(summary)).toBe('+ 2 helper calls on Nemotron 3 Nano');
    expect(summary?.noneReported).toBe(false);
    expect(summary?.unreportedCalls).toBe(0);
  });

  it('adds the events of one role and model recorded at different times', () => {
    const summary = summarizeModelUsage([
      SUPER_EVENT,
      { ...SUPER_EVENT, id: 'later', calls: 1, reportedCalls: 1, inputTokens: 100, outputTokens: 10, costUsd: 0.1 },
    ]);

    expect(summary?.rows).toHaveLength(1);
    expect(summary?.rows[0]).toMatchObject({ calls: 3, inputTokens: 1900, outputTokens: 350 });
  });

  it('reports no helper calls when only the answer ran', () => {
    const summary = summarizeModelUsage([SUPER_EVENT]);

    expect(summary?.helperCalls).toBe(0);
    expect(summary && describeHelperCalls(summary)).toBeUndefined();
  });

  it('says usage was not reported, with no tokens or cost, when the provider reported none', () => {
    const summary = summarizeModelUsage([
      { ...SUPER_EVENT, reportedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    ]);

    expect(summary).toMatchObject({ noneReported: true, costUsd: null, unreportedCalls: 2 });
  });

  it('leaves the total cost out when a reported call has no price, rather than showing a partial sum', () => {
    const summary = summarizeModelUsage([SUPER_EVENT, { ...NANO_SUMMARY_EVENT, costUsd: null }]);

    expect(summary?.costUsd).toBeNull();
    expect(summary?.inputTokens).toBe(2300);
  });

  it('counts calls without usage next to the ones that reported', () => {
    const summary = summarizeModelUsage([
      SUPER_EVENT,
      { ...NANO_SUMMARY_EVENT, reportedCalls: 0, inputTokens: 0, outputTokens: 0, costUsd: null },
    ]);

    expect(summary).toMatchObject({ noneReported: false, unreportedCalls: 1 });
    expect(summary?.costUsd).toBeCloseTo(0.000846, 12);
  });
});
