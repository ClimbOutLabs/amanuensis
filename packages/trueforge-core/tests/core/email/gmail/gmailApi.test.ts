import { GmailApi, mapSkippingMissing } from '../../../../src/core/email/gmail/gmailApi';
import { GoogleAccessTokens } from '../../../../src/core/google/GoogleAccessTokens';
import { connectedRecord, FakeConnections, OWNER } from '../../google/fakes';
import { message } from './fixtures';
import { build, gmailThreadResponse, googleError, INSUFFICIENT_SCOPE_BODY, json, route, text } from './harness';

function threadRows(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({ id: `t${String(index)}` }));
}

/** A thread answer per id; `fail` can replace the answer for one id. */
function threadAnswers(fail: (id: string, attempt: number) => Response | undefined) {
  const attempts = new Map<string, number>();
  return (url: URL): Response | undefined => {
    const id = /\/threads\/(t\d+)$/.exec(url.pathname)?.[1];
    if (id === undefined) {
      return undefined;
    }
    const attempt = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, attempt);
    return (
      fail(id, attempt) ??
      json(
        gmailThreadResponse({
          thread: { id, messages: [message({ id: `${id}-m`, threadId: id, subject: `Subject ${id}`, body: 'a < b' })] },
          url,
        }),
      )
    );
  };
}

