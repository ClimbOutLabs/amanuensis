import { apiErrorCode } from './apiErrorCode.js';

/** The server refuses a new Token Factory turn with 429 and this `error.code` once the day's budget is gone. */
const DAILY_CAP_CODE = 'token_factory_daily_cap_reached';

export const DAILY_BUDGET_TITLE = 'Demo budget used up';
export const DAILY_BUDGET_DESCRIPTION = "Today's demo budget is used up. It resets at midnight UTC.";

export function isTokenFactoryDailyCapError(error: unknown): boolean {
  const detail = apiErrorCode(error);
  return detail?.statusCode === 429 && detail.code === DAILY_CAP_CODE;
}
