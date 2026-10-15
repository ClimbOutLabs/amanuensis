// @vitest-environment jsdom
// Pill clicks against the real HTTP persona endpoints: the PUT fires, the pill
// UI updates, and turn creation waits for an in-flight PUT instead of racing.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { ActivePersonaIndicator } from '@/atoms/ActivePersonaIndicator.js';
import { PersonaProvider, type Persona, type PersonaApi, type SessionPersona } from '@/components/PersonaContext.js';
import { awaitPendingPersonaMutation } from '@/personaMutationGate.js';
import { personaKnowledgeApiStubs } from '../personaApiStubs.js';

const useThreadIsRunning = vi.fn(() => false);
const useAuiState = vi.fn();

vi.mock('@assistant-ui/core/react', () => ({
  useThreadIsRunning: () => useThreadIsRunning(),
}));

vi.mock('@/assistant-ui.js', () => ({
  useAuiState: (selector: (state: unknown) => unknown) => useAuiState(selector),
}));

const SQUIDWARD: Persona = {
  id: 'p-squidward',
  display_name: 'Squidward',
  aliases: [],
  instructions: 'You are Squidward.',
  model_name: 'scripted/scripted-alt-model',
};
const SPONGEBOB: Persona = {
  id: 'p-spongebob',
  display_name: 'Spongebob',
  aliases: [],
  instructions: 'You are Spongebob.',
  model_name: 'scripted/scripted-model',
};

type PutRecord = { url: string; body: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function readDataEnvelope(value: unknown): unknown {
  if (!isRecord(value) || !('data' in value)) {
    throw new Error('expected a { data } envelope');
  }
  return value.data;
}

function toPersona(value: unknown): Persona {
  if (!isRecord(value)) {
    throw new Error('bad persona shape');
  }
  const { id, display_name, aliases, instructions, model_name } = value;
  if (typeof id !== 'string') throw new Error('bad persona.id');
  if (typeof display_name !== 'string') throw new Error('bad persona.display_name');
  if (typeof instructions !== 'string') throw new Error('bad persona.instructions');
  if (typeof model_name !== 'string') throw new Error('bad persona.model_name');
  if (!Array.isArray(aliases)) throw new Error('bad persona.aliases');
  const cleanAliases: string[] = [];
  for (const alias of aliases) {
    if (typeof alias !== 'string') throw new Error('bad persona.aliases');
    cleanAliases.push(alias);
  }
  return { id, display_name, aliases: cleanAliases, instructions, model_name };
}

function toSessionPersona(value: unknown): SessionPersona | null {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new Error('bad session persona shape');
  }
  const { persona_id, persona_name, model_name, source, turn_id } = value;
  if (persona_id !== null && typeof persona_id !== 'string') throw new Error('bad persona_id');
  if (persona_name !== null && typeof persona_name !== 'string') throw new Error('bad persona_name');
  if (model_name !== null && typeof model_name !== 'string') throw new Error('bad model_name');
  if (turn_id !== null && typeof turn_id !== 'string') throw new Error('bad turn_id');
  if (source !== 'invocation' && source !== 'sticky' && source !== 'explicit' && source !== 'default') {
    throw new Error('bad activation source');
  }
  return { persona_id, persona_name, model_name, source, turn_id };
}

function readPersonaId(body: string): string | null {
  const parsed: unknown = body.length === 0 ? {} : JSON.parse(body);
  if (!isRecord(parsed)) {
    throw new Error('bad PUT body');
  }
  const personaId = parsed.persona_id;
  if (personaId !== undefined && personaId !== null && typeof personaId !== 'string') {
    throw new Error('bad persona_id in PUT body');
  }
  return personaId ?? null;
}

function activationFor(personaId: string | null) {
  const persona = personaId === SPONGEBOB.id ? SPONGEBOB : personaId === SQUIDWARD.id ? SQUIDWARD : null;
  return {
    persona_id: persona?.id ?? null,
    persona_name: persona?.display_name ?? null,
    model_name: persona?.model_name ?? null,
    source: persona === null ? 'default' : 'explicit',
    turn_id: null,
  };
}

/** Fetch-backed PersonaApi against the stub server; no cross-package imports. */
function testPersonaApi(baseUrl: string): PersonaApi {
  async function readData(path: string, init?: RequestInit): Promise<unknown> {
    const response = await fetch(`${baseUrl}${path}`, init);
    if (!response.ok) {
      throw new Error(`persona API ${path} failed with ${String(response.status)}`);
    }
    return readDataEnvelope(await response.json());
  }
  return {
    ...personaKnowledgeApiStubs,
    listPersonas: async () => {
      const data = await readData('/api/v1/personas');
      if (!Array.isArray(data)) {
        throw new Error('bad personas list');
      }
      return data.map(toPersona);
    },
    createPersona: async () => {
      throw new Error('Unexpected persona API call');
    },
    updatePersona: async () => {
      throw new Error('Unexpected persona API call');
    },
    deletePersona: async () => {
      throw new Error('Unexpected persona API call');
    },
    getSessionPersona: sessionId =>
      readData(`/api/v1/sessions/${encodeURIComponent(sessionId)}/persona`).then(toSessionPersona),
    setSessionPersona: (sessionId, personaId) =>
      readData(`/api/v1/sessions/${encodeURIComponent(sessionId)}/persona`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ persona_id: personaId }),
      }).then(toSessionPersona),
  };
}

