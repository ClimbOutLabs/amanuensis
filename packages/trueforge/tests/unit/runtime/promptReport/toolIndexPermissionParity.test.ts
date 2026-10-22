/**
 * Every tool of a personal instance, called directly and through call_tool, must get the same
 * permission decision: the same tier and reason, the same card, the same hold or refusal, and the
 * same audit rows naming the real tool. Run online (cards and silent runs) and offline (refusals).
 */
import { AgentThread } from '@truefoundry/trueforge-core/core';
import { CALDAV_SERVER_NAME, CALDAV_TOOL_NAMES } from '@truefoundry/trueforge-core/core/calendar/caldav/toolContract';
import type { AgentCapability } from '@truefoundry/trueforge-core/core/capabilities/AgentCapability';
import {
  MAIL_CONNECTOR_NAME,
  MAIL_CONNECTOR_TOOL_NAMES,
} from '@truefoundry/trueforge-core/core/email/mailConnector/toolContract';
import type { ILLM, LLMCreateParamsStreaming } from '@truefoundry/trueforge-core/core/llm/ILLM';
import {
  getEmptyUsage,
  type ExtendedChatCompletionChunk,
  type InternalToolCallInfo,
  type RawAssistantMessageWithUsage,
} from '@truefoundry/trueforge-core/core/llm/LLMTypes';
import { convertMCPServersToTools } from '@truefoundry/trueforge-core/core/mcp/convertMCPServers';
import { toolResultResponse, type IToolSet, type ToolSource } from '@truefoundry/trueforge-core/core/mcp/IMCPServer';
import { ToolSet } from '@truefoundry/trueforge-core/core/mcp/ToolSet';
import type { AuditRecordInput } from '@truefoundry/trueforge-core/core/permissions/audit';
import { defaultSentinelServices, type SentinelServices } from '@truefoundry/trueforge-core/core/permissions/context';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { isRecord } from '@truefoundry/trueforge-core/core/util/records';
import { createLogger } from 'winston';
import { buildPersonalInstance, type PersonalInstance } from '../../../../src/runtime/promptReport/personalInstance';

type Mode = 'online' | 'offline';

interface ToolRow {
  /** The name the model calls the tool by, as the index lists it. */
  name: string;
  server: string;
  args: Record<string, unknown>;
}

/** Arguments that make a call worth judging, where a placeholder would only test the schema check. */
const ARGS: Record<string, Record<string, unknown>> = {
  exec: { command: 'rm -rf ~/Documents', cwd: '/workspace', intent: 'Clear old files', purpose: 'execute' },
  send_email: { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works.' },
  tavily_search: { query: 'opening hours Lisbon aquarium' },
  render_places: {
    places: [
      { name: 'Oceanário de Lisboa', address: 'Esplanada Dom Carlos I', source_url: 'https://www.oceanario.pt/' },
    ],
  },
};

/** A first-party connector as the host mounts it, with simple string arguments for every tool. */
function connector(input: { name: string; tools: readonly string[]; instance: PersonalInstance }): ToolSet {
  const source: ToolSource = {
    name: input.name,
    id: input.name,
    serverHost: 'localhost',
    listTools: () =>
      Promise.resolve({
        result: {
          tools: input.tools.map(tool => ({
            name: tool,
            description: `${tool} on ${input.name}.`,
            inputSchema: { type: 'object' as const, properties: { id: { type: 'string' } }, required: ['id'] },
            preload: true,
          })),
        },
        wasInitialized: undefined,
      }),
    callTool: () => Promise.resolve(toolResultResponse({ text: '{}' })),
    toolCallInfo: params =>
      Promise.resolve({
        type: 'mcp',
        original_tool_name: params.name,
        mcp_server_id: input.name,
        mcp_server_name: input.name,
        is_approval_required: false,
      }),
  };
  return new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [] },
    preload: true,
    sentinel: input.instance.sentinel,
    firstParty: true,
  });
}

