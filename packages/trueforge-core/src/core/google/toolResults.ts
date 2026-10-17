/** What every Google tool set hands back to the model, so Gmail and Calendar answer and fail the same way. */
import { neutralizeDeep } from '../email/gmail/results';
import { toolResultResponse } from '../mcp/IMCPServer';
import { GoogleApiError, GoogleOAuthError, GoogleReconnectRequiredError } from './errors';

export function errorResult(error: string) {
  return toolResultResponse({ text: JSON.stringify({ error }), isError: true });
}

/** Every success result is third-party text, so every string in it is neutralized on the way out. */
export function jsonResult(value: unknown, overrides?: Parameters<typeof toolResultResponse>[0]['overrides']) {
  return toolResultResponse({ text: JSON.stringify(neutralizeDeep(value)), overrides });
}

/** A failure the model can act on, in words that never carry mail or event text or a credential. */
export function failureResult(error: unknown) {
  if (
    error instanceof GoogleReconnectRequiredError ||
    error instanceof GoogleApiError ||
    error instanceof GoogleOAuthError
  ) {
    return errorResult(error.message);
  }
  throw error;
}