describe('list fan-out', () => {
  it('skips a thread that was deleted while the list was read and keeps the rest', async () => {
    const { tools } = await build({
      routes: [
        route('/threads', { threads: threadRows(3), resultSizeEstimate: 3 }),
        threadAnswers(id => (id === 't1' ? json(googleError({ status: 404, reason: 'notFound' }), 404) : undefined)),
      ],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_inbox_threads', arguments: {} })));
    expect(result.threads.map((row: { id: string }) => row.id)).toEqual(['t0', 't2']);
  });

  it('retries a 429 and waits as long as Retry-After says', async () => {
    const { tools, sleeps } = await build({
      routes: [
        route('/threads', { threads: threadRows(2), resultSizeEstimate: 2 }),
        threadAnswers((id, attempt) =>
          id === 't0' && attempt === 1
            ? new Response(JSON.stringify(googleError({ status: 429, reason: 'rateLimitExceeded' })), {
                status: 429,
                headers: { 'Retry-After': '3', 'Content-Type': 'application/json' },
              })
            : undefined,
        ),
      ],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_inbox_threads', arguments: {} })));
    expect(result.threads).toHaveLength(2);
    expect(sleeps).toEqual([3000]);
  });

  it('retries a 403 that only means "too fast" with growing waits, then gives a plain busy message', async () => {
    const { tools, sleeps } = await build({
      routes: [
        route('/threads', { threads: threadRows(1), resultSizeEstimate: 1 }),
        threadAnswers(() => json(googleError({ status: 403, reason: 'userRateLimitExceeded' }), 403)),
      ],
    });
    const response = await tools.callTool({ name: 'list_inbox_threads', arguments: {} });
    expect(text(response)).toContain('Gmail is busy right now. Try again in a minute.');
    expect(sleeps).toEqual([500, 1000, 2000]);
  });

  it('applies the same care to the draft list', async () => {
    let first = true;
    const { tools } = await build({
      features: ['gmail_read'],
      routes: [
        route('/drafts', { drafts: [{ id: 'd1' }, { id: 'd2' }, { id: 'd3' }] }),
        url => {
          const id = /\/drafts\/(d\d)$/.exec(url.pathname)?.[1];
          if (id === undefined) return undefined;
          if (id === 'd2') return json(googleError({ status: 404, reason: 'notFound' }), 404);
          if (id === 'd1' && first) {
            first = false;
            return json(googleError({ status: 429, reason: 'rateLimitExceeded' }), 429);
          }
          return json({ id, message: message({ id: `${id}-m`, body: 'x' }) });
        },
      ],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_drafts', arguments: {} })));
    expect(result.drafts.map((row: { draft_id: string }) => row.draft_id)).toEqual(['d1', 'd3']);
  });

  it('rows come from metadata only and never carry body text', async () => {
    const { tools, google } = await build({
      routes: [route('/threads', { threads: threadRows(1), resultSizeEstimate: 1 }), threadAnswers(() => undefined)],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_inbox_threads', arguments: {} })));
    expect(result.threads[0]).toMatchObject({ subject: 'Subject t0', from: 'Grace <grace@example.com>' });
    expect(
      google.urls.some(entry => entry.includes('format=metadata') && entry.includes('metadataHeaders=Subject')),
    ).toBe(true);
  });

  it('shows a snippet with its HTML escapes decoded', async () => {
    const { tools } = await build({
      routes: [route('/threads', { threads: threadRows(1), resultSizeEstimate: 1 }), threadAnswers(() => undefined)],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_inbox_threads', arguments: {} })));
    expect(result.threads[0].snippet).toBe('a < b');
  });
});

describe('why Google said 403', () => {
  const call = async (body: unknown) => {
    const { tools, sleeps } = await build({ routes: [route('/messages/m1', body, 403)] });
    return { said: text(await tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } })), sleeps };
  };

  it('says Gmail is busy for a rate limit, after trying again', async () => {
    const { said, sleeps } = await call(googleError({ status: 403, reason: 'rateLimitExceeded' }));
    expect(said).toContain('Gmail is busy right now. Try again in a minute.');
    expect(sleeps.length).toBe(3);
  });

  it('says the Gmail API is off in the Google project, pointing at setup step 2, without retrying', async () => {
    const { said, sleeps } = await call(googleError({ status: 403, reason: 'accessNotConfigured' }));
    expect(said).toContain("Gmail API isn't turned on in your Google project");
    expect(said).toContain('step 2');
    expect(sleeps).toEqual([]);
  });

  it('says a permission is missing for insufficient scopes, without retrying', async () => {
    const { said, sleeps } = await call(INSUFFICIENT_SCOPE_BODY);
    expect(said).toContain("hasn't given Aman permission");
    expect(said).toContain('Reconnect');
    expect(sleeps).toEqual([]);
  });

  it('never repeats text from Google beyond its reason', async () => {
    const { said } = await call(googleError({ status: 403, reason: 'other', message: 'secret internal detail' }));
    expect(said).not.toContain('secret internal detail');
  });
});

describe('failures reaching Google', () => {
  it('turns a network error into a plain retryable message', async () => {
    const { tools } = await build({
      routes: [
        () => {
          throw new TypeError('fetch failed: ECONNRESET 10.0.0.1');
        },
      ],
    });
    const said = text(await tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } }));
    expect(said).not.toContain('ECONNRESET');
    expect(said).toContain('Try again');
  });

  it('gives every request a time limit', async () => {
    const connections = new FakeConnections();
    await connections.save(connectedRecord());
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      signals.push(init?.signal);
      return Promise.resolve(
        url.includes('/token')
          ? json({ access_token: 'at', expires_in: 3600 })
          : json(message({ id: 'm1', body: 'x' })),
      );
    };
    const api = new GmailApi({
      tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl }),
      fetchImpl,
      sleep: () => Promise.resolve(),
    });
    await api.getMessage('m1');
    expect(signals.every(signal => signal instanceof AbortSignal)).toBe(true);
  });
});

describe('mapSkippingMissing', () => {
  it('runs at most four at once', async () => {
    let inFlight = 0;
    let peak = 0;
    await mapSkippingMissing({
      items: Array.from({ length: 12 }, (_unused, index) => index),
      work: async () => {
        inFlight += 1;
        peak = Math.max(peak, inFlight);
        await Promise.resolve();
        await Promise.resolve();
        inFlight -= 1;
      },
    });
    expect(peak).toBe(4);
  });

  it('keeps the order of the items it kept', async () => {
    const out = await mapSkippingMissing({
      items: [1, 2, 3, 4, 5, 6],
      work: item => Promise.resolve(item * 10),
    });
    expect(out).toEqual([10, 20, 30, 40, 50, 60]);
  });
});