async function startPersonaServer(options?: {
  putDelayMs?: number;
}): Promise<{ server: Server; baseUrl: string; puts: PutRecord[] }> {
  const puts: PutRecord[] = [];
  let activePersonaId: string | null = SQUIDWARD.id;
  const putDelayMs = options?.putDelayMs ?? 0;
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let body = '';
    req.on('data', chunk => {
      body += chunk;
    });
    req.on('end', () => {
      const json = (value: unknown, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.method === 'GET' && url.pathname === '/api/v1/personas') {
        json({ data: [SQUIDWARD, SPONGEBOB] });
        return;
      }
      const match = /^\/api\/v1\/sessions\/([^/]+)\/persona$/.exec(url.pathname);
      if (match === null) {
        json({ error: { message: 'not found' } }, 404);
        return;
      }
      if (req.method === 'GET') {
        json({ data: activePersonaId === null ? null : activationFor(activePersonaId) });
        return;
      }
      if (req.method === 'PUT') {
        let personaId: string | null;
        try {
          personaId = readPersonaId(body);
        } catch {
          json({ error: { message: 'bad request' } }, 400);
          return;
        }
        puts.push({ url: url.pathname, body: { persona_id: personaId } });
        activePersonaId = personaId;
        // Optional slow network so the test can observe the in-flight state.
        setTimeout(() => {
          json({ data: activationFor(activePersonaId) });
        }, putDelayMs);
        return;
      }
      json({ error: { message: 'method not allowed' } }, 405);
    });
  });
  await new Promise<void>(resolve => {
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('server did not bind');
  }
  return { server, baseUrl: `http://127.0.0.1:${String(address.port)}`, puts };
}

describe('pill click against the real API', () => {
  let baseUrl = '';
  let puts: PutRecord[] = [];
  let server: Server | undefined;

  beforeAll(async () => {
    const started = await startPersonaServer();
    server = started.server;
    baseUrl = started.baseUrl;
    puts = started.puts;
    useThreadIsRunning.mockReturnValue(false);
    useAuiState.mockImplementation((selector: (state: unknown) => unknown) =>
      selector({ threadListItem: { remoteId: 'sess-1' } }),
    );
  }, 30_000);

  afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server?.close(error => (error === undefined ? resolve() : reject(error)));
    });
  });

  it('fires the pill PUT and shows the picked persona', async () => {
    render(
      <PersonaProvider api={testPersonaApi(baseUrl)}>
        <ActivePersonaIndicator />
      </PersonaProvider>,
    );

    // Baseline: the pill names the old persona.
    expect(await screen.findByTestId('active-persona')).toHaveTextContent('Squidward');

    // Real clicks: open the picker, pick the other persona.
    fireEvent.click(await screen.findByRole('button', { name: 'Choose who answers this chat' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Spongebob' }));

    // The pill PUT fired exactly like the bug report's click.
    await waitFor(() => {
      expect(puts).toHaveLength(1);
    });
    expect(puts[0]?.url).toBe('/api/v1/sessions/sess-1/persona');
    expect(puts[0]?.body).toEqual({ persona_id: 'p-spongebob' });

    // The pill UI updates to the picked persona.
    await waitFor(() => {
      expect(screen.getByTestId('active-persona')).toHaveTextContent('Spongebob');
    });
  });

  it('turn creation waits for the in-flight pill PUT', async () => {
    const slow = await startPersonaServer({ putDelayMs: 300 });
    try {
      const { unmount } = render(
        <PersonaProvider api={testPersonaApi(slow.baseUrl)}>
          <ActivePersonaIndicator />
        </PersonaProvider>,
      );

      expect(await screen.findByTestId('active-persona')).toHaveTextContent('Squidward');
      fireEvent.click(await screen.findByRole('button', { name: 'Choose who answers this chat' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Spongebob' }));

      // The PUT is in flight. A turn created now (via the gate, like
      // chatServer.createTurn does) must wait for it instead of racing ahead.
      let gateResolved = false;
      const gateWaiter = awaitPendingPersonaMutation().then(() => {
        gateResolved = true;
      });
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(gateResolved).toBe(false);
      // The PUT eventually lands, the gate releases, and the pill shows B.
      await gateWaiter;
      expect(gateResolved).toBe(true);
      await waitFor(() => {
        expect(screen.getByTestId('active-persona')).toHaveTextContent('Spongebob');
      });
      unmount();
    } finally {
      await new Promise<void>((resolve, reject) => {
        slow.server.close(error => (error === undefined ? resolve() : reject(error)));
      });
    }
  });
});
