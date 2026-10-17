/**
 * Per-instance Token Factory token counters (not tenant-scoped), keyed by UTC calendar day
 * (`usage_date`, `YYYY-MM-DD`). A new day starts new rows, so the budget resets without any
 * cleanup job. The day row is the cap counter; the per-model rows say where those tokens went.
 */

export interface TokenFactoryUsageRecord {
  usage_date: string;
  /** Input plus output tokens counted for the day, across all models. */
  used_tokens: number;
  /** ISO-8601 UTC instant. */
  updated_at: string;
}

export interface TokenFactoryModelUsageRecord {
  usage_date: string;
  /** Upstream model id the provider was called with. */
  model_id: string;
  input_tokens: number;
  output_tokens: number;
  /** Model calls that reported usage and were counted. */
  calls: number;
}

export interface GetTokenFactoryUsageInput {
  usage_date: string;
}

export interface AddTokenFactoryUsageInput {
  usage_date: string;
  model_id: string;
  /** Added atomically with the day total so concurrent turns never lose counts. */
  input_tokens: number;
  output_tokens: number;
}

export interface ITokenFactoryUsageStore<TTransaction = never> {
  /** The day's row, or undefined when nothing has been counted for it yet. */
  getUsage(input: GetTokenFactoryUsageInput, transaction?: TTransaction): Promise<TokenFactoryUsageRecord | undefined>;
  /** Adds one call's tokens to the day row and the model's row, creating either on first use. */
  addUsage(input: AddTokenFactoryUsageInput, transaction?: TTransaction): Promise<TokenFactoryUsageRecord>;
  /** The day's per-model rows, most tokens first; empty when nothing has been counted. */
  listModelUsage(input: GetTokenFactoryUsageInput, transaction?: TTransaction): Promise<TokenFactoryModelUsageRecord[]>;
}
