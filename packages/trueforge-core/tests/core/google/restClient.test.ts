import { z } from 'zod';

import { GoogleAccessTokens } from '../../../src/core/google/GoogleAccessTokens';
import { GoogleApiError, GoogleUnusableReplyError, isBusyFailure } from '../../../src/core/google/errors';
import { GoogleRestClient } from '../../../src/core/google/restClient';
import { connectedRecord, FakeConnections, OWNER } from './fakes';

async function failing({ status, reason }: { status: number; reason: string }): Promise<unknown> {
  const connections = new FakeConnections();
  await connections.save(connectedRecord());
  const fetchImpl: typeof fetch = input => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = url.endsWith('/token')
      ? { access_token: 'at', expires_in: 3600 }
      : { error: { code: status, message: 'Failed.', errors: [{ message: 'Failed.', reason }] } };
    return Promise.resolve(Response.json(body, { status: url.endsWith('/token') ? 200 : status }));
  };
  const client = new GoogleRestClient({
    product: {
      name: 'Gmail',
      baseUrl: 'https://gmail.test',
      apiOffMessage: 'off',
      scopeMessage: 'scope',
      notFoundMessage: 'none',
      tooLargeMessage: 'large',
    },
    tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl }),
    fetchImpl,
    sleep: () => Promise.resolve(),
  });
  return await client
    .parsed(z.unknown(), { method: 'GET', path: '/x', query: undefined, body: undefined })
    .catch((error: unknown) => error);
}

describe('which Google failures say it is busy', () => {
  it.each(['userRateLimitExceeded', 'rateLimitExceeded', 'backendError'])(
    'marks a 403 for %s as busy',
    async reason => {
      const error = await failing({ status: 403, reason });
      expect(error).toBeInstanceOf(GoogleApiError);
      expect(error instanceof GoogleApiError && error.busy).toBe(true);
    },
  );

  it.each([429, 500, 503])('marks a %s as busy', async status => {
    const error = await failing({ status, reason: '' });
    expect(error instanceof GoogleApiError && error.busy).toBe(true);
  });

  it.each([
    [403, 'insufficientPermissions'],
    [400, ''],
    [404, 'notFound'],
  ])('does not mark a %s for %s as busy', async (status, reason) => {
    const error = await failing({ status, reason });
    expect(error instanceof GoogleApiError && error.busy).toBe(false);
  });

  it('never calls a reply Aman cannot read busy, though its status is 502', () => {
    expect(new GoogleUnusableReplyError({ message: 'Too large.' }).busy).toBe(false);
  });

  it('decides in one place, from the status and the reason', () => {
    expect(isBusyFailure({ status: 403, reason: 'rateLimitExceeded' })).toBe(true);
    expect(isBusyFailure({ status: 403, reason: 'forbidden' })).toBe(false);
    expect(isBusyFailure({ status: 502, reason: '' })).toBe(true);
  });
});
