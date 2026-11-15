/**
 * The words a failed turn shows in the chat. A model service's own error text can name hosts, accounts or keys,
 * and it means little to the person, so it goes to the log only and the chat gets one plain message for each kind
 * of failure.
 */
import { ProviderRequestError } from '../errors';
import { describeUnknownError } from '../util/errorLogFields';
import { providerStatusCode } from './VercelAILLM';

export const PROVIDER_KEY_REFUSED_MESSAGE =
  "The model service did not accept this model's key. Check the key in Settings under Models, then send your message again.";
export const PROVIDER_BUSY_MESSAGE =
  'The model service is busy right now. Wait a minute, then send your message again.';
export const PROVIDER_FAILED_MESSAGE =
  'The model service could not answer. Try again, or use a different model if it keeps happening.';

/** The status the model service answered with, from the error or anything it was caused by. */
function serviceStatusCode(error: unknown): number | undefined {
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    if (current instanceof ProviderRequestError) {
      return current.statusCode;
    }
    const status = providerStatusCode(current);
    if (status !== undefined) {
      return status;
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return undefined;
}

/** The text a failed turn shows in the chat; a model service's own words stay in the log. */
export function describeTurnFailure(error: unknown): string {
  const status = serviceStatusCode(error);
  if (status === undefined) {
    return describeUnknownError(error);
  }
  if (status === 401 || status === 403) {
    return PROVIDER_KEY_REFUSED_MESSAGE;
  }
  if (status === 429) {
    return PROVIDER_BUSY_MESSAGE;
  }
  return PROVIDER_FAILED_MESSAGE;
}
