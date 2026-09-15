import type { Logger } from 'winston';
import winston from 'winston';
import type { ILLM } from '../../src/core/llm/ILLM';
import type { ExtendedChatCompletionChunk, RawAssistantMessageWithUsage } from '../../src/core/llm/LLMTypes';
import { getEmptyUsage } from '../../src/core/llm/LLMTypes';
import type { AgentToolSchema, IToolSet, ListToolsResponse } from '../../src/core/mcp/IMCPServer';
import type { SandboxProvider } from '../../src/core/sandbox/provider/Provider';
import { Sandbox, type BoundRepository } from '../../src/core/sandbox/Sandbox';
import { NOOP_AGENT_TRACING } from '../../src/core/tracing/NoopAgentTracing';

export const OBJECT_INPUT_SCHEMA = { type: 'object' as const, properties: {} };

/** Minimal typed ILLM stub — both methods required by the interface. */
export function makeMockILLM(overrides: Partial<ILLM> = {}): ILLM {
  return {
    create: jest.fn(),
    createNonStream: jest.fn(),
    ...overrides,
  };
}

/**
 * Real Winston logger (silent). Prefer this over structural casts.
 * `child` is wired to return the same instance so spies on the root logger still fire.
 */
export function makeSilentLogger(): Logger {
  const logger = winston.createLogger({ silent: true, transports: [] });
  logger.child = () => logger;
  return logger;
}

export function makeMockIMCPServer(params: {
  name: string;
  preload: boolean;
  /** When set, overrides default `hasPreloadedTools` (defaults to `preload`). */
  hasPreloadedTools?: boolean | undefined;
  preloadTools?: string[] | undefined;
  tools?: AgentToolSchema[] | undefined;
}): IToolSet {
  return {
    name: params.name,
    id: params.name,
    preload: params.preload,
    hasPreloadedTools: params.hasPreloadedTools ?? params.preload,
    listTools: jest.fn((): Promise<ListToolsResponse> =>
      Promise.resolve({
        result: {
          tools: params.tools ?? [
            { name: 'tool_a', description: 'A', inputSchema: OBJECT_INPUT_SCHEMA, preload: params.preload },
          ],
        },
        wasInitialized: undefined,
      }),
    ),
    callTool: jest.fn(),
    toolCallInfo: jest.fn(),
  };
}

export function makeStubPublicSandbox(
  options: {
    boundRepository?: BoundRepository | undefined;
    exec?: SandboxProvider['exec'] | undefined;
  } = {},
): Sandbox {
  const provider: SandboxProvider = {
    type: 'test',
    buildImage: jest.fn(),
    getImageBuildStatus: jest.fn(),
    createSandbox: jest.fn(),
    exec: options.exec ?? jest.fn(),
    acknowledgeWorkspaceTermination: jest.fn(() => Promise.resolve()),
    executeVerifiedWorkspaceCommit: () =>
      Promise.resolve({ status: 'indeterminate', result: { success: false, error: 'not used by this fixture' } }),
    getAdditionalInstructions: () => undefined,
    getWorkspaceDir: () => undefined,
    getToolResultDumpDir: () => '/tmp/tool-results',
    getGitCredentialsPath: () => '/tmp/.git-credentials',
    getFileUploadsDir: () => '/tmp/uploads',
    getSkillsDir: () => '/opt/tfy/skills',
    getSkillDownloaderPath: () => '/opt/tfy/skill_downloader.py',
    downloadFile: jest.fn(),
    uploadFile: jest.fn(),
    createCodeModeTransport: jest.fn(),
  };
  return new Sandbox({
    provider,
    boundRepository: options.boundRepository,
    blockDestructiveToolsInCodeMode: true,
    mcpRequestTimeoutMs: 60_000,
    mcpConnectTimeoutMs: 5_000,
    logger: makeSilentLogger(),
    tracing: NOOP_AGENT_TRACING,
  });
}

/**
 * Streamed assistant turn that calls a single (typically unknown) tool. The
 * generator's return value is authoritative for admission and the runtime
 * guards; the yielded chunk mirrors it as a provisional streaming delta.
 * Shared so runtime tests do not each re-declare a drifting local copy.
 */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
export async function* unknownToolStream({
  toolName,
  callId,
}: {
  toolName: string;
  callId: string;
}): AsyncGenerator<ExtendedChatCompletionChunk, RawAssistantMessageWithUsage, unknown> {
  const call = {
    id: callId,
    type: 'function' as const,
    function: { name: toolName, arguments: '{}' },
  };
  yield {
    id: `chunk-${callId}`,
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, ...call }] }, finish_reason: null }],
  };
  return {
    output: { role: 'assistant', content: null, tool_calls: [call] },
    usage: getEmptyUsage(),
    finish_reason: 'tool_calls',
  };
}

/** Streamed assistant turn that ends the conversation with a final answer. */
// eslint-disable-next-line @typescript-eslint/require-await -- async generator fixture, not awaiting I/O
export async function* finalAnswerStream(): AsyncGenerator<
  ExtendedChatCompletionChunk,
  RawAssistantMessageWithUsage,
  unknown
> {
  yield {
    id: 'chunk-final',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta: { role: 'assistant', content: 'done' }, finish_reason: 'stop' }],
  };
  return {
    output: { role: 'assistant', content: 'done' },
    usage: getEmptyUsage(),
    finish_reason: 'stop',
  };
}

/** Extract `mcp server: <name>` labels from an LLM tools array (public create() body). */
export function mcpServerNamesFromTools(tools: unknown): string[] {
  if (!Array.isArray(tools)) {
    return [];
  }
  const names: string[] = [];
  for (const tool of tools) {
    if (!tool || typeof tool !== 'object' || !('function' in tool)) {
      continue;
    }
    const fn = (tool as { function?: unknown }).function;
    if (!fn || typeof fn !== 'object' || !('description' in fn)) {
      continue;
    }
    const description = (fn as { description?: unknown }).description;
    if (typeof description !== 'string') {
      continue;
    }
    const match = /^mcp server: ([^\n]+)/.exec(description);
    const serverName = match?.[1];
    if (serverName !== undefined && !names.includes(serverName)) {
      names.push(serverName);
    }
  }
  return names;
}
