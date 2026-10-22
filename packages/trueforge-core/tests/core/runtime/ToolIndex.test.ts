import { z } from 'zod';
import type { AgentCapability, CapabilityState } from '../../../src/core/capabilities/AgentCapability';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { estimateTokensForString } from '../../../src/core/llm/usage';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { createSentinelHostContext, defaultSentinelServices } from '../../../src/core/permissions/context';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import { TOOL_INDEX_GUIDE } from '../../../src/core/runtime/DeferredTool';
import { MAX_PROMOTED_TOOLS, TOOL_INDEX_STATE_KEY } from '../../../src/core/runtime/ToolIndex';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { builtInToolIndex } from '../fixtures/toolIndex';
import { finalAnswerStream, makeSilentLogger, unknownToolStream } from '../harnessMocks';

/** A small built-in tool set: notes are local, the map needs the network. */
class NoteTools extends LocalToolMCP {
  readonly name = 'notes';
  readonly displayName = 'Notes';
  readonly added: string[] = [];

  constructor() {
    super({ tracing: NOOP_AGENT_TRACING });
  }

  private readonly tools: ToolDefinition[] = [
    defineTool({
      name: 'add_note',
      description: 'Add one note to the list. Notes are kept for the whole chat.',
      schema: z.object({ text: z.string() }).strict(),
      handler: (input: { text: string }) => {
        this.added.push(input.text);
        return Promise.resolve(toolResultResponse({ text: 'added' }));
      },
    }),
    defineTool({
      name: 'render_map',
      description: 'Render an interactive map with a pin for a named place.',
      schema: z.object({ place_name: z.string() }).strict(),
      handler: () => Promise.resolve(toolResultResponse({ text: 'map' })),
    }),
  ];

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}

type Step = { name: string; args: Record<string, unknown> } | 'answer';

/** Runs one turn whose model makes the given calls in order, then answers. Returns every request it was sent. */
async function runTurn(input: {
  steps: Step[];
  notes?: NoteTools;
  capabilityState?: CapabilityState | undefined;
  offline?: boolean;
}): Promise<{ requests: LLMCreateParamsStreaming[]; thread: AgentThread; notes: NoteTools }> {
  const notes = input.notes ?? new NoteTools();
  const requests: LLMCreateParamsStreaming[] = [];
  const modelClient: ILLM = {
    create: jest.fn((request: LLMCreateParamsStreaming) => {
      requests.push(request);
      const step = input.steps[requests.length - 1] ?? 'answer';
      if (step === 'answer') {
        return finalAnswerStream();
      }
      return unknownToolStream({
        toolName: step.name,
        callId: `call-${String(requests.length)}`,
        args: JSON.stringify(step.args),
      });
    }),
    createNonStream: jest.fn(),
  };
  const capabilities: AgentCapability[] = [{ systemToolSets: [notes] }];
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    definition: { modelId: undefined, configuredModels: undefined, modelClient, instruction: 'test' },
    context: [{ role: 'user', content: 'Note that the boiler is fixed.' }],
    capabilities,
    capabilityState: input.capabilityState,
    sentinel:
      input.offline === true
        ? createSentinelHostContext({
            tenant_id: 't1',
            created_by: 'u1',
            conversation_id: 'c1',
            services: {
              ...defaultSentinelServices({ pinned_path: '/usr/bin:/bin' }),
              isOffline: () => Promise.resolve(true),
            },
          })
        : undefined,
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    void event;
  }
  return { requests, thread, notes };
}

function sentNames(request: LLMCreateParamsStreaming | undefined): string[] {
  return (request?.tools ?? []).flatMap(tool => (tool.type === 'function' ? [tool.function.name] : []));
}

