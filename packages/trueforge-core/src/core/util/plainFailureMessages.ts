import { ProviderRequestError } from '../errors';
import { describeUnknownError } from './errorLogFields';

export const CHAT_TOO_LONG_MESSAGE =
  'This chat is too long for the model. Start a new chat, or pick a model with a longer memory in Settings.';

export const CONTEXT_OVER_LIMIT_MESSAGE =
  "This chat no longer fits in the model's memory. Start a new chat, or pick a model with a longer memory in Settings.";

export const MODEL_STREAM_BROKE_MESSAGE =
  'The model stopped answering partway through, twice in a row. Start a new chat, or pick a different model in Settings.';

function plainProviderFailureMessage(statusCode: number | undefined): string {
  if (statusCode === 401 || statusCode === 403) {
    return "The model's provider did not accept the request. Check this model's API key in Settings, then try again.";
  }
  if (statusCode === 429) {
    return "The model's provider is busy right now. Wait a moment, then send again.";
  }
  return "The model's provider could not answer. Try again in a moment, or pick another model in Settings.";
}

/** The text a failed turn shows in the chat; provider details stay in the log. */
export function describeTurnFailure(error: unknown): string {
  if (error instanceof ProviderRequestError) {
    return plainProviderFailureMessage(error.statusCode);
  }
  return describeUnknownError(error);
}
