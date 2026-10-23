import { z } from 'zod';
import type { AgentCapability, CapabilityState } from '../../../src/core/capabilities/AgentCapability';
import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { estimateTokensForString } from '../../../src/core/llm/usage';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { findBundle, TOOL_BUNDLE_NAMES, type ToolBundleName } from '../../../src/core/runtime/toolBundleCatalog';
import { ToolBundles } from '../../../src/core/runtime/ToolBundles';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';
import { finalAnswerStream, makeSilentLogger, unknownToolStream } from '../harnessMocks';

/** A built-in tool set whose tools all go out with one bundle, or always when it names none. */
class Tools extends LocalToolMCP {
  readonly name: string;
  readonly displayName: string;
  protected override readonly bundle: ToolBundleName | undefined;
  readonly calls: string[] = [];
  private readonly tools: ToolDefinition[];

  constructor(input: { name: string; bundle: ToolBundleName | undefined; tools: string[] }) {
    super({ tracing: NOOP_AGENT_TRACING });
    this.name = input.name;
    this.displayName = input.name;
    this.bundle = input.bundle;
    this.tools = input.tools.map(tool =>
      defineTool({
        name: tool,
        description: `${tool} does one thing.`,
        schema: z.object({ text: z.string() }).strict(),
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: (args: { text: string }) => {
          this.calls.push(`${tool}:${args.text}`);
          return Promise.resolve(toolResultResponse({ text: 'done' }));
        },
      }),
    );
  }

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}

type Step = { name: string; args: Record<string, unknown> } | 'answer';

function toolSets() {
  return {
    core: new Tools({ name: 'clock', bundle: undefined, tools: ['what_time'] }),
    notes: new Tools({ name: 'space', bundle: 'spaces', tools: ['add_note', 'list_notes'] }),
    maps: new Tools({ name: 'maps', bundle: 'maps', tools: ['render_map'] }),
  };
}

function spacesSection(builder: InstructionBuilder): void {
  builder.addSection('spaces-guide', 'Spaces hold the notes the person keeps.');
}

