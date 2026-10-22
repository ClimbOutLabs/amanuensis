import { z } from 'zod';
import type { AgentCapability, CapabilityState } from '../../../src/core/capabilities/AgentCapability';
import { InstructionBuilder } from '../../../src/core/InstructionBuilder';
import type { ILLM, LLMCreateParamsStreaming } from '../../../src/core/llm/ILLM';
import { estimateTokensForString } from '../../../src/core/llm/usage';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { AgentThread } from '../../../src/core/runtime/AgentThread';
import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import {
  findBundle,
  routeBundles,
  TOOL_BUNDLE_NAMES,
  type ToolBundleName,
} from '../../../src/core/runtime/toolBundleCatalog';
import { TOOL_BUNDLES_STATE_KEY, ToolBundles } from '../../../src/core/runtime/ToolBundles';
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

/** Whether `next` sends `previous`'s tool definitions byte for byte, then possibly more at the end. */
function extendsTools(input: {
  previous: LLMCreateParamsStreaming | undefined;
  next: LLMCreateParamsStreaming | undefined;
}) {
  const previous = toolsBlock(input.previous);
  return toolsBlock(input.next).slice(0, previous.length).join('\n') === previous.join('\n');
}

function bundleIndex(request: LLMCreateParamsStreaming | undefined): string {
  return /<tool-bundles>\n([\s\S]*?)\n<\/tool-bundles>/.exec(systemPrompt(request))?.[1] ?? '';
}

describe('tool bundles in a turn', () => {
  it('sends only the always-sent tools and load_bundle when the message calls for no bundle', async () => {
    const { requests } = await runTurn({ steps: ['answer'] });
    expect(sentNames(requests[0])).toEqual(['load_bundle', 'what_time']);
    expect(bundleIndex(requests[0])).toContain('- maps: show places, routes and maps');
    expect(bundleIndex(requests[0])).toContain('- spaces: ');
    expect(systemPrompt(requests[0])).not.toContain('Spaces hold the notes');
  });

  it("routes a bundle from the person's message before the first model call, with its guidance in the reply block", async () => {
    const { requests, thread } = await runTurn({ steps: ['answer'], message: 'Add a note: call the plumber.' });
    expect(sentNames(requests[0])).toEqual(['load_bundle', 'what_time', 'add_note', 'list_notes']);
    expect(bundleIndex(requests[0])).not.toContain('(loaded)');
    expect(systemPrompt(requests[0])).not.toContain('Spaces hold the notes');
    expect(replyBlock(requests[0])).toContain('Spaces hold the notes');
    expect(thread.toSnapshot().capability_state).toEqual({ [TOOL_BUNDLES_STATE_KEY]: { loaded: ['spaces'] } });
  });

  it('keeps the system prompt and earlier tools byte-identical when a bundle loads mid-reply', async () => {
    const { requests, thread } = await runTurn({
      message: 'Show the Belem Tower on a map.',
      steps: [{ name: 'load_bundle', args: { name: 'spaces' } }, 'answer'],
    });
    expect(sentNames(requests[1])).toEqual(['load_bundle', 'what_time', 'render_map', 'add_note', 'list_notes']);
    expect(systemPrompt(requests[1])).toBe(systemPrompt(requests[0]));
    expect(extendsTools({ previous: requests[0], next: requests[1] })).toBe(true);
    expect(replyBlock(requests[1])).toBe(replyBlock(requests[0]));
    expect(thread.toSnapshot().capability_state).toEqual({ [TOOL_BUNDLES_STATE_KEY]: { loaded: ['maps', 'spaces'] } });
  });

  it("returns a loaded bundle's guidance in the load_bundle result", async () => {
    const { requests } = await runTurn({ steps: [{ name: 'load_bundle', args: { name: 'spaces' } }, 'answer'] });
    const result = toolResults(requests[1])[0];
    expect(result).toContain('spaces is loaded. Its tools (add_note, list_notes) are ready from your next step.');
    expect(result).toContain('Spaces hold the notes');
    expect(systemPrompt(requests[1])).not.toContain('Spaces hold the notes');
    expect(replyBlock(requests[1])).not.toContain('Spaces hold the notes');
  });

  it("starts the next reply with the previous reply's system prompt and tools, adding new bundles at the end", async () => {
    const first = await runTurn({
      message: 'Thanks!',
      steps: [{ name: 'load_bundle', args: { name: 'maps' } }, 'answer'],
    });
    const lastOfFirst = first.requests[first.requests.length - 1];
    const snapshot = first.thread.toSnapshot();
    const second = await runTurn({
      message: 'Add a note: call the plumber.',
      steps: ['answer'],
      history: snapshot.context,
      capabilityState: snapshot.capability_state ?? undefined,
    });
    const firstOfSecond = second.requests[0];
    expect(systemPrompt(firstOfSecond)).toBe(systemPrompt(lastOfFirst));
    expect(extendsTools({ previous: lastOfFirst, next: firstOfSecond })).toBe(true);
    expect(sentNames(firstOfSecond)).toEqual(['load_bundle', 'what_time', 'render_map', 'add_note', 'list_notes']);
    expect(second.thread.toSnapshot().capability_state).toEqual({
      [TOOL_BUNDLES_STATE_KEY]: { loaded: ['maps', 'spaces'] },
    });
  });

  it('keeps the saved order across replies instead of re-sorting it', async () => {
    const { requests } = await runTurn({
      message: 'Show the Belem Tower on a map.',
      steps: ['answer'],
      capabilityState: { [TOOL_BUNDLES_STATE_KEY]: { loaded: ['spaces'] } },
    });
    expect(sentNames(requests[0])).toEqual(['load_bundle', 'what_time', 'add_note', 'list_notes', 'render_map']);
  });

  it('loads a bundle by another name for it', async () => {
    const { requests } = await runTurn({ steps: [{ name: 'load_bundle', args: { name: 'Notes' } }, 'answer'] });
    expect(sentNames(requests[1])).toContain('add_note');
  });

  it('names the closest bundle for a name that means none, and loads nothing', async () => {
    const { requests, thread } = await runTurn({
      steps: [{ name: 'load_bundle', args: { name: 'mpas' } }, 'answer'],
    });
    expect(toolResults(requests[1])[0]).toContain("No bundle named 'mpas'. Closest is maps. Bundles: maps, spaces.");
    expect(sentNames(requests[1])).toEqual(['load_bundle', 'what_time']);
    expect(thread.toSnapshot().capability_state).toBeNull();
  });

  it('restores loaded bundles after a restart, and a new chat starts with none', async () => {
    const saved = (await runTurn({ steps: [{ name: 'load_bundle', args: { name: 'spaces' } }] })).thread.toSnapshot()
      .capability_state;
    const restarted = await runTurn({ steps: ['answer'], capabilityState: saved ?? undefined });
    expect(sentNames(restarted.requests[0])).toContain('add_note');
    const newChat = await runTurn({ steps: ['answer'] });
    expect(sentNames(newChat.requests[0])).not.toContain('add_note');
  });

  it('keeps every loaded bundle for the rest of the chat', async () => {
    const loaded: ToolBundleName[] = ['google', 'web', 'sandbox', 'maps'];
    const { thread } = await runTurn({
      steps: [{ name: 'load_bundle', args: { name: 'spaces' } }],
      capabilityState: { [TOOL_BUNDLES_STATE_KEY]: { loaded } },
    });
    expect(thread.toSnapshot().capability_state?.[TOOL_BUNDLES_STATE_KEY]).toEqual({
      loaded: ['google', 'web', 'sandbox', 'maps', 'spaces'],
    });
  });

  it('runs a tool of a bundle that is not loaded under its own name', async () => {
    const { sets } = await runTurn({ steps: [{ name: 'add_note', args: { text: 'boiler' } }, 'answer'] });
    expect(sets.notes.calls).toEqual(['add_note:boiler']);
  });

  it('keeps the index of every bundle under 300 tokens', () => {
    const bundles = new ToolBundles({
      tracing: NOOP_AGENT_TRACING,
      sectionBundles: new Set(TOOL_BUNDLE_NAMES),
      routeSignals: () => ({ repositoryAttached: false }),
      guidance: () => '',
    });
    bundles.load({ converted: { tools: [], toolMapping: new Map() }, metaToolSet: undefined, deferredServers: false });
    const builder = new InstructionBuilder('test');
    bundles.buildInstruction(builder);
    const index = builder.build();
    expect(index).toContain('- extras: ');
    expect(estimateTokensForString(index)).toBeLessThan(300);
  });
});

