import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import { TurnResourceResolver } from '../../src/agent-session/TurnResourceResolver';
import { emptyLlmStream, makeAgentSpec, makeMockILLM, makeSilentLogger, mintTestTurnId } from './testHelpers';

const MAIN_MODEL = 'test-provider/main-model';
const COMPACTION_MODEL = 'test-provider/compaction-model';

describe('auxiliary_models.compaction wiring', () => {
  it('fails visibly — never falls back to the main model — when the configured compaction model is unavailable', async () => {
    const resolver = new TurnResourceResolver({
      llm: name => {
        if (name === MAIN_MODEL) {
          return Promise.resolve({
            modelClient: makeMockILLM(),
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          });
        }
        // Same convention as getModelDetails (packages/trueforge/src/runtime/sessionResources.ts):
        // an unconfigured model rejects with an attributable message, not a silent substitution.
        return Promise.reject(new Error(`Unknown model "${name}" — not configured on provider`));
      },
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });
    const spec = makeAgentSpec({
      model: { name: MAIN_MODEL },
      auxiliary_models: { compaction: { name: COMPACTION_MODEL } },
      config: { context_management: { compaction: { enabled: true } } },
    });

    await expect(
      resolver.resolveAgentDefinition({
        spec,
        signal: new AbortController().signal,
        tracing: resolver.createTracing(),
        tenant_id: 'test-tenant',
        created_by: 'test-user',
        session_id: 'test-session',
      }),
    ).rejects.toThrow(`Unknown model "${COMPACTION_MODEL}" — not configured on provider`);
  });

  it('does not resolve (or fail on) an unavailable compaction override when compaction is disabled — an unused role must never block the turn', async () => {
    const resolver = new TurnResourceResolver({
      llm: name => {
        if (name === MAIN_MODEL) {
          return Promise.resolve({
            modelClient: makeMockILLM(),
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          });
        }
        return Promise.reject(new Error(`Unknown model "${name}" — not configured on provider`));
      },
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
    });
    const spec = makeAgentSpec({
      model: { name: MAIN_MODEL },
      auxiliary_models: { compaction: { name: COMPACTION_MODEL } },
      config: { context_management: { compaction: { enabled: false } } },
    });

    const { compactionModel } = await resolver.resolveAgentDefinition({
      spec,
      signal: new AbortController().signal,
      tracing: resolver.createTracing(),
      tenant_id: 'test-tenant',
      created_by: 'test-user',
      session_id: 'test-session',
    });
    expect(compactionModel).toBeUndefined();
  });

  it('injects a no-sandbox repository binding into the first ordinary prompt with compaction disabled', async () => {
    const mainClient = makeMockILLM({
      create: jest.fn().mockImplementation(() => emptyLlmStream()),
    });
    const makeResolver = () =>
      new TurnResourceResolver({
        llm: () =>
          Promise.resolve({
            modelClient: mainClient,
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          }),
        mcp: () => Promise.reject(new Error('unused')),
        mcpRequestTimeoutMs: 1_000,
        mcpConnectTimeoutMs: 1_000,
        logger: makeSilentLogger(),
        boundRepository: {
          repository_id: 'ordinary-no-sandbox-repository',
          revision: 3,
          workspace_cwd: 'C:\\ordinary\\no-sandbox',
          commands: [
            {
              command_id: 'focused-tests',
              purpose: 'test',
              command: 'pnpm test --filter focused',
              timeout_ms: 120_000,
            },
            {
              command_id: 'verify',
              purpose: 'verify',
              command: 'pnpm verify',
              timeout_ms: 900_000,
            },
          ],
        },
      });
    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 's-ordinary-binding',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          model: { name: MAIN_MODEL },
          config: { context_management: { compaction: { enabled: false } } },
        }),
      },
    });

    const firstTurnId = mintTestTurnId();
    const turn = await session.createTurn({
      turn_id: firstTurnId,
      input: [{ type: EventType.USER_MESSAGE, content: 'continue the task' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver: makeResolver(),
    });
    for await (const _event of turn.stream()) {
      // drain to completion
    }

    expect(mainClient.createNonStream).not.toHaveBeenCalled();
    expect(mainClient.create).toHaveBeenCalledTimes(1);
    const request = jest.mocked(mainClient.create).mock.calls[0]?.[0];
    const messages = JSON.stringify(request?.messages);
    expect(messages).toContain('repository_id: ordinary-no-sandbox-repository');
    expect(messages).toContain('repository_revision: 3');
    expect(messages).toContain('workspace_cwd: C:\\\\ordinary\\\\no-sandbox');
    expect(messages).toContain('branch: unavailable');
    expect(messages).toContain('head_sha: unavailable');
    expect(messages).toContain('command_id: focused-tests');
    expect(messages).toContain('purpose: test');
    expect(messages).toContain('command: pnpm test --filter focused');
    expect(messages).toContain('timeout_ms: 120000');
    expect(messages).toContain('command_id: verify');
    expect(messages).toContain('command: pnpm verify');

    const secondTurnId = mintTestTurnId();
    const resumed = await session.createTurn({
      turn_id: secondTurnId,
      input: [{ type: EventType.USER_MESSAGE, content: 'continue after rebuild' }],
      previous_turn_id: 'auto',
      signal: new AbortController().signal,
      resolver: makeResolver(),
    });
    for await (const _event of resumed.stream()) {
      // drain to completion
    }

    expect(mainClient.create).toHaveBeenCalledTimes(2);
    const resumedRequest = jest.mocked(mainClient.create).mock.calls[1]?.[0];
    const resumedMessages = JSON.stringify(resumedRequest?.messages);
    expect(resumedMessages.split('Host-bound repository state (authoritative').length - 1).toBe(1);
    expect(resumedMessages).toContain('branch: unavailable');
    expect(resumedMessages).toContain('head_sha: unavailable');
    expect(resumedMessages.split('command_id: focused-tests').length - 1).toBe(1);
    expect(resumedMessages.split('command_id: verify').length - 1).toBe(1);
    const persisted = await store.getTurn({ session_id: 's-ordinary-binding', turn_id: secondTurnId });
    const persistedContext = JSON.stringify(persisted?.snapshot.threads['main']?.context);
    expect(persistedContext).not.toContain('Host-bound repository state (authoritative');
  });

  it('keeps the compaction call and the main chat call on independent models within one turn', async () => {
    const mainClient = makeMockILLM({
      create: jest.fn().mockImplementation(() => emptyLlmStream()),
    });
    const compactionClient = makeMockILLM({
      createNonStream: jest.fn().mockResolvedValue({
        output: {
          role: 'assistant',
          content: `<summary>
## goal
Continue the existing coding task.
## done_so_far
packages/trueforge-core/tests/agent-session/compactionModelRole.test.ts
## user_request
hello
## workspace
No workspace details observed.
## findings
No findings recorded yet.
## in_flight_work
Running the turn.
## remaining_work
Continue the current turn with the next step.
## current_blocker
none
## bound_repository_state
host supplied state
</summary>`,
        },
        usage: { input_tokens: 5, output_tokens: 5, total_tokens: 10 },
        finish_reason: 'stop',
      }),
    });

    const resolver = new TurnResourceResolver({
      llm: name => {
        if (name === MAIN_MODEL) {
          return Promise.resolve({
            modelClient: mainClient,
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          });
        }
        if (name === COMPACTION_MODEL) {
          return Promise.resolve({
            modelClient: compactionClient,
            defaultModelParams: {},
            modelId: undefined,
            modelSupportsVision: false,
          });
        }
        return Promise.reject(new Error(`unexpected model lookup: ${name}`));
      },
      mcp: () => Promise.reject(new Error('unused')),
      mcpRequestTimeoutMs: 1_000,
      mcpConnectTimeoutMs: 1_000,
      logger: makeSilentLogger(),
      boundRepository: {
        repository_id: 'resolved-no-sandbox-repository',
        revision: 12,
        workspace_cwd: 'C:\\resolved\\no-sandbox',
        commands: [],
      },
    });

    const store = new InMemorySessionStore();
    const sessions = new Sessions({ sessionStore: store });
    const session = await sessions.create({
      tenant_id: 'tenant-1',
      session_id: 's-compaction',
      created_by_subject: { subject_id: 'user-1', subject_type: 'user', subject_display_name: 'user-1' },
      external_id: null,
      agent: {
        type: 'inline',
        spec: makeAgentSpec({
          model: { name: MAIN_MODEL },
          auxiliary_models: { compaction: { name: COMPACTION_MODEL } },
          // threshold 1: the compaction system prompt alone trips the check on
          // the turn's very first LLM step, so compaction and the main chat
          // call are guaranteed to both run inside this one turn.
          config: {
            context_management: { compaction: { enabled: true, trigger: { type: 'input_tokens', value: 1 } } },
          },
        }),
      },
    });

    const turnId = mintTestTurnId();
    const turn = await session.createTurn({
      turn_id: turnId,
      input: [{ type: EventType.USER_MESSAGE, content: 'hello' }],
      previous_turn_id: 'none',
      signal: new AbortController().signal,
      resolver,
    });
    for await (const _event of turn.stream()) {
      // drain to completion
    }
    expect(turn.state.status).toBe('done');

    // Compaction ran on the compaction model, not the main model...
    expect(compactionClient.createNonStream).toHaveBeenCalledTimes(1);
    expect(mainClient.createNonStream).not.toHaveBeenCalled();
    // ...and the main chat call still ran on the main model, not the compaction model.
    expect(mainClient.create).toHaveBeenCalledTimes(1);
    expect(compactionClient.create).not.toHaveBeenCalled();

    const compactionBody = jest.mocked(compactionClient.createNonStream).mock.calls[0]?.[0];
    expect(JSON.stringify(compactionBody?.messages)).toContain('repository_id: resolved-no-sandbox-repository');
    const mainBody = jest.mocked(mainClient.create).mock.calls[0]?.[0];
    const mainMessages = JSON.stringify(mainBody?.messages);
    expect(mainMessages.split('repository_id: resolved-no-sandbox-repository').length - 1).toBe(1);
    expect(mainMessages.split('Host-bound repository state (authoritative').length - 1).toBe(1);
    const persisted = await store.getTurn({ session_id: 's-compaction', turn_id: turnId });
    expect(JSON.stringify(persisted?.snapshot.threads['main']?.context)).toContain(
      'repository_id: resolved-no-sandbox-repository',
    );
    expect(JSON.stringify(persisted?.snapshot.threads['main']?.context)).not.toContain(
      'Host-bound repository state (authoritative',
    );
    expect(JSON.stringify(persisted?.snapshot.threads['main']?.context)).not.toContain(
      'There is no repository binding for this session',
    );
  });
});
