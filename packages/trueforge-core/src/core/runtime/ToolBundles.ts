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

const ToolBundlesStateSchema = z.object({ loaded: z.array(z.string()) });

type ToolBundlesState = z.infer<typeof ToolBundlesStateSchema>;

const loadBundleSchema = z.object({
  name: z.string().describe('The bundle to load, as the bundle index names it.'),
});

const TOOL_BUNDLES_GUIDE = dedent`
  More tools come in bundles. A loaded bundle's tools are in your tool list. To use another bundle, call ${LOAD_BUNDLE_TOOL_NAME} with its name first; it stays loaded for the rest of this chat. Never call a tool you cannot see in your tool list.`;

function sameBundles(input: { a: readonly ToolBundleName[]; b: readonly ToolBundleName[] }): boolean {
  return input.a.length === input.b.length && input.a.every((name, i) => name === input.b[i]);
}

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
 * Groups of built-in tools sent only once a chat needs them. A router picks bundles from the
 * person's message before a reply's first model call; `load_bundle` adds one mid-reply. A bundle
 * stays for the rest of the chat and its tools go at the end of the list, so the system prompt and
 * tool list only grow at their end and a provider's cached prefix stays valid. A tool keeps its own
 * name either way, so it is checked and run exactly as when always sent.
 */
export class ToolBundles {
  private readonly toolSet: LoadBundleTool;
  private bundleByTool = new Map<string, ToolBundleName>();
  private offered: ToolBundleName[] = [];
  // Every bundle this chat has sent, in the order it was first sent, as saved; never dropped or re-sorted.
  private saved: ToolBundleName[] = [];
  // The router's picks for this reply that are not saved yet; they go after the saved list.
  private routedPicks: ToolBundleName[] = [];
  private routed = false;
  // Tools left out of every request: the connector lookup tools while no connector needs them,
  // and load_bundle while there is nothing to load.
  private unused = new Set<string>();
  private readonly sectionBundles: ReadonlySet<ToolBundleName>;
  private readonly routeSignals: () => Pick<BundleRouteSignals, 'repositoryAttached'>;
  private readonly guidance: (name: ToolBundleName) => string;

  constructor(input: {
    tracing: AgentTracing;
    /** Bundles that write prompt sections, so they are offered even without tools. */
    sectionBundles: ReadonlySet<ToolBundleName>;
    routeSignals: () => Pick<BundleRouteSignals, 'repositoryAttached'>;
    /** A bundle's prompt sections, sent with its load instead of in the system prompt. */
    guidance: (name: ToolBundleName) => string;
  }) {
    this.sectionBundles = input.sectionBundles;
    this.routeSignals = input.routeSignals;
    this.guidance = input.guidance;
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

  /** Whether a bundle's tools are sent now. */
  isLoaded(name: ToolBundleName): boolean {
    return this.sent().includes(name);
  }

  /** The bundles sent now, in the order each was first sent. */
  private sent(): ToolBundleName[] {
    return [...this.saved, ...this.routedPicks.filter(name => !this.saved.includes(name))];
  }

  /** A bundle's prompt sections. */
  guidanceOf(name: ToolBundleName): string {
    return this.guidance(name);
  }

  /**
   * Sent bundles whose guidance no `load_bundle` result in the context carries: the router's
   * picks, and loads whose result a compaction dropped. Their guidance rides with the reply.
   */
  guidanceDue(context: readonly ContextMessage[]): ToolBundleName[] {
    const carried = new Set(
      context.flatMap(message =>
        isLLMContextMessage(message) && message.role === 'assistant'
          ? (message.tool_calls ?? []).flatMap(call => {
              const bundle = this.loadedBy(call);
              return bundle === undefined ? [] : [bundle];
            })
          : [],
      ),
    );
    return this.sent().filter(name => !carried.has(name));
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
   * Before a thread's first model request, adds the bundles the person's message calls for after
   * those the chat already sends; the next save keeps them. Returns whether this was that first
   * call, so the caller builds the reply's guidance once.
   */
  route(context: readonly ContextMessage[]): boolean {
    if (this.routed) {
      return false;
    }
    this.routed = true;
    const person = [...context].reverse().find(isPersonMessage);
    const { text, attachments } = person === undefined ? { text: '', attachments: false } : readPersonMessage(person);
    const wanted = routeBundles({ message: text, signals: { attachments, ...this.routeSignals() } });
    this.routedPicks = TOOL_BUNDLE_NAMES.filter(name => wanted.has(name));
    return true;
  }

  /** Always-sent tools in their own order, then each sent bundle's tools in the order it was first sent. */
  requestTools(tools: readonly ChatCompletionTool[]): ChatCompletionTool[] {
    const bundleOf = (tool: ChatCompletionTool) =>
      tool.type === 'function' ? this.bundleByTool.get(tool.function.name) : undefined;
    const always = tools.filter(
      tool => bundleOf(tool) === undefined && (tool.type !== 'function' || !this.unused.has(tool.function.name)),
    );
    const bundled = this.sent().flatMap(name => tools.filter(tool => bundleOf(tool) === name));
    return [...always, ...bundled];
  }

  buildInstruction(builder: InstructionBuilder): void {
    if (this.offered.length === 0) {
      return;
    }
    // Fixed for the chat: whether a bundle is loaded shows in the tool list, never here.
    const lines = this.offered.map(bundleIndexLine);
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

  /** Saves the router's picks and the calls' loads at the end of the list. */
  private async *recordLoads(calls: readonly RawToolCall[]) {
    await Promise.resolve();
    const next = this.sent();
    for (const call of calls) {
      const bundle = this.loadedBy(call);
      if (bundle !== undefined && !next.includes(bundle)) {
        next.push(bundle);
      }
    }
    if (sameBundles({ a: next, b: this.saved })) {
      return;
    }
    const state: ToolBundlesState = { loaded: next };
    yield { type: InternalEventType.CAPABILITY_STATE, key: TOOL_BUNDLES_STATE_KEY, state };
    this.saved = next;
    this.routedPicks = [];
  }

  /**
   * Durable bundles: restored from the chat's saved state, and saved again once a call's result is
   * in (so the next request already carries the tools) and before each model request (covering the
   * router's picks and a chat resumed after a restart or an approval).
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
          const loaded = parsed.success ? parsed.data.loaded.filter(isToolBundleName) : [];
          this.saved = loaded.filter((name, i) => loaded.indexOf(name) === i);
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
          const state = bundles.isLoaded(lookup.found) ? 'is already loaded' : 'is loaded';
          const ready =
            tools.length === 0
              ? 'Its guidance follows.'
              : `Its tools (${tools.join(', ')}) are ready from your next step. Call each tool directly by its name.`;
          // The guidance lands here, at the end of the chat, so the system prompt never changes.
          const guidance = bundles.guidanceOf(lookup.found);
          const intro = `${lookup.found} ${state}. ${ready}`;
          return Promise.resolve(
            toolResultResponse({
              text: guidance === '' ? intro : `${intro}\nFollow this guidance when you use it:\n${guidance}`,
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