describe('the router', () => {
  const route = (message: string, signals?: { attachments?: boolean; repositoryAttached?: boolean }) =>
    [
      ...routeBundles({
        message,
        signals: {
          attachments: signals?.attachments ?? false,
          repositoryAttached: signals?.repositoryAttached ?? false,
        },
      }),
    ].sort();

  it.each<[string, ToolBundleName[]]>([
    ['Thanks!', []],
    ['Remind me to call the dentist', ['google']],
    ['Draft a reply to the latest email from Grace saying Thursday works.', ['google']],
    ['Search the web for the opening hours of the Lisbon Oceanarium.', ['web']],
    ['Read https://example.org/menu for me', ['web']],
    ['Who won the match', ['web']],
    ['Is it going to rain', []],
    ['Is it going to rain?', ['web']],
    ['Put the Lisbon Oceanarium on a map', ['maps']],
    ['Run this script over the csv file', ['sandbox']],
    ['In the space “Home”, add a line: call the plumber.', ['spaces']],
    ['Every weekday send me the news', ['google', 'schedules', 'web']],
  ])('routes %j to %j', (message, expected) => {
    expect(route(message)).toEqual([...expected].sort());
  });

  it('routes attached files to documents and an attached repository to sandbox', () => {
    expect(route('Have a look', { attachments: true })).toEqual(['documents']);
    expect(route('Have a look', { repositoryAttached: true })).toEqual(['sandbox']);
  });

  it('never routes the on-request extras bundle', () => {
    expect(route('What is my net worth and usage, show it in openui')).not.toContain('extras');
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