function sentinelServices(input: { mode: Mode; audit: AuditRecordInput[] }): SentinelServices {
  return {
    ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
    audit: {
      record: row => {
        input.audit.push(row);
        return Promise.resolve();
      },
    },
    isOffline: () => Promise.resolve(input.mode === 'offline'),
  };
}

/** The instance with Gmail and Calendar writes, plus the Email and CalDAV connectors. */
async function instanceFor(input: { mode: Mode; audit: AuditRecordInput[] }) {
  const instance = await buildPersonalInstance({
    name: 'personal-with-google',
    googleAccess: 'read_and_write',
    sentinelServices: sentinelServices(input),
  });
  const connectors = [
    connector({ name: MAIL_CONNECTOR_NAME, tools: MAIL_CONNECTOR_TOOL_NAMES, instance }),
    connector({ name: CALDAV_SERVER_NAME, tools: CALDAV_TOOL_NAMES, instance }),
  ];
  return {
    ...instance,
    definition: { ...instance.definition, toolSets: [...(instance.definition.toolSets ?? []), ...connectors] },
  };
}

/** A plausible value for one argument schema: the first choice, a short text, the smallest number. */
function sampleValue(schema: unknown): unknown {
  if (!isRecord(schema)) {
    return 'x';
  }
  const options = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(options) && options.length > 0) {
    return sampleValue(options[0]);
  }
  if (Array.isArray(schema['enum']) && schema['enum'].length > 0) {
    return schema['enum'][0];
  }
  switch (schema['type']) {
    case 'object':
      return sampleArgs(schema);
    case 'array':
      return [sampleValue(schema['items'])];
    case 'integer':
    case 'number':
      return typeof schema['minimum'] === 'number' ? schema['minimum'] : 1;
    case 'boolean':
      return false;
    default:
      return schema['format'] === 'date-time' ? '2026-11-02T09:00:00Z' : 'Lisbon';
  }
}

function sampleArgs(schema: Record<string, unknown>): Record<string, unknown> {
  const properties = isRecord(schema['properties']) ? schema['properties'] : {};
  const required = Array.isArray(schema['required']) ? schema['required'] : [];
  return Object.fromEntries(
    required.flatMap(key => (typeof key === 'string' ? [[key, sampleValue(properties[key])]] : [])),
  );
}

/** Every tool the thread offers, named as the model sees it, with arguments for one call. */
async function toolTable(): Promise<ToolRow[]> {
  const instance = await instanceFor({ mode: 'online', audit: [] });
  const builtIns: IToolSet[] = [
    ...instance.capabilities.flatMap(capability => capability.systemToolSets ?? []),
    instance.sandbox,
  ];
  const { convertedTools } = await convertMCPServersToTools({
    tfyManagedServers: builtIns,
    userServers: [...(instance.definition.toolSets ?? [])],
  });
  return convertedTools.tools.flatMap(tool => {
    if (tool.type !== 'function') {
      return [];
    }
    const mapped = convertedTools.toolMapping.get(tool.function.name);
    if (mapped === undefined) {
      return [];
    }
    return [
      {
        name: tool.function.name,
        server: mapped.toolSet.name,
        args: ARGS[mapped.originalToolName] ?? sampleArgs(tool.function.parameters ?? {}),
      },
    ];
  });
}

