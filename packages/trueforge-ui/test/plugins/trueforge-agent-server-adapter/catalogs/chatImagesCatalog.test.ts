import { describe, expect, it, vi } from 'vitest';

import { createChatImagesCatalog } from '@/plugins/trueforge-agent-server-adapter/catalogs/chatImagesCatalog.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

describe('createChatImagesCatalog', () => {
  it('posts a show request with the session cookie only, never a bearer token', async () => {
    const fetch = vi.fn((_url: RequestInfo | URL, _init?: RequestInit) =>
      Promise.resolve(jsonResponse({ data: { status: 'ask', count: 2, host: null } })),
    );
    const bearer = 'invented-bearer-value';
    const catalog = createChatImagesCatalog({ baseUrl: '/app/', token: bearer, fetch });
    await expect(
      catalog.showTurnImages({
        sessionId: 's 1',
        turnId: 't1',
        source: { kind: 'email', tool_call_id: 'm' },
        approved: false,
      }),
    ).resolves.toEqual({ status: 'ask', count: 2, host: null });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe('/app/api/chat-images/sessions/s%201/turns/t1');
    expect(init?.credentials).toBe('same-origin');
    expect(JSON.stringify(init?.headers)).not.toContain(bearer);
    expect(init?.body).toBe(JSON.stringify({ source: { kind: 'email', tool_call_id: 'm' }, approved: false }));
  });

  it('builds the same-origin image address', () => {
    const catalog = createChatImagesCatalog({ fetch: vi.fn() });
    expect(catalog.imageUrl({ sessionId: 's1', imageId: 'a'.repeat(32) })).toBe(
      `/api/chat-images/sessions/s1/images/${'a'.repeat(32)}`,
    );
  });

  it('rejects an unexpected payload and an error status', async () => {
    const bad = createChatImagesCatalog({ fetch: () => Promise.resolve(jsonResponse({ data: { status: 'maybe' } })) });
    await expect(bad.listTurnImages({ sessionId: 's1', turnId: 't1' })).rejects.toThrow('unexpected');
    const failing = createChatImagesCatalog({ fetch: () => Promise.resolve(jsonResponse({}, 404)) });
    await expect(failing.listTurnImages({ sessionId: 's1', turnId: 't1' })).rejects.toThrow('HTTP 404');
  });
});
