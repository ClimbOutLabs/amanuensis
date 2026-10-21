// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { render, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PersonaProvider, type PersonaApi } from '@/components/PersonaContext.js';
import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { SlotsProvider } from '@/theme/SlotsProvider.js';

import { RuntimeHarness } from './RuntimeHarness.js';

vi.mock('@truefoundry/assistant-ui-runtime', async importOriginal => {
  const actual = await importOriginal<typeof import('@truefoundry/assistant-ui-runtime')>();
  return { ...actual, useTrueFoundryRespondToToolApproval: () => vi.fn() };
});

/** A persona API whose list is read again on every call, so a reload shows up as a second read. */
function personaApi(): PersonaApi & { listCalls: () => number } {
  let calls = 0;
  const unused = () => Promise.reject(new Error('not used in this test'));
  return {
    listPersonas: () => {
      calls += 1;
      return Promise.resolve([]);
    },
    createPersona: unused,
    updatePersona: unused,
    deletePersona: unused,
    getSessionPersona: () => Promise.resolve(null),
    setSessionPersona: unused,
    listPersonaKnowledge: () => Promise.resolve([]),
    createPersonaKnowledge: unused,
    deletePersonaKnowledge: unused,
    getPersonaKnowledgeEmbeddingModel: unused,
    listCalls: () => calls,
  };
}

function renderWithPersonas(content: ThreadMessageLike['content'], api: PersonaApi) {
  const message: ThreadMessageLike = { role: 'assistant', content };
  return render(
    <SlotsProvider>
      <PersonaProvider api={api}>
        <RuntimeHarness messages={[message]}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </RuntimeHarness>
      </PersonaProvider>
    </SlotsProvider>,
  );
}

describe('a finished create_persona call', () => {
  it('reads the persona list again so the new specialist shows without a reload', async () => {
    const api = personaApi();
    renderWithPersonas(
      [
        {
          type: 'tool-call',
          toolCallId: 'call-persona',
          toolName: 'create_persona',
          args: { name: 'Travel planner' },
          result: { created: { name: 'Travel planner' } },
        },
      ],
      api,
    );
    await waitFor(() => expect(api.listCalls()).toBeGreaterThanOrEqual(2));
  });

  it('leaves the list alone for any other tool', async () => {
    const api = personaApi();
    renderWithPersonas(
      [
        {
          type: 'tool-call',
          toolCallId: 'call-other',
          toolName: 'web_search',
          args: { query: 'weather' },
          result: { ok: true },
        },
      ],
      api,
    );
    await waitFor(() => expect(api.listCalls()).toBe(1));
  });
});
