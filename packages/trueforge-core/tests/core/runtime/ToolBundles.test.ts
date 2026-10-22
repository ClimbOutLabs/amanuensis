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
import { MAX_LOADED_BUNDLES, TOOL_BUNDLES_STATE_KEY, ToolBundles } from '../../../src/core/runtime/ToolBundles';
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

  it("routes a bundle from the person's message before the first model call", async () => {
    const { requests } = await runTurn({ steps: ['answer'], message: 'Show the Belem Tower on a map.' });
    expect(sentNames(requests[0])).toEqual(['load_bundle', 'what_time', 'render_map']);
    expect(bundleIndex(requests[0])).toContain('- maps: show places, routes and maps (loaded)');
  });

  it('adds a loaded bundle at the end of the tool list with its prompt section, and saves it for the chat', async () => {
    const { requests, thread } = await runTurn({
      message: 'Show the Belem Tower on a map.',
      steps: [{ name: 'load_bundle', args: { name: 'spaces' } }, 'answer'],
    });
    expect(sentNames(requests[1])).toEqual(['load_bundle', 'what_time', 'render_map', 'add_note', 'list_notes']);
    expect(systemPrompt(requests[1])).toContain('Spaces hold the notes');
    expect(toolResults(requests[1])[0]).toContain('spaces is loaded. Its tools (add_note, list_notes) are available');
    expect(thread.toSnapshot().capability_state).toEqual({ [TOOL_BUNDLES_STATE_KEY]: { loaded: ['spaces'] } });
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

  it('keeps a bounded number of bundles loaded, dropping the least recently loaded', async () => {
    const loaded: ToolBundleName[] = ['google', 'web', 'sandbox', 'maps'];
    expect(loaded).toHaveLength(MAX_LOADED_BUNDLES);
    const { thread } = await runTurn({
      steps: [{ name: 'load_bundle', args: { name: 'spaces' } }],
      capabilityState: { [TOOL_BUNDLES_STATE_KEY]: { loaded } },
    });
    expect(thread.toSnapshot().capability_state?.[TOOL_BUNDLES_STATE_KEY]).toEqual({
      loaded: ['web', 'sandbox', 'maps', 'spaces'],
    });
  });

  it('keeps the bundles of tools used in the last three replies', async () => {
    const usedMap: ContextMessage[] = [
      { role: 'user', content: 'Where is the Oceanarium?' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'old-1',
            type: 'function',
            function: { name: 'render_map', arguments: '{"text":"x"}' },
            tool_info: {
              type: 'truefoundry-system',
              mcp_server_id: 'maps',
              mcp_server_name: 'maps',
              original_tool_name: 'render_map',
            },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'old-1', content: 'done' },
      { role: 'assistant', content: 'Here it is.' },
    ];
    const recent = await runTurn({ steps: ['answer'], history: usedMap });
    expect(sentNames(recent.requests[0])).toContain('render_map');

    const older = [
      ...usedMap,
      ...['One.', 'Two.', 'Three.'].flatMap((content): ContextMessage[] => [
        { role: 'user', content },
        { role: 'assistant', content: 'Fine.' },
      ]),
    ];
    const stale = await runTurn({ steps: ['answer'], history: older });
    expect(sentNames(stale.requests[0])).not.toContain('render_map');
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
