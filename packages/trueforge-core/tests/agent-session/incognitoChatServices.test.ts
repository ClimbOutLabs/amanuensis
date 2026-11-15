/** Every turn of an incognito chat reaches its tools with the permission check told the chat keeps nothing. */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { defaultSentinelServices, type SentinelServices } from '../../src/core/permissions';
import { emptyLlmStream, makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };

async function servicesOfOneTurn(input: { is_incognito: boolean; unattended: boolean }): Promise<SentinelServices> {
  const seen: SentinelServices[] = [];
  const base = makeTestResolver({ modelClient: makeMockILLM({ create: jest.fn(() => emptyLlmStream()) }) });
  const resolver: ITurnResourceResolver = {
    get logger() {
      return base.logger;
    },
    get webSearchTurn() {
      return base.webSearchTurn;
    },
    createTracing: () => base.createTracing(),
    resolveAgentSpec: resolveInput => base.resolveAgentSpec(resolveInput),
    resolveSandbox: resolveInput => base.resolveSandbox(resolveInput),
    resolveAgentDefinition: resolveInput => {
      if (resolveInput.sentinel_services !== undefined) {
        seen.push(resolveInput.sentinel_services);
      }
      return base.resolveAgentDefinition(resolveInput);
    },
    close: () => base.close(),
  };
  const sessions = new Sessions({
    sessionStore: new InMemorySessionStore(),
    sentinelServices: defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
  });
  const session = await sessions.create({
    tenant_id: 't',
    session_id: 'chat-1',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: null,
    ...(input.is_incognito ? { is_incognito: true, private_expires_at: new Date('2026-01-02T00:00:00.000Z') } : {}),
  });
  const turn = await session.createTurn({
    turn_id: mintTestTurnId(),
    input: [{ type: EventType.USER_MESSAGE, content: 'Hello' }],
    signal: new AbortController().signal,
    resolver,
    ...(input.unattended ? { unattended: true } : {}),
  });
  for await (const event of turn.stream()) {
    void event;
  }
  const services = seen[0];
  if (services === undefined) {
    throw new Error('the turn resolved no agent definition');
  }
  return services;
}

describe('the permission check of a chat knows whether the chat is incognito', () => {
  it('is told so on a turn of an incognito chat', async () => {
    expect((await servicesOfOneTurn({ is_incognito: true, unattended: false })).incognito).toBe(true);
  });

  it('is told so on a turn nobody watches, too', async () => {
    const services = await servicesOfOneTurn({ is_incognito: true, unattended: true });
    expect(services).toMatchObject({ incognito: true, unattended: true });
  });

  it('is not told so in a normal chat', async () => {
    expect((await servicesOfOneTurn({ is_incognito: false, unattended: false })).incognito).toBe(false);
  });
});
