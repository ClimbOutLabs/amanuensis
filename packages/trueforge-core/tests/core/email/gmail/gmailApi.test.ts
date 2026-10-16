import { GmailApi, mapSkippingMissing } from '../../../../src/core/email/gmail/gmailApi';
import { estimateTokens, MAX_TOKENS_PER_CALL } from '../../../../src/core/email/gmail/tokenBound';
import { GoogleAccessTokens } from '../../../../src/core/google/GoogleAccessTokens';
import { connectedRecord, FakeConnections, OWNER } from '../../google/fakes';
import { message } from './fixtures';
import { build, gmailThreadResponse, googleError, HANG, INSUFFICIENT_SCOPE_BODY, json, route, text } from './harness';

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

describe('a slow Gmail', () => {
  it('returns the rows it has, says Gmail was slow, and withholds the page token that would skip the rest', async () => {
    const { tools } = await build({
      listDeadlineMs: 150,
      routes: [
        route('/threads', { threads: threadRows(8), resultSizeEstimate: 8, nextPageToken: 'more' }),
        url => {
          const id = /\/threads\/(t\d+)$/.exec(url.pathname)?.[1];
          // Later threads never answer.
          return id !== undefined && Number(id.slice(1)) >= 4 ? HANG : undefined;
        },
        threadAnswers(() => undefined),
      ],
    });
    const result = JSON.parse(text(await tools.callTool({ name: 'list_inbox_threads', arguments: {} })));
    expect(result.threads).toHaveLength(4);
    expect(result.note).toBe('Gmail was slow; showing the first 4. Ask for fewer results or try again.');
    expect(result.next_page_token).toBeUndefined();
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
      deadlineMs: 60_000,
    });
    expect(peak).toBe(4);
  });

  it('keeps the order of the items it kept', async () => {
    const out = await mapSkippingMissing({
      items: [1, 2, 3, 4, 5, 6],
      work: item => Promise.resolve(item * 10),
      deadlineMs: 60_000,
    });
    expect(out).toEqual({ results: [10, 20, 30, 40, 50, 60], notReached: 0 });
  });

  it('stops waiting at the deadline and says how many items it never reached', async () => {
    const out = await mapSkippingMissing({
      items: [1, 2, 3, 4, 5, 6, 7, 8, 9],
      work: item => (item > 4 ? new Promise<number>(() => undefined) : Promise.resolve(item)),
      deadlineMs: 50,
    });
    expect(out).toEqual({ results: [1, 2, 3, 4], notReached: 5 });
  });

  it('returns nothing, not an error, when the first batch never answers', async () => {
    const out = await mapSkippingMissing({
      items: [1, 2],
      work: () => new Promise<number>(() => undefined),
      deadlineMs: 20,
    });
    expect(out).toEqual({ results: [], notReached: 2 });
  });
});

/** A GmailApi over a scripted fetch, for tests that need to shape the raw response. */
async function apiOver(answer: (url: URL, init: RequestInit | undefined) => Response | Promise<Response>) {
  const connections = new FakeConnections();
  await connections.save(connectedRecord());
  const requests: string[] = [];
  const sleeps: number[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.pathname.endsWith('/token')) {
      return Promise.resolve(json({ access_token: 'at', expires_in: 3600 }));
    }
    requests.push(`${init?.method ?? 'GET'} ${url.pathname}`);
    return Promise.resolve(answer(url, init));
  };
  const api = new GmailApi({
    tokens: new GoogleAccessTokens({ now: undefined, connections, owner: OWNER, fetchImpl }),
    fetchImpl,
    sleep: ms => {
      sleeps.push(ms);
      return Promise.resolve();
    },
  });
  return { api, requests, sleeps };
}

