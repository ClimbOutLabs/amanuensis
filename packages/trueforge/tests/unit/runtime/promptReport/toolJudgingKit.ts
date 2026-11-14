/** Runs one tool call of a personal instance through a real thread and reads back how it was judged. */
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
import type { ToolBundleName } from '@truefoundry/trueforge-core/core/runtime/toolBundleCatalog';
import { LOAD_BUNDLE_TOOL_NAME } from '@truefoundry/trueforge-core/core/runtime/ToolBundles';
import { NOOP_AGENT_TRACING } from '@truefoundry/trueforge-core/core/tracing/NoopAgentTracing';
import { isRecord } from '@truefoundry/trueforge-core/core/util/records';
import { createLogger } from 'winston';
import { buildPersonalInstance, type PersonalInstance } from '../../../../src/runtime/promptReport/personalInstance';

export type Mode = 'online' | 'offline';

export type Loading = 'direct' | 'load_bundle';

export interface ToolRow {
  /** The name the model calls the tool by. */
  name: string;
  server: string;
  /** Undefined for a tool sent on every request. */
  bundle: ToolBundleName | undefined;
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
    bundle: 'google',
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

/** Every tool the thread offers, named as the model sees it, with its bundle and arguments for one call. */
export async function toolTable(): Promise<ToolRow[]> {
  const instance = await instanceFor({ mode: 'online', audit: [] });
  const builtIns: IToolSet[] = [
    ...instance.capabilities.flatMap(capability => capability.systemToolSets ?? []),
    ...(instance.sandbox === undefined ? [] : [instance.sandbox]),
  ];
  const { convertedTools } = await convertMCPServersToTools({
    tfyManagedServers: builtIns,
    userServers: [...instance.definition.toolSets],
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
        bundle: mapped.toolSet.bundleOf?.(mapped.originalToolName),
        args: ARGS[mapped.originalToolName] ?? sampleArgs(tool.function.parameters ?? {}),
      },
    ];
  });
}

async function* oneCall(input: {
  id: string;
  name: string;
  arguments: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  await Promise.resolve();
  const call = { id: input.id, type: 'function' as const, function: { name: input.name, arguments: input.arguments } };
  yield {
    id: `chunk-${input.id}`,
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
    id: 'chunk-answer',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'parity',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return { output: { role: 'assistant', content: 'done' }, usage: getEmptyUsage(), finish_reason: 'stop' };
}

export interface Judged {
  name: string;
  decision: Omit<InternalToolCallInfo, 'approval_token_id'>;
  /** Audit rows naming the judged tool. */
  audit: AuditRecordInput[];
  /** What the model was told, when the call resolved in this turn. */
  result: string | undefined;
}

function sentNames(request: LLMCreateParamsStreaming | undefined): string[] {
  return (request?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []));
}

/**
 * Runs one turn whose model calls the tool, and reads back how the call was judged. The model either
 * calls it straight away or reads its bundle's guidance with load_bundle first; a tool in no bundle
 * is called after an unrelated read.
 */
export async function judge(input: { mode: Mode; row: ToolRow; loading: Loading }): Promise<{
  judged: Judged;
  load: InternalToolCallInfo | undefined;
  sentBefore: string[];
  sentAtCall: string[];
}> {
  const { row } = input;
  const audit: AuditRecordInput[] = [];
  const instance = await instanceFor({ mode: input.mode, audit });
  const bundle = row.bundle ?? 'extras';
  const steps =
    input.loading === 'load_bundle'
      ? [
          { id: 'load-1', name: LOAD_BUNDLE_TOOL_NAME, args: { name: bundle } },
          { id: 'call-1', name: row.name, args: row.args },
        ]
      : [{ id: 'call-1', name: row.name, args: row.args }];
  const requests: LLMCreateParamsStreaming[] = [];
  const modelClient: ILLM = {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      const step = steps[requests.length - 1];
      return step === undefined
        ? answer()
        : oneCall({ id: step.id, name: step.name, arguments: JSON.stringify(step.args) });
    }),
    createNonStream: jest.fn(),
  };
  const capabilities: AgentCapability[] = instance.capabilities;
  const thread = new AgentThread({
    definition: { ...instance.definition, modelClient },
    threadId: 'main',
    title: 'Main',
    turnToolCallLedger: undefined,
    sandbox: instance.sandbox,
    capabilities,
    context: [{ role: 'user', content: 'Go ahead.' }],
    capabilityState: undefined,
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
  const call = calls.find(candidate => candidate.id === 'call-1');
  if (call === undefined || calls.length !== steps.length) {
    throw new Error(`expected the judged call of ${row.name} after ${String(steps.length - 1)} load`);
  }
  const { approval_token_id, ...decision } = call.tool_info;
  void approval_token_id;
  const result = requests[steps.length]?.messages.flatMap(message =>
    message.role === 'tool' && message.tool_call_id === 'call-1' && typeof message.content === 'string'
      ? [message.content]
      : [],
  )[0];
  // Clock readings differ between two runs; nothing else in a result may.
  const timeless = result
    ?.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, '<time>')
    .replace(/"unixEpochMS":\d+/g, '"unixEpochMS":0')
    .replace(/"date":"\d{4}-\d{2}-\d{2}"/g, '"date":"<date>"')
    .replace(/"time":"\d{2}:\d{2}:\d{2}"/g, '"time":"<time>"');
  return {
    judged: {
      name: call.function.name,
      decision,
      audit: audit.filter(rowAudited => rowAudited.tool_name !== LOAD_BUNDLE_TOOL_NAME),
      result: timeless,
    },
    load: calls.find(candidate => candidate.id === 'load-1')?.tool_info,
    sentBefore: sentNames(requests[0]),
    sentAtCall: sentNames(requests[steps.length - 1]),
  };
}
