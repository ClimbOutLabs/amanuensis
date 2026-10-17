import { ProviderRequestError } from '../../../src/core/errors';
import { describeTurnFailure } from '../../../src/core/util/plainFailureMessages';

describe('describeTurnFailure', () => {
  it.each([
    [401, "The model's provider did not accept the request. Check this model's API key in Settings, then try again."],
    [403, "The model's provider did not accept the request. Check this model's API key in Settings, then try again."],
    [429, "The model's provider is busy right now. Wait a moment, then send again."],
    [500, "The model's provider could not answer. Try again in a moment, or pick another model in Settings."],
    [undefined, "The model's provider could not answer. Try again in a moment, or pick another model in Settings."],
  ])('hides raw provider details for status %s', (statusCode, expected) => {
    const raw = new ProviderRequestError('Request failed (500): host secret.internal key sk-123', { statusCode });
    expect(describeTurnFailure(raw)).toBe(expected);
  });

  it('keeps the message of any other error', () => {
    expect(describeTurnFailure(new Error('Model "x" was not found.'))).toBe('Model "x" was not found.');
  });
});
