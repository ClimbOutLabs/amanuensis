import { APICallError } from 'ai';

import { ProviderRequestError } from '../../../src/core/errors';
import {
  describeTurnFailure,
  PROVIDER_BUSY_MESSAGE,
  PROVIDER_FAILED_MESSAGE,
  PROVIDER_KEY_REFUSED_MESSAGE,
} from '../../../src/core/llm/plainFailureMessages';

const RAW = 'Request failed (500) at llm.internal.example: account acct-7 over quota';

describe('describeTurnFailure', () => {
  it.each([
    [401, PROVIDER_KEY_REFUSED_MESSAGE],
    [403, PROVIDER_KEY_REFUSED_MESSAGE],
    [429, PROVIDER_BUSY_MESSAGE],
    [500, PROVIDER_FAILED_MESSAGE],
    [404, PROVIDER_FAILED_MESSAGE],
  ])('keeps the model service text out of the chat for status %s', (statusCode, expected) => {
    expect(describeTurnFailure(new ProviderRequestError(RAW, { statusCode }))).toBe(expected);
  });

  it('reads the status from the error the failure was caused by', () => {
    const raw = new APICallError({
      message: RAW,
      url: 'https://llm.internal.example/v1/chat/completions',
      requestBodyValues: {},
      statusCode: 429,
    });
    const wrapped = new Error(RAW, { cause: raw });
    expect(describeTurnFailure(raw)).toBe(PROVIDER_BUSY_MESSAGE);
    expect(describeTurnFailure(wrapped)).toBe(PROVIDER_BUSY_MESSAGE);
  });

  it('keeps the message of an error that did not come from the model service', () => {
    expect(describeTurnFailure(new Error('Model "x" was not found.'))).toBe('Model "x" was not found.');
  });
});