/** Runs one turn whose model makes the given calls in order, then answers. Returns every request it was sent. */
async function runTurn(input: {
  steps: Step[];
  message?: string;
  history?: ContextMessage[];
  capabilityState?: CapabilityState | undefined;
}) {
  const sets = toolSets();
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
  const capabilities: AgentCapability[] = [
    { systemToolSets: [sets.core] },
    { systemToolSets: [sets.notes], instructionBuilders: [spacesSection], bundle: 'spaces' },
    { systemToolSets: [sets.maps] },
  ];
  const thread = new AgentThread({
    threadId: 'main',
    title: 'Main',
    turnToolCallLedger: undefined,
    definition: { modelId: undefined, configuredModels: undefined, modelClient, instruction: 'test' },
    context: [...(input.history ?? []), { role: 'user', content: input.message ?? 'Thanks!' }],
    capabilities,
    capabilityState: input.capabilityState,
    toolCallMemo: undefined,
    taskState: undefined,
    isRequestContinuation: undefined,
    tracing: NOOP_AGENT_TRACING,
    logger: makeSilentLogger(),
  });
  for await (const event of thread.execute({ signal: new AbortController().signal })) {
    void event;
  }
  return { requests, thread, sets };
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

/** The per-reply block: every system message after the system prompt. */
function replyBlock(request: LLMCreateParamsStreaming | undefined): string {
  return (request?.messages ?? [])
    .slice(1)
    .flatMap(message => (message.role === 'system' && typeof message.content === 'string' ? [message.content] : []))
    .join('\n');
}

function toolsBlock(request: LLMCreateParamsStreaming | undefined): string[] {
  return (request?.tools ?? []).map(tool => JSON.stringify(tool));
}

function bundleIndex(request: LLMCreateParamsStreaming | undefined): string {
  return /<tool-bundles>\n([\s\S]*?)\n<\/tool-bundles>/.exec(systemPrompt(request))?.[1] ?? '';
}

describe('tool bundles in a turn', () => {
  it('sends every tool on the first model call, with only the guidance index in the system prompt', async () => {
    const { requests } = await runTurn({ steps: ['answer'] });
    expect(sentNames(requests[0])).toEqual(['load_bundle', 'what_time', 'render_map', 'add_note', 'list_notes']);
    expect(bundleIndex(requests[0])).toContain('- spaces: ');
    expect(bundleIndex(requests[0])).toContain('- web: ');
    expect(bundleIndex(requests[0])).not.toContain('- maps: ');
    expect(systemPrompt(requests[0])).not.toContain('Spaces hold the notes');
    expect(replyBlock(requests[0])).not.toContain('Spaces hold the notes');
  });

  it('calls a tool on the first model call, with no load step first', async () => {
    const { requests, sets } = await runTurn({
      message: 'Add a note: call the plumber.',
      steps: [{ name: 'add_note', args: { text: 'plumber' } }, 'answer'],
    });
    expect(sets.notes.calls).toEqual(['add_note:plumber']);
    expect(requests).toHaveLength(2);
  });

  it('keeps the system prompt and tools byte-identical across the steps of a reply', async () => {
    const { requests } = await runTurn({
      message: 'Show the Belem Tower on a map.',
      steps: [{ name: 'load_bundle', args: { name: 'spaces' } }, { name: 'render_map', args: { text: 'x' } }, 'answer'],
    });
    expect(requests).toHaveLength(3);
    for (const request of requests.slice(1)) {
      expect(systemPrompt(request)).toBe(systemPrompt(requests[0]));
      expect(toolsBlock(request)).toEqual(toolsBlock(requests[0]));
      expect(replyBlock(request)).toBe(replyBlock(requests[0]));
    }
  });

  it("returns a topic's guidance in the load_bundle result", async () => {
    const { requests, thread } = await runTurn({
      steps: [{ name: 'load_bundle', args: { name: 'spaces' } }, 'answer'],
    });
    const result = toolResults(requests[1])[0];
    expect(result).toContain('Guidance for spaces. It covers add_note, list_notes, already in your tool list.');
    expect(result).toContain('Spaces hold the notes');
    expect(systemPrompt(requests[1])).not.toContain('Spaces hold the notes');
    expect(thread.toSnapshot().capability_state).toBeNull();
  });

  it("starts the next reply with the previous reply's system prompt and tools", async () => {
    const first = await runTurn({ steps: [{ name: 'load_bundle', args: { name: 'spaces' } }, 'answer'] });
    const lastOfFirst = first.requests[first.requests.length - 1];
    const snapshot = first.thread.toSnapshot();
    const second = await runTurn({
      message: 'Show the Belem Tower on a map.',
      steps: ['answer'],
      history: snapshot.context,
      capabilityState: snapshot.capability_state ?? undefined,
    });
    expect(systemPrompt(second.requests[0])).toBe(systemPrompt(lastOfFirst));
    expect(toolsBlock(second.requests[0])).toEqual(toolsBlock(lastOfFirst));
  });

  it('reads a topic by another name for it', async () => {
    const { requests } = await runTurn({ steps: [{ name: 'load_bundle', args: { name: 'Notes' } }, 'answer'] });
    expect(toolResults(requests[1])[0]).toContain('Spaces hold the notes');
  });

  it('names the closest topic for a name that means none', async () => {
    const { requests } = await runTurn({ steps: [{ name: 'load_bundle', args: { name: 'spacse' } }, 'answer'] });
    expect(toolResults(requests[1])[0]).toContain(
      "No guidance named 'spacse'. Closest is spaces. Call load_bundle again with one of these topics: web, spaces.",
    );
  });

  it('drops the saved bundle list an older chat carries, and still sends every tool', async () => {
    const { requests, thread } = await runTurn({
      steps: ['answer'],
      capabilityState: { 'tfy.tool_bundles': { loaded: ['maps'] } },
    });
    expect(sentNames(requests[0])).toEqual(['load_bundle', 'what_time', 'render_map', 'add_note', 'list_notes']);
    expect(thread.toSnapshot().capability_state).toBeNull();
  });

  it('keeps the index of every bundle under 300 tokens', () => {
    const bundles = new ToolBundles({
      tracing: NOOP_AGENT_TRACING,
      sectionBundles: new Set(TOOL_BUNDLE_NAMES),
      guidance: name => `Guidance for ${name}.`,
    });
    bundles.load({ converted: { tools: [], toolMapping: new Map() }, metaToolSet: undefined, deferredServers: false });
    const builder = new InstructionBuilder('test');
    bundles.buildInstruction(builder);
    const index = builder.build();
    expect(index).toContain('- extras: ');
    expect(estimateTokensForString(index)).toBeLessThan(300);
  });
});

describe('finding a bundle by name', () => {
  const offered = [...TOOL_BUNDLE_NAMES];

  it('takes a name or another name for it, in any case or spacing', () => {
    expect(findBundle({ name: 'Calendar', offered })).toEqual({ found: 'google' });
    expect(findBundle({ name: 'sub agents', offered })).toEqual({ found: 'sub_agents' });
  });

  it('names the closest bundle for a misspelled name', () => {
    expect(findBundle({ name: 'calender', offered })).toEqual({ closest: 'google' });
  });

  it('finds only bundles offered here', () => {
    expect(findBundle({ name: 'maps', offered: ['spaces'] })).toEqual({ closest: 'spaces' });
  });
});
