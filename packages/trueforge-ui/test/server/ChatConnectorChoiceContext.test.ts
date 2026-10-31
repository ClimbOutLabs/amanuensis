import { describe, expect, it, vi } from 'vitest';

import { connectorOffKey } from '@truefoundry/trueforge-core/core/connectors/chatConnectorChoice';

import {
  createChatConnectorChoiceStore,
  createSessionWithConnectorChoice,
} from '@/server/ChatConnectorChoiceContext.js';
import { createMockAgentUIServer } from './mockServer.js';

const spec = { model: { name: 'openai/gpt-4.1' } };

function sessionNamed(id: string) {
  return { id, isMutable: true, createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z' };
}

describe('createSessionWithConnectorChoice', () => {
  it('sends the new chat off choice with the session create, then hands it to the new session', async () => {
    const store = createChatConnectorChoiceStore();
    store.set({ sessionId: undefined, keys: [connectorOffKey('Email')] });
    const createSession = vi.fn(async () => sessionNamed('chat-1'));

    await createSessionWithConnectorChoice({
      server: createMockAgentUIServer({ createSession }),
      store,
      metadata: { is_create_agent: 'false' },
      request: { agentSpec: spec },
    });

    expect(createSession).toHaveBeenCalledWith({
      agentSpec: spec,
      metadata: { is_create_agent: 'false', [connectorOffKey('Email')]: '1' },
    });
    expect(store.get('chat-1')).toEqual([connectorOffKey('Email')]);
    expect(store.get(undefined)).toEqual([]);
  });

  it('adds no off choice for a chat that turned nothing off', async () => {
    const store = createChatConnectorChoiceStore();
    const createSession = vi.fn(async () => sessionNamed('chat-2'));

    await createSessionWithConnectorChoice({
      server: createMockAgentUIServer({ createSession }),
      store,
      metadata: { is_create_agent: 'false' },
      request: { agentSpec: spec },
    });

    expect(createSession).toHaveBeenCalledWith({ agentSpec: spec, metadata: { is_create_agent: 'false' } });
  });

  it('drops a choice made on a draft that was never sent', () => {
    const store = createChatConnectorChoiceStore();
    store.set({ sessionId: undefined, keys: [connectorOffKey('Email')] });
    store.clearPending();
    expect(store.get(undefined)).toEqual([]);
  });
});
