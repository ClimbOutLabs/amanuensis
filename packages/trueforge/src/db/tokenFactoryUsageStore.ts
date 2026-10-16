/**
 * Per-instance Token Factory token counter, one row per UTC day (not tenant-scoped).
 * `usage_date` is the UTC calendar day as `YYYY-MM-DD`; a new day starts a new row, so the
 * budget resets without any cleanup job.
 */

export interface TokenFactoryUsageRecord {
  usage_date: string;
  used_tokens: number;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

export interface GetTokenFactoryUsageInput {
  usage_date: string;
}

export interface AddTokenFactoryUsageInput {
  usage_date: string;
  /** Tokens to add; the increment is atomic so concurrent turns never lose counts. */
  tokens: number;
}

export interface ITokenFactoryUsageStore<TTransaction = never> {
  /** The day's row, or undefined when nothing has been counted for it yet. */
  getUsage(input: GetTokenFactoryUsageInput, transaction?: TTransaction): Promise<TokenFactoryUsageRecord | undefined>;
  /** Adds tokens to the day's row, creating it on first use; returns the stored row. */
  addUsage(input: AddTokenFactoryUsageInput, transaction?: TTransaction): Promise<TokenFactoryUsageRecord>;
}
