import { builtinsFromSpec, threadCapabilities } from '../../src/agent-session/builtinsFromSpec';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import type { AgentCapability } from '../../src/core/capabilities/AgentCapability';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';
import {
  emptyLlmStream,
  makeAgentSpec,
  makeMockILLM,
  makeSilentLogger,
  makeTestResolver,
  mintTestTurnId,
} from './testHelpers';

const HOST_MARKER = 'Host capability instruction for the thread-capabilities test.';

function hostCapability(): AgentCapability {
  return {
    instructionBuilders: [builder => builder.addSection('host-marker', HOST_MARKER)],
  };
}

function threadInput() {
  return {
    spec: makeAgentSpec(),
    definition: { modelClient: makeMockILLM(), modelId: undefined, configuredModels: undefined },
    compactionModel: undefined,
    isChild: false,
    sandbox: undefined,
    sandboxAvailable: false,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  };
}

describe('threadCapabilities', () => {
  it('returns the spec builtins alone when the host adds no capabilities', () => {
    const builtinCount = builtinsFromSpec(threadInput()).length;
    expect(builtinCount).toBeGreaterThan(0);
    expect(threadCapabilities(threadInput())).toHaveLength(builtinCount);
    expect(threadCapabilities({ ...threadInput(), extraCapabilities: [] })).toHaveLength(builtinCount);
  });

  it('appends the host capabilities after the builtins, in the order given', () => {
    const builtinCount = builtinsFromSpec(threadInput()).length;
    const first = hostCapability();
    const second = hostCapability();

    const capabilities = threadCapabilities({ ...threadInput(), extraCapabilities: [first, second] });

    expect(capabilities).toHaveLength(builtinCount + 2);
    expect(capabilities[builtinCount]).toBe(first);
    expect(capabilities[builtinCount + 1]).toBe(second);
  });
});

describe('root turn capabilities (production path)', () => {
  it('sends the host capability to the model on a real chat turn', async () => {
    const tenant = 'tenant-1';
    const modelClient = makeMockILLM({
      create: jest.fn().mockImplementation(() => emptyLlmStream()),
    });
    const sessions = new Sessions({ sessionStore: new InMemorySessionStore() });
    const session = await sessions.create({
      tenant_id: tenant,
      session_id: 's1',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      agent: { type: 'inline', spec: makeAgentSpec() },
      external_id: null,
    });

    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeTestResolver({ modelClient, extraCapabilities: [hostCapability()] }),
    });
    for await (const _event of turn.stream()) {
      // drain to completion
    }

    expect(modelClient.create).toHaveBeenCalledTimes(1);
    const request = jest.mocked(modelClient.create).mock.calls[0]?.[0];
    const messages = JSON.stringify(request?.messages);
    expect(messages).toContain(HOST_MARKER);
    expect(messages).toContain('plain-speech');
  });
});
