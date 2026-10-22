import dedent from 'dedent';
import type { ChatCompletionTool } from 'openai/resources/chat';
import { z } from 'zod';
import type { AgentCapability, JsonValue } from '../capabilities/AgentCapability';
import type { AgentThreadExecutionContext } from '../capabilities/AgentContextProcessor';
import type { InstructionBuilder } from '../InstructionBuilder';
import type { RawToolCall } from '../llm/LLMTypes';
import type { ConvertToolsResult } from '../mcp/convertMCPServers';
import { toolResultResponse, type IToolSet } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import { parseToolCallArguments } from '../mcp/toolArgumentCheck';
import type { AgentTracing } from '../tracing/AgentTracing';
import { InternalEventType, type ContextMessage } from './AgentThread.types';
import {
  isHostWrappedText,
  isInternalSystemMessage,
  isLLMContextMessage,
  isUntrustedDocumentText,
} from './contextUtils';
import {
  bundleIndexLine,
  findBundle,
  routeBundles,
  TOOL_BUNDLE_NAMES,
  type BundleRouteSignals,
  type ToolBundleName,
} from './toolBundleCatalog';
import { isUploadedFilesAnnouncement } from './UserInputMessage';

export const TOOL_BUNDLES_STATE_KEY = 'tfy.tool_bundles';
export const TOOL_BUNDLES_SERVER_ID = 'bundles';
export const LOAD_BUNDLE_TOOL_NAME = 'load_bundle';
const TOOL_BUNDLES_INSTRUCTION = 'tool-bundles';

/** Most bundles one chat keeps loaded on request; the least recently loaded drops first. */
export const MAX_LOADED_BUNDLES = 4;

/** Earlier replies whose tools keep their bundles loaded for the next message. */
const RECENT_REPLIES = 3;

const ToolBundlesStateSchema = z.object({ loaded: z.array(z.string()) });

type ToolBundlesState = z.infer<typeof ToolBundlesStateSchema>;

const loadBundleSchema = z.object({
  name: z.string().describe('The bundle to load, as the bundle index names it.'),
});

const TOOL_BUNDLES_GUIDE = dedent`
  More tools come in bundles. A loaded bundle's tools are in your tool list. To use another bundle, call ${LOAD_BUNDLE_TOOL_NAME} with its name first; it stays loaded for the rest of this chat. Never call a tool you cannot see in your tool list.`;

function isToolBundleName(name: string): name is ToolBundleName {
  return TOOL_BUNDLE_NAMES.some(bundle => bundle === name);
}

/** The person's own words in a message, and whether files came with it. */
function readPersonMessage(message: ContextMessage): { text: string; attachments: boolean } {
  if (!isLLMContextMessage(message) || message.role !== 'user') {
    return { text: '', attachments: false };
  }
  if (typeof message.content === 'string') {
    return { text: isHostWrappedText(message.content) ? '' : message.content, attachments: false };
  }
  const words = message.content.flatMap(part =>
    part.type === 'text' && !isHostWrappedText(part.text) ? [part.text] : [],
  );
  const attachments = message.content.some(
    part => part.type !== 'text' || isUploadedFilesAnnouncement(part.text) || isUntrustedDocumentText(part.text),
  );
  return { text: words.join('\n'), attachments };
}

function isPersonMessage(message: ContextMessage): boolean {
  return isLLMContextMessage(message) && message.role === 'user' && !isInternalSystemMessage(message);
}

/**
 * Groups of built-in tools sent only when a turn needs them. A router picks bundles from the
 * person's message before the first model call; `load_bundle` adds one for the rest of the chat.
 * A tool keeps its own name either way, so it is checked and run exactly as when always sent.
 */
export class ToolBundles {
  private readonly toolSet: LoadBundleTool;
  private bundleByTool = new Map<string, ToolBundleName>();
  private offered: ToolBundleName[] = [];
  // Loaded on request, oldest first; saved with the chat.
  private loaded: ToolBundleName[] = [];
  // Sent this turn: the router's choice first, then each later load at the end, never re-sorted.
  private active: ToolBundleName[] = [];
  private routed = false;
  // Tools left out of every request: the connector lookup tools while no connector needs them,
  // and load_bundle while there is nothing to load.
  private unused = new Set<string>();
  private readonly sectionBundles: ReadonlySet<ToolBundleName>;
  private readonly routeSignals: () => Pick<BundleRouteSignals, 'repositoryAttached'>;

