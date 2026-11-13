/**
 * A scheduled run whose skill reaches for a site it never declared: the gateway refuses at once,
 * the refusal comes back as structured data on the tool result, and the runtime raises a network
 * card as a held action. The run finishes without waiting; the card waits for the owner, and
 * answering it records the answer and re-runs the command.
 */
import type { ITurnResourceResolver } from '../../src/agent-session/ITurnResourceResolver';
import { EventType } from '../../src/agent-session/schemas/events';
import { Sessions } from '../../src/agent-session/Sessions';
import { InMemorySessionStore } from '../../src/agent-session/store/InMemorySessionStore';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { CallToolResolvedResponse, ToolSource } from '../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../src/core/mcp/ToolSet';
import {
  createSentinelHostContext,
  defaultSentinelServices,
  type SentinelServices,
  type SkillNetworkAnswer,
  type Tier3SkillNetwork,
} from '../../src/core/permissions';
import type { AuditRecordInput } from '../../src/core/permissions/audit';
import { makeAgentSpec, makeMockILLM, makeTestResolver, mintTestTurnId } from './testHelpers';

const OWNER = { subject_id: 'user-1', subject_type: 'user' as const, subject_display_name: 'user-1' };
const REFUSAL_TEXT = 'uploads.example.com is not one of the sites approved for the skills in this chat.';

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* fetchStream(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const toolCalls = [
    { id: 'call-fetch', type: 'function' as const, function: { name: 'fetch_page', arguments: '{}' } },
  ];
  yield {
    id: 'chunk-fetch',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [
      {
        index: 0,
        delta: { role: 'assistant', tool_calls: toolCalls.map((call, index) => ({ index, ...call })) },
        finish_reason: 'tool_calls',
      },
    ],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: toolCalls },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
async function* textStream(
  text: string,
): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  yield {
    id: 'chunk-text',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: text }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: text }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

interface RecordedAnswer {
  skill_network: Tier3SkillNetwork;
  answer: SkillNetworkAnswer;
}

async function setup() {
  const answers: RecordedAnswer[] = [];
  const audit: AuditRecordInput[] = [];
  const services: SentinelServices = {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    skill_network_record_answer: input => {
      answers.push({ skill_network: input.skill_network, answer: input.answer });
      return Promise.resolve();
    },
    audit: {
      record: (input: AuditRecordInput) => {
        audit.push(input);
        return Promise.resolve();
      },
    },
  };
  // The fetch tool is a standing-granted closed-world read, so its calls run without asking and
  // the only card in this chat is the network one.
  await services.tool_grants.recordToolGrant({
    tenant_id: 't',
    created_by: OWNER.subject_id,
    mcp_server_name: 'fetcher',
    tool_name: 'fetch_page',
    connector_binding: null,
  });
  const refused: CallToolResolvedResponse = {
    result: { content: [{ type: 'text', text: REFUSAL_TEXT }], isError: true },
    wasInitialized: undefined,
    verificationReceiptCandidate: undefined,
    skillNetworkCards: [{ skill_name: 'ten-x', hosts: ['uploads.example.com'], reason: 'undeclared_host' }],
  };
  const callTool = jest.fn(() =>
    Promise.resolve<CallToolResolvedResponse>({
      result: { content: [{ type: 'text', text: 'the page' }] },
      wasInitialized: undefined,
      verificationReceiptCandidate: undefined,
    }),
  );
  callTool.mockResolvedValueOnce(refused);
  const source: ToolSource = {
    name: 'fetcher',
    id: 'fetcher',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: [
            {
              name: 'fetch_page',
              description: 'Fetch a page',
              inputSchema: { type: 'object' as const, properties: {} },
              annotations: { readOnlyHint: true, openWorldHint: false },
              preload: true,
            },
          ],
        },
        wasInitialized: undefined,
      }),
    callTool,
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        mcp_server_id: 'fetcher',
        mcp_server_name: 'fetcher',
        original_tool_name: params.name,
      }),
  };
  const create = jest.fn();
  create.mockImplementationOnce(() => fetchStream());
  create.mockImplementation(() => textStream('Night check done.'));
  const base = makeTestResolver({ modelClient: makeMockILLM({ create }) });
  const resolver: ITurnResourceResolver = {
    get logger() {
      return base.logger;
    },
    get webSearchTurn() {
      return base.webSearchTurn;
    },
    createTracing: () => base.createTracing(),
    resolveAgentSpec: input => base.resolveAgentSpec(input),
    resolveSandbox: input => base.resolveSandbox(input),
    resolveAgentDefinition: async input => {
      const resolved = await base.resolveAgentDefinition(input);
      const toolSet = new ToolSet({
        source,
        selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: undefined },
        preload: true,
        sentinel: createSentinelHostContext({
          tenant_id: input.tenant_id,
          created_by: input.created_by,
          conversation_id: input.session_id,
          services: input.sentinel_services,
        }),
      });
      return {
        ...resolved,
        extraCapabilities: [
          ...(resolved.extraCapabilities ?? []),
          {
            systemToolSets: [toolSet],
            preSendProcessors: undefined,
            preLLMProcessors: undefined,
            preLLMEphemeralProcessors: undefined,
            postToolCallProcessors: undefined,
            toolResponseProcessors: undefined,
            instructionBuilders: undefined,
          },
        ],
      };
    },
    close: () => base.close(),
  };
  const sessions = new Sessions({ sessionStore: new InMemorySessionStore(), sentinelServices: services });
  const session = await sessions.create({
    tenant_id: 't',
    session_id: 'nightly',
    created_by_subject: OWNER,
    agent: { type: 'inline', spec: makeAgentSpec() },
    external_id: 'run-1',
    source: { type: 'schedule', id: 'sched-1', run_id: 'run-1' },
  });
  const run = async (
    input: Parameters<typeof session.createTurn>[0]['input'],
    options: { unattended?: boolean } = {},
  ) => {
    const turn = await session.createTurn({
      turn_id: mintTestTurnId(),
      input,
      signal: new AbortController().signal,
      resolver,
      ...(options.unattended === true ? { unattended: true } : {}),
    });
    const events: unknown[] = [];
    for await (const event of turn.stream()) {
      events.push(event);
    }
    return { turn, events };
  };
  return { session, run, callTool, answers, audit };
}

