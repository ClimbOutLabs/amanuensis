import {
  currentDateTime,
  GET_CURRENT_DATETIME_TOOL_NAME,
} from '../../../src/core/capabilities/builtins/CurrentDateTime';
import { EventType } from '../../../src/core/events/schema';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { ToolSet } from '../../../src/core/mcp/ToolSet';
import { SANDBOX_FILE_WRITE_TOOLS } from '../../../src/core/permissions/dispatch';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { AgentThreadOrchestrator } from '../../../src/core/runtime/AgentThreadOrchestrator';
import {
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  type Sandbox,
} from '../../../src/core/sandbox/Sandbox';
import {
  AMAN_SOURCES_TOOL_NAME,
  amanSourcePrefixes,
  AmanSourcesSource,
} from '../../../src/core/search/AmanSourcesSource';
import { TavilyClient } from '../../../src/core/search/TavilyClient';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { llmCreateInputs, runTurn, textReplyStream } from '../../orchestration/helpers/helpers';
import { makeSilentLogger, makeStubPublicSandbox } from '../harnessMocks';

const SANDBOX_TOOL_NAMES = [
  SANDBOX_EXEC_TOOL_NAME,
  SANDBOX_RUN_CODE_TOOL_NAME,
  SANDBOX_APPLY_PATCH_TOOL_NAME,
  SANDBOX_REPLACE_TEXT_TOOL_NAME,
];

function guideSearchToolSet(): IToolSet {
  const client = new TavilyClient({
    auth: { kind: 'keyless' },
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify({ results: [], images: [] }))),
  });
  const source = new AmanSourcesSource({
    id: 'aman-sources',
    name: 'Aman sources',
    client,
    prefixes: amanSourcePrefixes({}),
  });
  return new ToolSet({
    source,
    selectors: { enableTools: ['@all'], disableTools: [], preloadTools: [], requireApprovalForTools: [] },
    preload: true,
    searchProvider: { tools: [AMAN_SOURCES_TOOL_NAME], plumbing_fields: [] },
  });
}

function threadFor({
  readOnly,
  sandbox,
  withheldTools,
  guideSearchToolSet,
}: {
  readOnly: boolean;
  sandbox?: Sandbox | undefined;
  withheldTools?: readonly string[] | undefined;
  guideSearchToolSet?: IToolSet | undefined;
}) {
  const modelClient = {
    create: jest.fn().mockImplementation(() => textReplyStream('ok')),
    createNonStream: jest.fn(),
  };
  const thread = new AgentThread({
    definition: {
      modelClient,
      instruction: 'You are a test.',
      messages: undefined,
      modelParams: undefined,
      responseFormat: undefined,
      iterationLimit: undefined,
      toolSets: undefined,
      modelId: undefined,
      configuredModels: undefined,
      readOnly,
      guideSearchToolSet,
    },
    threadId: 'thread_read_only',
    title: 'read-only',
    parent: undefined,
    agentInfo: undefined,
    context: undefined,
    currentContextUsage: undefined,
    preComputedCompletion: undefined,
    sandbox,
    capabilities: [currentDateTime({ tracing: NOOP_AGENT_TRACING })],
    capabilityState: undefined,
    toolCallMemo: undefined,
    turnToolCallLedger: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    withheldTools,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  const orchestrator = new AgentThreadOrchestrator({
    agentThreads: new Map([[thread.threadId, thread]]),
    createDynamicSubAgentThread: jest.fn(),
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  return { modelClient, orchestrator };
}

describe('AgentThread read-only definitions', () => {
  it('offers the model no tools when the definition is read-only', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: true });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = llmCreateInputs(modelClient);
    expect(requests.length).toBeGreaterThan(0);
    for (const request of requests) {
      expect(JSON.stringify(request)).not.toContain(GET_CURRENT_DATETIME_TOOL_NAME);
    }
  });

  it('keeps the built-in tools when the definition is not read-only', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: false });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    expect(JSON.stringify(llmCreateInputs(modelClient))).toContain(GET_CURRENT_DATETIME_TOOL_NAME);
  });

  it('withholds sandbox tools from a read-only definition even when a sandbox is configured', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: true, sandbox: makeStubPublicSandbox() });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = JSON.stringify(llmCreateInputs(modelClient));
    for (const name of SANDBOX_TOOL_NAMES) {
      expect(requests).not.toContain(`"name":"${name}"`);
    }
  });

  it('offers the sandbox tools to a definition that is not read-only, so the check above is not vacuous', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: false, sandbox: makeStubPublicSandbox() });
    // Every sandbox tool is sent whatever the message says.
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'Run a quick script.' }] });
    const requests = JSON.stringify(llmCreateInputs(modelClient));
    expect(requests).toContain(`"name":"${SANDBOX_RUN_CODE_TOOL_NAME}"`);
  });

  it('offers a read-only definition its one guide search tool, and no other tool', async () => {
    const { modelClient, orchestrator } = threadFor({ readOnly: true, guideSearchToolSet: guideSearchToolSet() });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = llmCreateInputs(modelClient);
    expect(requests.length).toBeGreaterThan(0);
    const joined = JSON.stringify(requests);
    expect(joined).toContain(`"name":"${AMAN_SOURCES_TOOL_NAME}"`);
    expect(joined).not.toContain(GET_CURRENT_DATETIME_TOOL_NAME);
    for (const name of SANDBOX_TOOL_NAMES) {
      expect(joined).not.toContain(`"name":"${name}"`);
    }
  });

  it('leaves out the sandbox tools a run withholds and keeps the read and other tools', async () => {
    const { modelClient, orchestrator } = threadFor({
      readOnly: false,
      sandbox: makeStubPublicSandbox(),
      withheldTools: [...SANDBOX_FILE_WRITE_TOOLS],
    });
    await runTurn({ orchestrator, sendBatch: [{ type: EventType.USER_MESSAGE, content: 'hello' }] });
    const requests = JSON.stringify(llmCreateInputs(modelClient));
    for (const name of SANDBOX_FILE_WRITE_TOOLS) {
      expect(requests).not.toContain(`"name":"${name}"`);
    }
    expect(requests).toContain(`"name":"${SANDBOX_EXEC_TOOL_NAME}"`);
    expect(requests).toContain(`"name":"${SANDBOX_RUN_CODE_TOOL_NAME}"`);
    expect(requests).toContain(GET_CURRENT_DATETIME_TOOL_NAME);
  });
});