async function* oneCall(input: {
  name: string;
  arguments: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  const call = { id: 'call-1', type: 'function' as const, function: input };
  yield {
    id: 'chunk-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'parity',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

async function* answer(): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  yield {
    id: 'chunk-2',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'parity',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

interface Judged {
  name: string;
  decision: Omit<InternalToolCallInfo, 'approval_token_id'>;
  audit: AuditRecordInput[];
  /** What the model was told, when the call resolved in this turn. */
  result: string | undefined;
}

/** Runs one turn whose model makes exactly this call, and reads back how the call was judged. */
async function judge(input: { mode: Mode; name: string; args: Record<string, unknown> }): Promise<Judged> {
  const audit: AuditRecordInput[] = [];
  const instance = await instanceFor({ mode: input.mode, audit });
  const requests: LLMCreateParamsStreaming[] = [];
  const modelClient: ILLM = {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      return requests.length === 1 ? oneCall({ name: input.name, arguments: JSON.stringify(input.args) }) : answer();
    }),
    createNonStream: jest.fn(),
  };
  const capabilities: AgentCapability[] = instance.capabilities;
  const thread = new AgentThread({
    definition: { ...instance.definition, modelClient },
    threadId: 'main',
    title: 'Main',
    sandbox: instance.sandbox,
    capabilities,
    context: [{ role: 'user', content: 'Go ahead.' }],
    sentinel: instance.sentinel,
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: createLogger({ silent: true }),
  });
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    void event;
  }
  const calls = thread
    .toSnapshot()
    .context.flatMap(message =>
      'role' in message && message.role === 'assistant' && 'tool_calls' in message ? (message.tool_calls ?? []) : [],
    );
  const call = calls[0];
  if (call === undefined || calls.length !== 1) {
    throw new Error(`expected exactly one judged call for ${input.name}`);
  }
  const { approval_token_id, ...decision } = call.tool_info;
  void approval_token_id;
  const result = requests[1]?.messages.flatMap(message =>
    message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [],
  )[0];
  // Clock readings differ between two runs; nothing else in a result may.
  const timeless = result
    ?.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/"unixEpochMS":\d+/g, '"unixEpochMS":0');
  return { name: call.function.name, decision, audit, result: timeless };
}

describe('the same permission decision for every tool, called directly or through call_tool', () => {
  let table: ToolRow[] = [];

  beforeAll(async () => {
    // No test may reach Google or any other service: every outbound request fails at once, the same way both times.
    jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('No network in tests.'));
    table = await toolTable();
  });

  afterAll(() => {
    jest.restoreAllMocks();
  });

  it('covers every built-in tool family and both first-party connectors', () => {
    const servers = new Set(table.map(row => row.server));
    for (const server of [
      'google_calendar',
      'gmail',
      'maps',
      'web-search',
      'sandbox',
      'space',
      'schedules',
      'documents',
      'sub_agents',
      'usage',
      'ask-user-question',
      'current-datetime',
      CALDAV_SERVER_NAME,
      MAIL_CONNECTOR_NAME,
    ]) {
      expect(servers).toContain(server);
    }
    expect(table.map(row => row.name)).toEqual(expect.arrayContaining(['summarize_net_worth', 'usage_summary']));
    expect(table.length).toBeGreaterThanOrEqual(55);
  });

  it.each<Mode>(['online', 'offline'])(
    'judges each tool the same both ways while %s',
    async mode => {
      const differences: { tool: string; direct: Judged; wrapped: Judged }[] = [];
      const judged: Judged[] = [];
      for (const row of table) {
        const direct = await judge({ mode, name: row.name, args: row.args });
        judged.push(direct);
        const wrapped = await judge({
          mode,
          name: 'call_tool',
          args: { mcp_server: row.server, tool_name: row.name, input: row.args },
        });
        if (JSON.stringify(wrapped) !== JSON.stringify(direct)) {
          differences.push({ tool: row.name, direct, wrapped });
        }
        expect(wrapped.audit.map(audited => audited.tool_name)).not.toContain('call_tool');
      }
      expect(differences).toEqual([]);
      // The table holds the cases that matter, so equal decisions are not equal by being empty.
      expect(judged.some(entry => entry.decision.tier === 3 && entry.decision.tier3_card !== null)).toBe(true);
      expect(judged.some(entry => entry.decision.tier === 1)).toBe(true);
      expect(judged.some(entry => entry.audit.length > 0)).toBe(true);
      if (mode === 'offline') {
        expect(judged.some(entry => entry.audit.some(row => row.outcome === 'auto_denied'))).toBe(true);
      }
    },
    600_000,
  );
});