function networkCardRef(events: unknown[]): { id: string; skill_network: Tier3SkillNetwork } {
  for (const event of events) {
    if (
      typeof event !== 'object' ||
      event === null ||
      Reflect.get(event, 'type') !== EventType.TOOL_APPROVAL_REQUIRED
    ) {
      continue;
    }
    const calls = Reflect.get(event, 'tool_calls');
    if (!Array.isArray(calls)) {
      continue;
    }
    for (const call of calls) {
      if (typeof call !== 'object' || call === null) {
        continue;
      }
      const card = Reflect.get(call, 'tier3_card');
      if (typeof card !== 'object' || card === null) {
        continue;
      }
      const question = Reflect.get(card, 'skill_network');
      const id = Reflect.get(call, 'id');
      if (question === null || typeof question !== 'object' || typeof id !== 'string') {
        continue;
      }
      const skillName = Reflect.get(question, 'skill_name');
      const hosts = Reflect.get(question, 'hosts');
      const reason = Reflect.get(question, 'reason');
      const codePin = Reflect.get(question, 'code_pin');
      if (
        typeof skillName === 'string' &&
        Array.isArray(hosts) &&
        hosts.every(host => typeof host === 'string') &&
        (reason === 'first_use' || reason === 'undeclared_host') &&
        (codePin === null || typeof codePin === 'string')
      ) {
        return { id, skill_network: { skill_name: skillName, hosts, reason, code_pin: codePin } };
      }
    }
  }
  throw new Error('No skill network card was raised.');
}

describe('a scheduled run that hits an undeclared site', () => {
  it('finishes without waiting, leaves the card for the owner, and re-runs the command on approval', async () => {
    const { session, run, callTool, answers, audit } = await setup();
    const night = await run([{ type: EventType.USER_MESSAGE, content: 'Nightly check' }], { unattended: true });

    // The run is done: it never paused on the card, and the command ran once and was refused.
    const finished = await session.getTurn(night.turn.id);
    expect(finished?.state).toMatchObject({ status: 'done', required_actions: [] });
    expect(callTool).toHaveBeenCalledTimes(1);

    // The card waits, naming the skill, the site, and that it was never declared.
    const ref = networkCardRef(night.events);
    expect(ref.skill_network).toEqual({
      skill_name: 'ten-x',
      hosts: ['uploads.example.com'],
      reason: 'undeclared_host',
      code_pin: null,
    });
    // Raising the card left its own audit row, and no answer is recorded yet.
    expect(audit.some(record => record.outcome === 'logged')).toBe(true);
    expect(answers).toEqual([]);

    // The owner answers in the morning: the answer is recorded, then the command runs again.
    const morning = await run([
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'main',
        tool_call_id: ref.id,
        approval: { status: 'allow' },
      },
    ]);
    expect((await session.getTurn(morning.turn.id))?.state.status).toBe('done');
    expect(answers).toEqual([
      {
        skill_network: {
          skill_name: 'ten-x',
          hosts: ['uploads.example.com'],
          reason: 'undeclared_host',
          code_pin: null,
        },
        answer: 'allow_once',
      },
    ]);
    expect(callTool).toHaveBeenCalledTimes(2);
  });
});
