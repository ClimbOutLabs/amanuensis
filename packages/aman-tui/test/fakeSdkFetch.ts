/**
 * A fake fetch that speaks the SDK's wire shapes (snake_case JSON and SSE
 * frames), so the chat client can be tested end to end through the real SDK
 * and the real shared chat package, with no network at all.
 */

export interface SseFrame {
  id: string;
  data: Record<string, unknown>;
}

export interface RecordedSdkCall {
  method: string;
  path: string;
  body: unknown;
}

export interface FakeSdkScript {
  sessions?: Record<string, unknown>[];
  personaBySession?: Record<string, string | null>;
  agents?: string[];
  historyBySession?: Record<string, Record<string, unknown>[]>;
  createdSession?: Record<string, unknown>;
  onCreateTurn?: (sessionId: string) => { frames: SseFrame[]; failAtEnd?: boolean };
  onSubscribe?: (sessionId: string, turnId: string) => { frames: SseFrame[] };
}

const AT = '2026-11-15T12:00:00.000Z';

/** One session in wire shape, with Nora's made-up data. */
export function wireSession(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'session-1',
    title: 'Weekend plans',
    agent: { type: 'reference', id: 'agent-1', name: 'mannie' },
    approval_grants: [],
    created_at: AT,
    created_by_subject: { id: 'nora', type: 'user', display_name: 'Nora' },
    folder_id: null,
    is_incognito: false,
    metadata: {},
    metrics: {},
    private_expires_at: null,
    source: null,
    updated_at: '2026-11-15T11:45:00.000Z',
    ...overrides,
  };
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } });
}

function sseResponse(frames: SseFrame[], failAtEnd: boolean): Response {
  const encoder = new TextEncoder();
  let started = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      started = true;
      for (const frame of frames) {
        controller.enqueue(encoder.encode(`id: ${frame.id}\ndata: ${JSON.stringify(frame.data)}\n\n`));
      }
      if (!failAtEnd) {
        controller.close();
      }
    },
    pull(controller) {
      // A dropped connection: the frames already sent are read first, and the
      // failure arrives only when the reader asks for more.
      if (failAtEnd && started) {
        controller.error(new Error('The connection dropped.'));
      }
    },
  });
  return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

function parseBody(init: RequestInit | undefined): unknown {
  if (init?.body === undefined || init.body === null || typeof init.body !== 'string') {
    return undefined;
  }
  try {
    return JSON.parse(init.body);
  } catch {
    return undefined;
  }
}

export function makeFakeSdkFetch(script: FakeSdkScript): { fetcher: typeof fetch; calls: RecordedSdkCall[] } {
  const calls: RecordedSdkCall[] = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const method = init?.method ?? 'GET';
    const path = url.pathname;
    calls.push({ method, path, body: parseBody(init) });

    if (path === '/api/v1/sessions' && method === 'GET') {
      return jsonResponse({ data: script.sessions ?? [], pagination: { limit: 50 } });
    }
    if (path === '/api/v1/sessions' && method === 'POST') {
      return jsonResponse({ data: script.createdSession ?? wireSession({ id: 'session-new', title: null }) });
    }
    if (path === '/api/v1/agents') {
      return jsonResponse({
        data: (script.agents ?? []).map(name => ({ id: `agent-${name}`, name })),
        pagination: { limit: 1 },
      });
    }
    const personaMatch = /^\/api\/v1\/sessions\/([^/]+)\/persona$/.exec(path);
    if (personaMatch !== null && method === 'GET') {
      const sessionId = personaMatch[1] ?? '';
      const name = script.personaBySession?.[sessionId] ?? null;
      return jsonResponse({
        data: name === null ? null : { persona_id: 'persona-1', persona_name: name, source: 'sticky' },
      });
    }
    const eventsMatch = /^\/api\/v1\/sessions\/([^/]+)\/events$/.exec(path);
    if (eventsMatch !== null && method === 'GET') {
      const sessionId = eventsMatch[1] ?? '';
      return jsonResponse({ data: script.historyBySession?.[sessionId] ?? [], pagination: { limit: 100 } });
    }
    const createTurnMatch = /^\/api\/v1\/sessions\/([^/]+)\/turns$/.exec(path);
    if (createTurnMatch !== null && method === 'POST') {
      const sessionId = createTurnMatch[1] ?? '';
      const turn = script.onCreateTurn?.(sessionId) ?? { frames: [] };
      return sseResponse(turn.frames, turn.failAtEnd ?? false);
    }
    const subscribeMatch = /^\/api\/v1\/sessions\/([^/]+)\/turns\/([^/]+)\/subscribe$/.exec(path);
    if (subscribeMatch !== null && method === 'GET') {
      const sessionId = subscribeMatch[1] ?? '';
      const turnId = subscribeMatch[2] ?? '';
      const turn = script.onSubscribe?.(sessionId, turnId) ?? { frames: [] };
      return sseResponse(turn.frames, false);
    }
    return new Response(JSON.stringify({ error: { message: 'Not found.' } }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { fetcher: fetcher as typeof fetch, calls };
}