  constructor(input: {
    tracing: AgentTracing;
    /** Bundles that write prompt sections, so they are offered even without tools. */
    sectionBundles: ReadonlySet<ToolBundleName>;
    routeSignals: () => Pick<BundleRouteSignals, 'repositoryAttached'>;
  }) {
    this.sectionBundles = input.sectionBundles;
    this.routeSignals = input.routeSignals;
    this.toolSet = new LoadBundleTool({ tracing: input.tracing, bundles: this });
  }

  /**
   * Sorts the converted tool list into bundles. Tools served by `metaToolSet` are only sent while
   * `deferredServers` holds connectors whose tools are not listed.
   */
  load(input: { converted: ConvertToolsResult; metaToolSet: IToolSet | undefined; deferredServers: boolean }): void {
    const bundleByTool = new Map<string, ToolBundleName>();
    const metaTools = new Set<string>();
    for (const definition of input.converted.tools) {
      if (definition.type !== 'function') {
        continue;
      }
      const mapped = input.converted.toolMapping.get(definition.function.name);
      if (mapped === undefined) {
        continue;
      }
      if (mapped.toolSet === input.metaToolSet) {
        metaTools.add(definition.function.name);
        continue;
      }
      const bundle = mapped.toolSet.bundleOf?.(mapped.originalToolName);
      if (bundle !== undefined) {
        bundleByTool.set(definition.function.name, bundle);
      }
    }
    const withTools = new Set(bundleByTool.values());
    this.bundleByTool = bundleByTool;
    this.offered = TOOL_BUNDLE_NAMES.filter(name => withTools.has(name) || this.sectionBundles.has(name));
    this.unused = new Set([
      ...(input.deferredServers ? [] : metaTools),
      ...(this.offered.length === 0 ? [LOAD_BUNDLE_TOOL_NAME] : []),
    ]);
  }

  /** Whether a bundle's tools and prompt sections are sent now. */
  isLoaded(name: ToolBundleName): boolean {
    return this.active.includes(name);
  }

  /** The tool names a bundle holds in this chat, in the order they are sent. */
  toolsOf(name: ToolBundleName): string[] {
    return [...this.bundleByTool.entries()].flatMap(([tool, bundle]) => (bundle === name ? [tool] : []));
  }

  /** What `load_bundle` may load here. */
  available(): readonly ToolBundleName[] {
    return this.offered;
  }

  /**
   * Brings the bundles sent this turn up to date before a model request: the first time, from the
   * person's message and the last few replies; after that, by adding bundles loaded since. Returns
   * whether anything was added, so the caller rebuilds the prompt.
   */
  refresh(context: readonly ContextMessage[]): boolean {
    const before = this.active.length;
    if (!this.routed) {
      this.routed = true;
      const person = [...context].reverse().find(isPersonMessage);
      const { text, attachments } = person === undefined ? { text: '', attachments: false } : readPersonMessage(person);
      const wanted = new Set([
        ...routeBundles({ message: text, signals: { attachments, ...this.routeSignals() } }),
        ...this.usedRecently(context),
        ...this.loaded,
      ]);
      this.active = TOOL_BUNDLE_NAMES.filter(name => wanted.has(name));
    }
    for (const name of this.loaded) {
      if (!this.active.includes(name)) {
        this.active.push(name);
      }
    }
    return this.active.length !== before;
  }

  /** Always-sent tools in their own order, then each sent bundle's tools in the order it was loaded. */
  requestTools(tools: readonly ChatCompletionTool[]): ChatCompletionTool[] {
    const bundleOf = (tool: ChatCompletionTool) =>
      tool.type === 'function' ? this.bundleByTool.get(tool.function.name) : undefined;
    const always = tools.filter(
      tool => bundleOf(tool) === undefined && (tool.type !== 'function' || !this.unused.has(tool.function.name)),
    );
    const bundled = this.active.flatMap(name => tools.filter(tool => bundleOf(tool) === name));
    return [...always, ...bundled];
  }

  buildInstruction(builder: InstructionBuilder): void {
    if (this.offered.length === 0) {
      return;
    }
    const lines = this.offered.map(name => `${bundleIndexLine(name)}${this.isLoaded(name) ? ' (loaded)' : ''}`);
    builder.addSection(TOOL_BUNDLES_INSTRUCTION, [TOOL_BUNDLES_GUIDE, ...lines].join('\n'));
  }

  /** The bundle a `load_bundle` call loads, if its name means one offered here. */
  loadedBy(call: RawToolCall): ToolBundleName | undefined {
    if (call.function.name !== LOAD_BUNDLE_TOOL_NAME) {
      return undefined;
    }
    const name = parseToolCallArguments(call)?.['name'];
    if (typeof name !== 'string') {
      return undefined;
    }
    const lookup = findBundle({ name, offered: this.offered });
    return 'found' in lookup ? lookup.found : undefined;
  }

