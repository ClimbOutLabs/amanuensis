import { describe, expect, it } from 'vitest';

import {
  DAILY_BUDGET_DESCRIPTION,
  DAILY_BUDGET_TITLE,
  isTokenFactoryDailyCapError,
} from '@/utils/tokenFactoryBudget.js';

function refusal(code: string | null, statusCode = 429): Error {
  return Object.assign(new Error(`Status code: ${statusCode}`), {
    statusCode,
    body: { error: { message: 'Daily budget used up', type: 'rate_limit', code } },
  });
}

describe('isTokenFactoryDailyCapError', () => {
  it('matches the typed 429 the server sends once the daily budget is used up', () => {
    expect(isTokenFactoryDailyCapError(refusal('token_factory_daily_cap_reached'))).toBe(true);
  });

  it('does not match other rate limits, other statuses, or non-errors', () => {
    expect(isTokenFactoryDailyCapError(refusal('something_else'))).toBe(false);
    expect(isTokenFactoryDailyCapError(refusal(null))).toBe(false);
    expect(isTokenFactoryDailyCapError(refusal('token_factory_daily_cap_reached', 500))).toBe(false);
    expect(isTokenFactoryDailyCapError(new Error('boom'))).toBe(false);
    expect(isTokenFactoryDailyCapError(null)).toBe(false);
    expect(isTokenFactoryDailyCapError({ statusCode: 429 })).toBe(false);
  });
});

describe('daily budget copy', () => {
  it('is one plain line that says when it resets', () => {
    expect(DAILY_BUDGET_TITLE).toBe('Demo budget used up');
    expect(DAILY_BUDGET_DESCRIPTION).toBe("Today's demo budget is used up. It resets at midnight UTC.");
  });
});
