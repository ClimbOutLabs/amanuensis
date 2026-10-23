import dedent from 'dedent';
import type { ChatCompletionTool } from 'openai/resources/chat';
import { z } from 'zod';
import type { AgentCapability } from '../capabilities/AgentCapability';
import type { InstructionBuilder } from '../InstructionBuilder';
import type { ConvertToolsResult } from '../mcp/convertMCPServers';
import { toolResultResponse, type IToolSet } from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import type { AgentTracing } from '../tracing/AgentTracing';
import { bundleIndexLine, findBundle, TOOL_BUNDLE_NAMES, type ToolBundleName } from './toolBundleCatalog';

export const TOOL_BUNDLES_SERVER_ID = 'bundles';
export const LOAD_BUNDLE_TOOL_NAME = 'load_bundle';
const TOOL_BUNDLES_INSTRUCTION = 'tool-bundles';

const loadBundleSchema = z.object({
  name: z.string().describe('The topic to read, as the guidance index names it.'),
});

const TOOL_BUNDLES_GUIDE = dedent`
  Every tool you have is already in your tool list: call it directly by name, nothing needs loading first. Some topics have longer guidance, listed below. Call ${LOAD_BUNDLE_TOOL_NAME} with a topic's name to read it when a task needs more than the tool's own description.`;

/**
 * Built-in tools grouped by topic. Every tool goes out on every request, so a reply never spends a
 * model call loading one. Only each topic's guidance waits: the system prompt lists one line per
 * topic, and `load_bundle` returns the text when the model asks for it.
 */
export class ToolBundles {
  private readonly toolSet: LoadBundleTool;
  private bundleByTool = new Map<string, ToolBundleName>();
  private offered: ToolBundleName[] = [];
  // Tools left out of every request: the connector lookup tools while no connector needs them,
  // and load_bundle while there is no guidance to read.
  private unused = new Set<string>();
  private readonly sectionBundles: ReadonlySet<ToolBundleName>;
  private readonly guidance: (name: ToolBundleName) => string;

  constructor(input: {
    tracing: AgentTracing;
    /** Bundles that write prompt sections, so their guidance is offered even without tools. */
    sectionBundles: ReadonlySet<ToolBundleName>;
    /** A bundle's prompt sections, returned by `load_bundle` instead of sent in the system prompt. */
    guidance: (name: ToolBundleName) => string;
  }) {
    this.sectionBundles = input.sectionBundles;
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
    this.offered = TOOL_BUNDLE_NAMES.filter(
      name => (withTools.has(name) || this.sectionBundles.has(name)) && this.guidance(name) !== '',
    );
    this.unused = new Set([
      ...(input.deferredServers ? [] : metaTools),
      ...(this.offered.length === 0 ? [LOAD_BUNDLE_TOOL_NAME] : []),
    ]);
  }

  /** A bundle's prompt sections. */
  guidanceOf(name: ToolBundleName): string {
    return this.guidance(name);
  }

  /** The tool names a bundle holds in this chat, in the order they are sent. */
  toolsOf(name: ToolBundleName): string[] {
    return [...this.bundleByTool.entries()].flatMap(([tool, bundle]) => (bundle === name ? [tool] : []));
  }

  /** The topics whose guidance `load_bundle` can return here. */
  available(): readonly ToolBundleName[] {
    return this.offered;
  }

  /** Every tool in its listed order, so the list is the same on every request of the chat. */
  requestTools(tools: readonly ChatCompletionTool[]): ChatCompletionTool[] {
    return tools.filter(tool => tool.type !== 'function' || !this.unused.has(tool.function.name));
  }

  buildInstruction(builder: InstructionBuilder): void {
    if (this.offered.length === 0) {
      return;
    }
    const lines = this.offered.map(bundleIndexLine);
    builder.addSection(TOOL_BUNDLES_INSTRUCTION, [TOOL_BUNDLES_GUIDE, ...lines].join('\n'));
  }

  capability(): AgentCapability {
    return { systemToolSets: [this.toolSet] };
  }
}

/** `load_bundle`: reads a topic's guidance. A lookup, not an action, so it runs without a card. */
export class LoadBundleTool extends LocalToolMCP {
  readonly name = TOOL_BUNDLES_SERVER_ID;
  readonly displayName = 'Tool guidance';
  private readonly tools: ToolDefinition[];

  constructor(input: { tracing: AgentTracing; bundles: ToolBundles }) {
    super({ tracing: input.tracing });
    const { bundles } = input;
    this.tools = [
      defineTool({
        name: LOAD_BUNDLE_TOOL_NAME,
        description:
          'Optional. Returns the longer guidance for a topic in the guidance index. Every tool is callable without it.',
        schema: loadBundleSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
        handler: ({ name }: { name: string }) => {
          const offered = bundles.available();
          const lookup = findBundle({ name, offered });
          if (!('found' in lookup)) {
            const closest = lookup.closest === undefined ? '' : ` Closest is ${lookup.closest}.`;
            return Promise.resolve(
              toolResultResponse({
                text: `No guidance named '${name}'.${closest} Topics: ${offered.join(', ') || 'none'}.`,
                isError: true,
              }),
            );
          }
          const tools = bundles.toolsOf(lookup.found);
          const covers = tools.length === 0 ? '' : ` It covers ${tools.join(', ')}, already in your tool list.`;
          // The guidance lands here, at the end of the chat, so the system prompt never changes.
          return Promise.resolve(
            toolResultResponse({
              text: `Guidance for ${lookup.found}.${covers}\n${bundles.guidanceOf(lookup.found)}`,
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