  /** Bundles whose tools the replies to the last few messages used or loaded, this turn's included. */
  private usedRecently(context: readonly ContextMessage[]): Set<ToolBundleName> {
    const used = new Set<ToolBundleName>();
    let messages = 0;
    for (const message of [...context].reverse()) {
      if (isPersonMessage(message)) {
        messages++;
        if (messages > RECENT_REPLIES) {
          break;
        }
        continue;
      }
      if (!isLLMContextMessage(message) || message.role !== 'assistant') {
        continue;
      }
      for (const call of message.tool_calls ?? []) {
        const bundle = this.bundleByTool.get(call.function.name) ?? this.loadedBy(call);
        if (bundle !== undefined) {
          used.add(bundle);
        }
      }
    }
    return used;
  }

  /** The loaded list after the given calls, oldest first and bounded; a bundle loaded again moves to the end. */
  private loadedAfter(calls: readonly RawToolCall[]): ToolBundleName[] {
    const next = [...this.loaded];
    for (const call of calls) {
      const bundle = this.loadedBy(call);
      if (bundle === undefined) {
        continue;
      }
      const at = next.indexOf(bundle);
      if (at !== -1) {
        next.splice(at, 1);
      }
      next.push(bundle);
    }
    return next.slice(-MAX_LOADED_BUNDLES);
  }

  /** Records the calls' loads: the new list is saved before this chat uses it. */
  private async *recordLoads(calls: readonly RawToolCall[]) {
    await Promise.resolve();
    const next = this.loadedAfter(calls);
    if (next.length === this.loaded.length && next.every((name, i) => name === this.loaded[i])) {
      return;
    }
    const state: ToolBundlesState = { loaded: next };
    yield { type: InternalEventType.CAPABILITY_STATE, key: TOOL_BUNDLES_STATE_KEY, state };
    this.loaded = next;
  }

  /**
   * Durable loads: restored from the chat's saved state, and refreshed from the chat's calls once
   * their results are in (so the next request already carries the tools) and again before each
   * model request (covering a chat resumed after a restart or an approval).
   */
  capability(): AgentCapability {
    const recordFromContext = (execution: Readonly<AgentThreadExecutionContext>) =>
      this.recordLoads(
        execution.context.flatMap(message =>
          isLLMContextMessage(message) && message.role === 'assistant' ? (message.tool_calls ?? []) : [],
        ),
      );
    return {
      systemToolSets: [this.toolSet],
      state: {
        key: TOOL_BUNDLES_STATE_KEY,
        load: (state: JsonValue) => {
          const parsed = ToolBundlesStateSchema.safeParse(state);
          this.loaded = parsed.success ? parsed.data.loaded.filter(isToolBundleName).slice(-MAX_LOADED_BUNDLES) : [];
        },
      },
      preLLMProcessors: [{ processPreLLM: recordFromContext }],
      postToolCallProcessors: [{ processPostToolCall: recordFromContext }],
    };
  }
}

/** `load_bundle`: a lookup, not an action, so it runs without a card. */
export class LoadBundleTool extends LocalToolMCP {
  readonly name = TOOL_BUNDLES_SERVER_ID;
  readonly displayName = 'Tool bundles';
  private readonly tools: ToolDefinition[];

  constructor(input: { tracing: AgentTracing; bundles: ToolBundles }) {
    super({ tracing: input.tracing });
    const { bundles } = input;
    this.tools = [
      defineTool({
        name: LOAD_BUNDLE_TOOL_NAME,
        description: 'Load a bundle of tools from the bundle index. Its tools stay in your tool list for this chat.',
        schema: loadBundleSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: ({ name }: { name: string }) => {
          const offered = bundles.available();
          const lookup = findBundle({ name, offered });
          if (!('found' in lookup)) {
            const closest = lookup.closest === undefined ? '' : ` Closest is ${lookup.closest}.`;
            return Promise.resolve(
              toolResultResponse({
                text: `No bundle named '${name}'.${closest} Bundles: ${offered.join(', ') || 'none'}.`,
                isError: true,
              }),
            );
          }
          const tools = bundles.toolsOf(lookup.found);
          const what = tools.length === 0 ? 'Its guidance is' : `Its tools (${tools.join(', ')}) are`;
          const state = bundles.isLoaded(lookup.found) ? 'is already loaded' : 'is loaded';
          return Promise.resolve(
            toolResultResponse({
              text: `${lookup.found} ${state}. ${what} available from your next step. Call each tool directly by its name.`,
            }),
          );
        },
      }),
    ];
  }

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }
}