describe('the size of a response', () => {
  it('refuses a response whose Content-Length is over the limit without reading or parsing it', async () => {
    const response = new Response('{}', { headers: { 'Content-Length': String(17 * 1024 * 1024) } });
    const parse = jest.spyOn(response, 'json');
    const { api } = await apiOver(() => response);
    await expect(api.getMessage('m1')).rejects.toThrow('more than Aman will read at once');
    expect(parse).not.toHaveBeenCalled();
  });

  it('counts a body with no Content-Length as it streams, and stops reading at the limit', async () => {
    let pulled = 0;
    const chunk = new Uint8Array(1024 * 1024);
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { api } = await apiOver(() => new Response(stream));
    await expect(api.getMessage('m1')).rejects.toThrow('more than Aman will read at once');
    expect(pulled).toBeLessThan(25);
  });

  it('refuses a body that is bigger than its Content-Length says', async () => {
    const big = JSON.stringify({ id: 'm1', threadId: 't1', snippet: 'x'.repeat(17 * 1024 * 1024) });
    const { api } = await apiOver(() => new Response(big, { headers: { 'Content-Length': '10' } }));
    await expect(api.getMessage('m1')).rejects.toThrow('more than Aman will read at once');
  });

  it('reads an ordinary response', async () => {
    const { api } = await apiOver(() => json(message({ id: 'm1', body: 'hello' })));
    expect((await api.getMessage('m1')).id).toBe('m1');
  });

  it('says a response it cannot parse is unreadable, even when it is nested deep enough to overflow a parser', async () => {
    const depth = 200_000;
    const nested = `${'{"parts":['.repeat(depth)}${']}'.repeat(depth)}`;
    const { api } = await apiOver(() => new Response(`{"id":"m1","threadId":"t1","payload":${nested}}`));
    await expect(api.getMessage('m1')).rejects.toThrow('could not read');
  });

  it('reads a whole attachment even though it is larger than a thread may be', async () => {
    const bytes = Buffer.alloc(20 * 1024 * 1024, 1);
    const { api } = await apiOver(() => json({ size: bytes.length, data: bytes.toString('base64url') }));
    expect((await api.getAttachment({ messageId: 'm1', attachmentId: 'a1' })).length).toBe(bytes.length);
  });

  it('refuses a hostile thread of huge headers and thousands of file names through the tool, inside the bound', async () => {
    const parts = Array.from({ length: 3000 }, (_unused, index) => ({
      mimeType: 'application/pdf',
      filename: `${String(index)}-${'n'.repeat(250)}.pdf`,
      body: { attachmentId: `att-${String(index)}`, size: index },
    }));
    const hostile = {
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        headers: ['From', 'To', 'Cc', 'Subject'].map(name => ({ name, value: 'h'.repeat(9000) })),
        parts,
      },
    };
    const { tools } = await build({ routes: [route('/messages/m1', hostile)] });
    const said = text(await tools.callTool({ name: 'read_email', arguments: { message_id: 'm1' } }));
    expect(estimateTokens(said)).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(JSON.parse(said).attachments_omitted).toBeGreaterThan(0);
  });
});

describe('requests that create or send', () => {
  const SENT = 'The send may have gone through. Check your Sent folder before trying again.';
  const SAVED = 'The draft may have been saved. Check your Drafts folder before trying again.';

  it('are not tried again after a server error, and say the send may have gone through', async () => {
    const { api, requests, sleeps } = await apiOver(() =>
      json(googleError({ status: 500, reason: 'backendError' }), 500),
    );
    await expect(api.sendDraft('d1')).rejects.toThrow(SENT);
    expect(requests).toEqual(['POST /gmail/v1/users/me/drafts/send']);
    expect(sleeps).toEqual([]);
  });

  it('say the send may have gone through when it times out or the connection drops', async () => {
    const { api, requests } = await apiOver(() => {
      throw new TypeError('fetch failed');
    });
    await expect(api.sendDraft('d1')).rejects.toThrow(SENT);
    expect(requests).toHaveLength(1);
  });

  it('say the send may have gone through when the answer to a send cannot be read', async () => {
    const { api } = await apiOver(() => new Response('<html>', { status: 200 }));
    await expect(api.sendDraft('d1')).rejects.toThrow(SENT);
  });

  it('say the draft may have been saved, and are not tried again, for a new draft', async () => {
    const { api, requests } = await apiOver(() => json(googleError({ status: 503, reason: 'backendError' }), 503));
    await expect(api.createDraft({ raw: 'r', threadId: undefined })).rejects.toThrow(SAVED);
    expect(requests).toHaveLength(1);
  });

  it('are tried again only when Gmail refused for going too fast, which it does before doing anything', async () => {
    let calls = 0;
    const { api, sleeps } = await apiOver(() => {
      calls += 1;
      return calls === 1
        ? json(googleError({ status: 429, reason: 'rateLimitExceeded' }), 429)
        : json({ id: 'sent', threadId: 't1' });
    });
    expect((await api.sendDraft('d1')).id).toBe('sent');
    expect(calls).toBe(2);
    expect(sleeps).toHaveLength(1);
  });

  it('still tell a plain refusal apart from an unknown outcome', async () => {
    const { api } = await apiOver(() => json(googleError({ status: 404, reason: 'notFound' }), 404));
    await expect(api.sendDraft('d1')).rejects.toThrow('Gmail has no such message, thread or draft.');
  });

  it('keep trying a read after a server error', async () => {
    let calls = 0;
    const { api } = await apiOver(() => {
      calls += 1;
      return calls < 3 ? json(googleError({ status: 500, reason: 'backendError' }), 500) : json(message({ id: 'm1' }));
    });
    expect((await api.getMessage('m1')).id).toBe('m1');
    expect(calls).toBe(3);
  });
});