function systemPrompt(request: LLMCreateParamsStreaming | undefined): string {
  const system = request?.messages.find(message => message.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

function toolResults(request: LLMCreateParamsStreaming | undefined): string[] {
  return (request?.messages ?? []).flatMap(message =>
    message.role === 'tool' && typeof message.content === 'string' ? [message.content] : [],
  );
}

describe('tool index', () => {
  it('lists every built-in tool by name only and sends just the always-loaded and lookup tools', async () => {
    const { requests } = await runTurn({ steps: ['answer'] });
    expect(sentNames(requests[0]).sort()).toEqual(
      ['call_tool', 'get_tool_info', 'get_tool_output_schema', 'list_tools'].sort(),
    );
    expect(systemPrompt(requests[0])).toContain(
      'notes:\n- add_note: Add one note to the list.\n- render_map: Render an interactive map with a pin for a named place.',
    );
  });

  it('keeps the guide that explains the index under 150 tokens', () => {
    expect(estimateTokensForString(TOOL_INDEX_GUIDE)).toBeLessThanOrEqual(150);
  });

  it('sends a tool in full once the chat looks it up, and saves that for the chat', async () => {
    const { requests, thread } = await runTurn({
      steps: [{ name: 'get_tool_info', args: { mcp_server: 'notes', tool_name: 'add_note' } }, 'answer'],
    });
    expect(sentNames(requests[0])).not.toContain('add_note');
    expect(sentNames(requests[1])).toContain('add_note');
    expect(sentNames(requests[1])).not.toContain('render_map');
    expect(thread.toSnapshot().capability_state).toEqual({ [TOOL_INDEX_STATE_KEY]: { promoted: ['add_note'] } });
  });

  it('runs a call_tool call of an indexed tool as a direct call and keeps the tool loaded', async () => {
    const { requests, thread, notes } = await runTurn({
      steps: [{ name: 'call_tool', args: { mcp_server: 'notes', tool_name: 'add_note', input: { text: 'boiler' } } }],
    });
    expect(notes.added).toEqual(['boiler']);
    expect(sentNames(requests[1])).toContain('add_note');
    const calls = thread
      .toSnapshot()
      .context.flatMap(message =>
        'role' in message && message.role === 'assistant' && 'tool_calls' in message ? (message.tool_calls ?? []) : [],
      );
    expect(calls.map(call => call.function)).toEqual([{ name: 'add_note', arguments: '{"text":"boiler"}' }]);
  });

  it('restores the promoted tools after a restart, and a new chat starts with none', async () => {
    const saved = (
      await runTurn({ steps: [{ name: 'get_tool_info', args: { mcp_server: 'notes', tool_name: 'add_note' } }] })
    ).thread.toSnapshot().capability_state;

    const restarted = await runTurn({ steps: ['answer'], capabilityState: saved ?? undefined });
    expect(sentNames(restarted.requests[0])).toContain('add_note');

    const newChat = await runTurn({ steps: ['answer'] });
    expect(sentNames(newChat.requests[0])).not.toContain('add_note');
  });

  it('keeps at most a bounded number of tools loaded, dropping the least recently used', async () => {
    const promoted = Array.from({ length: MAX_PROMOTED_TOOLS }, (_, i) => `gone_${String(i)}`);
    const { thread } = await runTurn({
      steps: [{ name: 'get_tool_info', args: { mcp_server: 'notes', tool_name: 'add_note' } }],
      capabilityState: { [TOOL_INDEX_STATE_KEY]: { promoted } },
    });
    const state = thread.toSnapshot().capability_state?.[TOOL_INDEX_STATE_KEY];
    expect(state).toEqual({ promoted: [...promoted.slice(1), 'add_note'] });
  });

  it('answers call_tool with wrong arguments with the tool schema and a plain correction', async () => {
    const { requests, notes } = await runTurn({
      steps: [{ name: 'call_tool', args: { mcp_server: 'notes', tool_name: 'add_note', input: { note: 'boiler' } } }],
    });
    expect(notes.added).toEqual([]);
    const [raw] = toolResults(requests[1]);
    const result = z.object({ result: z.object({ error: z.string() }) }).parse(JSON.parse(raw ?? '{}')).result.error;
    expect(result).toContain('The add_note call was not sent because some of its arguments were wrong');
    expect(result).toContain(
      'The arguments of add_note must match this schema: {"type":"object","properties":{"text":{"type":"string"}},"required":["text"],"additionalProperties":false}.',
    );
    expect(result).toContain('Call add_note directly by name with matching arguments.');
  });

  it('refuses a call through call_tool with the same plain message as the direct call', async () => {
    const direct = await runTurn({
      offline: true,
      steps: [{ name: 'render_map', args: { place_name: 'Lisbon' } }],
    });
    const wrapped = await runTurn({
      offline: true,
      steps: [
        { name: 'call_tool', args: { mcp_server: 'notes', tool_name: 'render_map', input: { place_name: 'Lisbon' } } },
      ],
    });
    const [directResult] = toolResults(direct.requests[1]);
    expect(directResult).toBeDefined();
    expect(toolResults(wrapped.requests[1])).toEqual([directResult]);
  });

  it('leaves tools withheld while offline out of the listing', async () => {
    const online = await runTurn({ steps: ['answer'] });
    expect(systemPrompt(online.requests[0])).toContain('- render_map:');
    // A built-in tool not reviewed as local counts as needing the network, so both drop out.
    const { requests } = await runTurn({ steps: ['answer'], offline: true });
    expect(systemPrompt(requests[0])).not.toContain('- render_map:');
    expect(systemPrompt(requests[0])).not.toContain('- add_note:');
  });

  it('summarizes each tool in one short sentence', async () => {
    const { index } = await builtInToolIndex([new NoteTools()]);
    expect(index.list().map(entry => entry.summary)).toEqual([
      'Add one note to the list.',
      'Render an interactive map with a pin for a named place.',
    ]);
  });
});
