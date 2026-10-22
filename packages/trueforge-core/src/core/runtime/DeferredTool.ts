import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { ApprovalDecision } from '../events/schema';
import { InstructionBuilder } from '../InstructionBuilder';
import type { InternalToolCallInfo, RawAssistantMessage, RawToolCall } from '../llm/LLMTypes';
import {
  type AgentToolSchema,
  type CallToolResponse,
  isApprovalRequiredResponse,
  isAuthRequired,
  isCallToolResponseResult,
  type IToolSet,
  type ListToolsResolvedResponse,
  type ToolInvocationContext,
  toolResultResponse,
} from '../mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../mcp/LocalToolMCP';
import { parseToolCallArguments } from '../mcp/toolArgumentCheck';
import type { ConnectorBinding } from '../permissions/approvalTokens';
import { structuredEditRejection } from '../sandbox/structuredEditRejection';
import type { AgentTracing } from '../tracing/AgentTracing';
import { extractErrorLogFields } from '../util/errorLogFields';
import type { ToolIndex, ToolIndexEntry } from './ToolIndex';

export const DEFERRED_TOOLS_SERVER_ID = 'deferred-tools';
const DEFERRED_TOOLS_INSTRUCTION = 'deferred-tools-instructions';
export const LIST_TOOLS_NAME = 'list_tools';
export const GET_TOOL_INFO_NAME = 'get_tool_info';
export const GET_TOOL_OUTPUT_SCHEMA_NAME = 'get_tool_output_schema';
export const CALL_TOOL_NAME = 'call_tool';
const MAX_DESCRIPTION_LENGTH = 200;

/** Top-level meta tools this class exposes; never valid as a `call_tool` `tool_name`. */
const META_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_TOOLS_NAME,
  GET_TOOL_INFO_NAME,
  GET_TOOL_OUTPUT_SCHEMA_NAME,
  CALL_TOOL_NAME,
]);

/**
 * Meta tools that `call_tool` aliases when passed as `tool_name`, running them directly
 * instead of failing. The model's intent is unambiguous when it names one of these; guessing
 * is never involved. `call_tool` itself is excluded: aliasing it to itself has no meaning.
 */
const ALIASABLE_META_TOOL_NAMES: ReadonlySet<string> = new Set([
  LIST_TOOLS_NAME,
  GET_TOOL_INFO_NAME,
  GET_TOOL_OUTPUT_SCHEMA_NAME,
]);

/** Cap on how many names a rejection lists, so a server with hundreds of tools stays readable. */
const MAX_LISTED_NAMES = 20;

/** Renders a name list for a rejection hint, bounded to {@link MAX_LISTED_NAMES}. */
function boundedNameList(names: readonly string[]): string {
  if (names.length === 0) {
    return '(none)';
  }
  if (names.length <= MAX_LISTED_NAMES) {
    return names.join(', ');
  }
  return `${names.slice(0, MAX_LISTED_NAMES).join(', ')}, and ${String(names.length - MAX_LISTED_NAMES)} more`;
}

/** How the tool index works, in the words the model reads before the index itself. */
export const TOOL_INDEX_GUIDE = dedent`
  Tool index: the tools below are listed by name only, grouped by server. Before you use one for the first time, call ${GET_TOOL_INFO_NAME} with its server and name to see its arguments. Then call it directly by name. From then on it is fully loaded for the rest of this chat. Never guess a tool's arguments.`;

/** One line per tool under a line naming its server, in the order the tools are sent. */
export function renderIndex(entries: readonly ToolIndexEntry[]): string {
  const byServer = new Map<string, ToolIndexEntry[]>();
  for (const entry of entries) {
    byServer.set(entry.server, [...(byServer.get(entry.server) ?? []), entry]);
  }
  return [...byServer.entries()]
    .map(([server, tools]) => [`${server}:`, ...tools.map(tool => `- ${tool.name}: ${tool.summary}`)].join('\n'))
    .join('\n');
}

/** A call_tool argument correction with the tool's own schema, so the model can fix the call in one step. */
export function withToolSchema(input: { problem: string; entry: ToolIndexEntry }): string {
  const { entry } = input;
  return `${input.problem} The arguments of ${entry.name} must match this schema: ${JSON.stringify(entry.definition.function.parameters ?? {})}. Call ${entry.name} directly by name with matching arguments.`;
}

const listToolsSchema = z.object({
  mcp_server: z.string().describe('Name of the MCP server to list tools for.'),
});

const getToolInfoSchema = z.object({
  mcp_server: z.string().describe('Name of the MCP server.'),
  tool_name: z.string().describe('Name of the tool to inspect.'),
});

const getToolOutputSchemaSchema = z.object({
  mcp_server: z.string().describe('Name of the MCP server.'),
  tool_name: z.string().describe('Name of the tool to get output schema for.'),
});

const callToolSchema = z.object({
  mcp_server: z.string().describe('Name of the MCP server.'),
  tool_name: z.string().describe('Name of the tool to call.'),
  input: z.record(z.string(), z.unknown()).default({}).describe('Arguments to pass to the tool.'),
});

export type CallToolWrapper = z.infer<typeof callToolSchema>;

/**
 * Parse a deferred `call_tool` wrapper's arguments.
 *
 * Mirrors the unwrap branch of DeferredTool.toolCallInfo: when mint classified
 * the underlying tool, the approval token covers (underlying_name, input), so
 * the verifier must hash the same inner input and confirm the wrapper still
 * names that tool and server. Returns undefined when the wrapper does not
 * parse: the verifier must then hash the wrapper too, matching a mint that
 * classified the wrapper itself (the metadata-unavailable fallback).
 */
export function tryParseCallToolWrapper(wrapperArgs: Record<string, unknown>): CallToolWrapper | undefined {
  const parsed = callToolSchema.safeParse(wrapperArgs);
  return parsed.success ? parsed.data : undefined;
}

/** The inner tool input of a deferred `call_tool` wrapper, or undefined when the wrapper does not parse. */
export function tryUnwrapCallToolInput(wrapperArgs: Record<string, unknown>): Record<string, unknown> | undefined {
  return tryParseCallToolWrapper(wrapperArgs)?.input;
}

interface ResolvedServerTools {
  server: IToolSet;
  tools: AgentToolSchema[];
  metadata: Omit<ListToolsResolvedResponse, 'result'>;
}

function isResolvedServerTools(result: CallToolResponse | ResolvedServerTools): result is ResolvedServerTools {
  return 'tools' in result;
}

export class DeferredTool extends LocalToolMCP {
  readonly name = DEFERRED_TOOLS_SERVER_ID;
  readonly displayName = 'DeferredTools';
  override readonly description = 'Deferred tool loading for user MCP servers';

  private readonly serverMap: Map<string, IToolSet>;
  private readonly tools: ToolDefinition[];
  private readonly logger: Logger;
  /** Tools listed by name only; their lookups are answered here, and their calls run directly. */
  private readonly index: ToolIndex | undefined;

  constructor(
    servers: readonly IToolSet[],
    options: {
      tracing: AgentTracing;
      logger: Logger;
      index?: ToolIndex | undefined;
    },
  ) {
    super({ tracing: options.tracing });
    this.logger = options.logger.child({ module: 'DeferredTool' });
    this.serverMap = new Map(servers.map(s => [s.name, s]));
    this.index = options.index;
    this.tools = this.buildTools();
  }

  buildInstruction(builder: InstructionBuilder): void {
    const indexed = this.index?.listed() ?? [];
    // Membership follows `preload` only (origin/main). Selective `preload_tools` /
    // `hasPreloadedTools` must not hide a server from deferred discovery instructions.
    const deferredServers = [...this.serverMap.values()].filter(s => !s.preload);
    if (indexed.length === 0 && deferredServers.length === 0) {
      return;
    }
    const parts: string[] = [];
    if (indexed.length > 0) {
      parts.push(TOOL_INDEX_GUIDE, renderIndex(indexed));
    }
    if (deferredServers.length > 0) {
      const deferredList = deferredServers
        .map(s => (s.description ? `- ${s.name}: "${s.description.slice(0, MAX_DESCRIPTION_LENGTH)}"` : `- ${s.name}`))
        .join('\n');
      parts.push(
        `These servers' tools are not listed. Use ${LIST_TOOLS_NAME} with the server name, then ${GET_TOOL_INFO_NAME}, then ${CALL_TOOL_NAME}.\n${deferredList}`,
      );
    }
    builder.addSection(DEFERRED_TOOLS_INSTRUCTION, parts.join('\n\n'));
  }

  /**
   * The indexed tool a server and tool name mean. A tool a not-listed connector really serves
   * stays with that connector, so a built-in tool of the same name never shadows it.
   */
  async resolveIndexedTool(input: { server: string; name: string }): Promise<ToolIndexEntry | undefined> {
    const index = this.index;
    if (index === undefined) {
      return undefined;
    }
    const exact = index.list().find(entry => entry.server === input.server && entry.originalName === input.name);
    if (exact !== undefined) {
      return exact;
    }
    const server = this.resolveServer(input.server);
    if (server !== undefined) {
      // A connector that cannot list its tools right now may still serve this one, so the call
      // stays with call_tool, whose own checks fail closed on an unreachable connector.
      const listed = await server.listTools().catch((error: unknown) => {
        this.logger.warn('Could not list connector tools to resolve an indexed tool', {
          ...extractErrorLogFields(error),
          mcpServer: input.server,
        });
        return undefined;
      });
      if (listed === undefined || isAuthRequired(listed) || listed.result.tools.some(t => t.name === input.name)) {
        return undefined;
      }
    }
    return index.find(input);
  }

  /**
   * Turns each `call_tool` call that names an indexed tool into a direct call of that tool, so it
   * is checked, approved, run and recorded exactly as a direct call. A call naming nothing indexed
   * stays as it is and is judged here, failing closed when it names no tool.
   */
  async toDirectCalls(message: RawAssistantMessage): Promise<{
    message: RawAssistantMessage;
    /** Rewritten call ids, each with the indexed tool it now calls. */
    rewritten: Map<string, ToolIndexEntry>;
  }> {
    const rewritten = new Map<string, ToolIndexEntry>();
    if (message.tool_calls === undefined) {
      return { message, rewritten };
    }
    const calls: RawToolCall[] = [];
    for (const call of message.tool_calls) {
      const wrapper =
        call.function.name === CALL_TOOL_NAME ? tryParseCallToolWrapper(parseToolCallArguments(call) ?? {}) : undefined;
      const entry =
        wrapper === undefined
          ? undefined
          : await this.resolveIndexedTool({ server: wrapper.mcp_server, name: wrapper.tool_name });
      if (wrapper === undefined || entry === undefined) {
        calls.push(call);
        continue;
      }
      rewritten.set(call.id, entry);
      calls.push({ ...call, function: { name: entry.name, arguments: JSON.stringify(wrapper.input) } });
    }
    return { message: { ...message, tool_calls: calls }, rewritten };
  }

  protected getTools(): ToolDefinition[] {
    return this.tools;
  }

  override async toolCallInfo(
    params: CallToolRequest['params'],
    resolveUnderlyingTool?: boolean,
  ): Promise<InternalToolCallInfo> {
    if (params.name !== CALL_TOOL_NAME) {
      return super.toolCallInfo(params, resolveUnderlyingTool);
    }
    if (resolveUnderlyingTool === false) {
      const base = await super.toolCallInfo(params, resolveUnderlyingTool);
      return { ...base, is_deferred: true };
    }
    const parsed = callToolSchema.safeParse(params.arguments);
    if (!parsed.success) {
      this.logger.warn(`Failed to parse call_tool arguments`, {
        tool: params.name,
        errors: parsed.error.issues,
      });
      // A wrapper that does not parse names no real tool, so there is nothing
      // to judge: fail closed with the reason instead of carding call_tool.
      return {
        ...(await super.toolCallInfo(params)),
        is_deferred: true,
        pre_dispatch_failure: {
          kind: 'pre_dispatch_failed',
          message: `${CALL_TOOL_NAME} needs the name of a server, the name of a tool on it, and the tool's arguments.`,
        },
      };
    }
    if (ALIASABLE_META_TOOL_NAMES.has(parsed.data.tool_name)) {
      // Aliased to a local meta tool: same info as calling that meta tool directly, not the
      // underlying server's tool, and never approval-gated.
      const base = await super.toolCallInfo(
        { name: parsed.data.tool_name, arguments: parsed.data.input },
        resolveUnderlyingTool,
      );
      return { ...base, is_deferred: true };
    }
    const server = this.resolveServer(parsed.data.mcp_server);
    if (server) {
      const underlying = await server.toolCallInfo({
        name: parsed.data.tool_name,
        arguments: parsed.data.input,
      });
      return { ...underlying, is_deferred: true };
    }
    this.logger.warn(`Server not found for toolCallInfo`, {
      mcpServer: parsed.data.mcp_server,
      toolName: parsed.data.tool_name,
      availableServers: [...this.serverMap.keys()],
    });
    // An indexed tool never gets here: the thread runs it as a direct call. Whatever is left names
    // no tool at all, so fail closed with the reason, never with an approval card for call_tool.
    return {
      ...(await super.toolCallInfo(params)),
      is_deferred: true,
      pre_dispatch_failure: {
        kind: 'pre_dispatch_failed',
        message: this.serverNotFoundText({ mcpServer: parsed.data.mcp_server, toolName: parsed.data.tool_name }),
      },
    };
  }

  /**
   * The params an approval for a `call_tool` call is re-checked against at dispatch, as the
   * wrapped connector re-derives them, exactly as for a direct call to it. The wrapper's own
   * tools bind only to their arguments, so anything that is not a resolved server returns undefined.
   */
  async liveMintParams(params: CallToolRequest['params']): Promise<Record<string, unknown> | undefined> {
    if (params.name !== CALL_TOOL_NAME) {
      return undefined;
    }
    const parsed = callToolSchema.safeParse(params.arguments);
    if (!parsed.success || ALIASABLE_META_TOOL_NAMES.has(parsed.data.tool_name)) {
      return undefined;
    }
    const server = this.resolveServer(parsed.data.mcp_server);
    return server?.liveMintParams?.({ name: parsed.data.tool_name, arguments: parsed.data.input });
  }

  /** The connector a `call_tool` wrapper will reach right now, as its own tool set reports it. */
  resolveConnector(params: CallToolRequest['params']): ConnectorBinding | undefined {
    if (params.name !== CALL_TOOL_NAME) {
      return undefined;
    }
    const parsed = callToolSchema.safeParse(params.arguments);
    if (!parsed.success || ALIASABLE_META_TOOL_NAMES.has(parsed.data.tool_name)) {
      return undefined;
    }
    const server = this.resolveServer(parsed.data.mcp_server);
    return server?.resolveConnector?.({
      name: parsed.data.tool_name,
      arguments: parsed.data.input,
    });
  }

  private resolveServer(name: string): IToolSet | undefined {
    return this.serverMap.get(name);
  }

  /** Short and plain: the servers that exist, and where an indexed tool is called instead. */
  private serverNotFoundText(input: { mcpServer: string; toolName: string | undefined }): string {
    const indexed =
      input.toolName === undefined ? undefined : this.index?.find({ server: input.mcpServer, name: input.toolName });
    if (indexed !== undefined) {
      return `'${indexed.name}' is in the tool index. Call ${indexed.name} directly by name.`;
    }
    const onServer = (this.index?.list() ?? []).filter(entry => entry.server === input.mcpServer);
    if (onServer.length > 0) {
      return `'${input.mcpServer}' has no tool named '${input.toolName ?? ''}'. Its tools: ${boundedNameList(onServer.map(entry => entry.name))}.`;
    }
    const indexedServers = new Set((this.index?.list() ?? []).map(entry => entry.server));
    const servers = [...this.serverMap.keys(), ...indexedServers];
    const serverList = servers.length === 0 ? 'none' : boundedNameList(servers);
    const next =
      indexedServers.size > 0
        ? 'Use a server and tool name from the tool index.'
        : 'Built-in tools are called directly by name, not through list_tools.';
    return `No server named '${input.mcpServer}'. Servers: ${serverList}. ${next}`;
  }

  private serverNotFoundResponse(input: { mcpServer: string; toolName: string | undefined }): CallToolResponse {
    return toolResultResponse({
      text: JSON.stringify({ error: this.serverNotFoundText(input) }),
      isError: true,
    });
  }

  private async resolveServerTools(input: { mcpServer: string }): Promise<CallToolResponse | ResolvedServerTools> {
    const server = this.resolveServer(input.mcpServer);
    if (!server) {
      return this.serverNotFoundResponse({ mcpServer: input.mcpServer, toolName: undefined });
    }

    const listResponse = await server.listTools();
    if (isAuthRequired(listResponse)) {
      return listResponse;
    }
    const { result, ...metadata } = listResponse;
    return { server, tools: result.tools, metadata };
  }

  private buildTools(): ToolDefinition[] {
    return [this.buildListTools(), this.buildGetToolInfo(), this.buildGetToolOutputSchema(), this.buildCallTool()];
  }

  private async runListTools(input: { mcp_server: string }): Promise<CallToolResponse> {
    try {
      const indexed = (this.index?.list() ?? []).filter(entry => entry.server === input.mcp_server);
      if (indexed.length > 0 && this.resolveServer(input.mcp_server) === undefined) {
        return toolResultResponse({ text: `${input.mcp_server}:\n  ${indexed.map(entry => entry.name).join(', ')}` });
      }
      const resolved = await this.resolveServerTools({ mcpServer: input.mcp_server });
      if (!isResolvedServerTools(resolved)) {
        return resolved;
      }
      const { server, tools, metadata } = resolved;
      return toolResultResponse({
        text: `${server.name}:\n  ${tools.map(t => t.name).join(', ')}`,
        overrides: metadata,
      });
    } catch (error) {
      this.logger.error('list_tools failed', {
        ...extractErrorLogFields(error),
        mcpServer: input.mcp_server,
      });
      return toolResultResponse({
        text: JSON.stringify({ error: `Failed to list tools for '${input.mcp_server}'.` }),
        isError: true,
      });
    }
  }

  private buildListTools(): ToolDefinition {
    return defineTool({
      name: LIST_TOOLS_NAME,
      description: dedent`
        List tool names available on an MCP server.
        Returns tool names only — use ${GET_TOOL_INFO_NAME} to get full details before calling a tool.`,
      schema: listToolsSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (input: { mcp_server: string }) => this.runListTools(input),
    });
  }

  private async runGetToolInfo(input: { mcp_server: string; tool_name: string }): Promise<CallToolResponse> {
    try {
      const indexed = await this.resolveIndexedTool({ server: input.mcp_server, name: input.tool_name });
      if (indexed !== undefined) {
        return toolResultResponse({
          text: JSON.stringify({
            description: indexed.definition.function.description ?? indexed.summary,
            inputSchema: indexed.definition.function.parameters ?? {},
            outputSchema: null,
            next_step: `Call ${indexed.name} directly by name. It stays loaded for the rest of this chat.`,
          }),
        });
      }
      const resolved = await this.resolveServerTools({ mcpServer: input.mcp_server });
      if (!isResolvedServerTools(resolved)) {
        return resolved;
      }
      const { tools, metadata } = resolved;
      const tool = tools.find(t => t.name === input.tool_name);
      if (!tool) {
        return toolResultResponse({
          text: JSON.stringify({
            error: structuredEditRejection({
              tool: GET_TOOL_INFO_NAME,
              what: 'the tool_name',
              received: `'${input.tool_name}'`,
              expected: `the name of a tool on '${input.mcp_server}'`,
              hint: `Tools on '${input.mcp_server}': ${boundedNameList(tools.map(t => t.name))}.`,
            }),
          }),
          overrides: metadata,
          isError: true,
        });
      }

      return toolResultResponse({
        text: JSON.stringify({
          description: tool.description,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
        }),
        overrides: metadata,
      });
    } catch (error) {
      this.logger.error('get_tool_info failed', {
        ...extractErrorLogFields(error),
        mcpServer: input.mcp_server,
        toolName: input.tool_name,
      });
      return toolResultResponse({
        text: JSON.stringify({
          error: `Failed to get tool info: ${error instanceof Error ? error.message : 'unknown'}`,
        }),
        isError: true,
      });
    }
  }

  private buildGetToolInfo(): ToolDefinition {
    return defineTool({
      name: GET_TOOL_INFO_NAME,
      description: dedent`
        Get description, inputSchema and outputSchema for a tool, by its server and name.
        If outputSchema is null, it will NOT be present in ${GET_TOOL_OUTPUT_SCHEMA_NAME} as well.
        For a server not in the tool index, call ${LIST_TOOLS_NAME} first to know which tools it has.`,
      schema: getToolInfoSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (input: { mcp_server: string; tool_name: string }) => this.runGetToolInfo(input),
    });
  }

  private async runGetToolOutputSchema(input: { mcp_server: string; tool_name: string }): Promise<CallToolResponse> {
    try {
      if ((await this.resolveIndexedTool({ server: input.mcp_server, name: input.tool_name })) !== undefined) {
        return toolResultResponse({ text: JSON.stringify({ outputSchema: null }) });
      }
      const resolved = await this.resolveServerTools({ mcpServer: input.mcp_server });
      if (!isResolvedServerTools(resolved)) {
        return resolved;
      }
      const { tools, metadata } = resolved;
      const tool = tools.find(t => t.name === input.tool_name);
      if (!tool) {
        return toolResultResponse({
          text: JSON.stringify({
            error: structuredEditRejection({
              tool: GET_TOOL_OUTPUT_SCHEMA_NAME,
              what: 'the tool_name',
              received: `'${input.tool_name}'`,
              expected: `the name of a tool on '${input.mcp_server}'`,
              hint: `Tools on '${input.mcp_server}': ${boundedNameList(tools.map(t => t.name))}.`,
            }),
          }),
          overrides: metadata,
          isError: true,
        });
      }

      return toolResultResponse({
        text: JSON.stringify({
          outputSchema: tool.outputSchema ?? null,
        }),
        overrides: metadata,
      });
    } catch (error) {
      this.logger.error('get_tool_output_schema failed', {
        ...extractErrorLogFields(error),
        mcpServer: input.mcp_server,
        toolName: input.tool_name,
      });
      return toolResultResponse({
        text: JSON.stringify({
          error: `Failed to get output schema: ${error instanceof Error ? error.message : 'unknown'}`,
        }),
        isError: true,
      });
    }
  }

  private buildGetToolOutputSchema(): ToolDefinition {
    return defineTool({
      name: GET_TOOL_OUTPUT_SCHEMA_NAME,
      description: dedent`
        Get the outputSchema for a specific tool on an MCP server.
        The Agent MUST not call ${GET_TOOL_OUTPUT_SCHEMA_NAME} and ${GET_TOOL_INFO_NAME} for the same tool.
        The Agent MUST either call ${GET_TOOL_OUTPUT_SCHEMA_NAME} or ${GET_TOOL_INFO_NAME} before entering Code Mode.
        The Agent must NOT assume the structure of a tool's response from its name or description alone.`,
      schema: getToolOutputSchemaSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (input: { mcp_server: string; tool_name: string }) => this.runGetToolOutputSchema(input),
    });
  }

  /**
   * Runs a meta tool named as `call_tool`'s `tool_name`, aliasing the call instead of rejecting
   * it. `args` is `call_tool`'s `input` field, i.e. the arguments meant for the meta tool.
   */
  private async runMetaToolAlias(
    metaTool: string,
    mcpServer: string,
    args: Record<string, unknown>,
  ): Promise<CallToolResponse> {
    if (metaTool === LIST_TOOLS_NAME) {
      return this.runListTools({ mcp_server: mcpServer });
    }
    if (metaTool === GET_TOOL_INFO_NAME) {
      const parsed = getToolInfoSchema.safeParse({ mcp_server: mcpServer, ...args });
      if (!parsed.success) {
        return this.metaToolAliasArgumentError(metaTool);
      }
      return this.runGetToolInfo(parsed.data);
    }
    const parsed = getToolOutputSchemaSchema.safeParse({ mcp_server: mcpServer, ...args });
    if (!parsed.success) {
      return this.metaToolAliasArgumentError(metaTool);
    }
    return this.runGetToolOutputSchema(parsed.data);
  }

  private metaToolAliasArgumentError(metaTool: string): CallToolResponse {
    return toolResultResponse({
      text: JSON.stringify({
        error: structuredEditRejection({
          tool: CALL_TOOL_NAME,
          what: 'the input',
          received: 'input missing tool_name',
          expected: `arguments for '${metaTool}': { tool_name }`,
          hint: `Call ${CALL_TOOL_NAME} with tool_name '${metaTool}' and input.tool_name set to the tool to inspect.`,
        }),
      }),
      isError: true,
    });
  }

  private buildCallTool(): ToolDefinition {
    return defineTool({
      name: CALL_TOOL_NAME,
      description: dedent`
        Call a tool by its server and name.
        The Agent MUST call ${GET_TOOL_INFO_NAME} before calling a tool, and should call a tool from the tool index directly by name.
        ${LIST_TOOLS_NAME}, ${GET_TOOL_INFO_NAME} and ${GET_TOOL_OUTPUT_SCHEMA_NAME} are also accepted as
        ${CALL_TOOL_NAME}'s tool_name: it runs that meta tool directly with the given input, since they
        are meta tools rather than tools on an MCP server.`,
      schema: callToolSchema,
      handler: async (
        input: { mcp_server: string; tool_name: string; input: Record<string, unknown> },
        approvalDecision?: ApprovalDecision,
        context?: ToolInvocationContext,
      ) => {
        const server = this.resolveServer(input.mcp_server);
        if (!server) {
          return this.serverNotFoundResponse({ mcpServer: input.mcp_server, toolName: input.tool_name });
        }

        if (ALIASABLE_META_TOOL_NAMES.has(input.tool_name)) {
          return this.runMetaToolAlias(input.tool_name, input.mcp_server, input.input);
        }

        if (META_TOOL_NAMES.has(input.tool_name)) {
          return toolResultResponse({
            text: JSON.stringify({
              error: structuredEditRejection({
                tool: CALL_TOOL_NAME,
                what: 'the tool_name',
                received: `'${input.tool_name}'`,
                expected: `the name of a tool on '${input.mcp_server}'`,
                hint: `'${input.tool_name}' is a top-level tool, not a server tool; call it directly instead of through ${CALL_TOOL_NAME}.`,
              }),
            }),
            isError: true,
          });
        }

        try {
          const resolved = await this.resolveServerTools({ mcpServer: input.mcp_server });
          if (!isResolvedServerTools(resolved)) {
            return resolved;
          }
          if (!resolved.tools.some(t => t.name === input.tool_name)) {
            const indexed = this.index?.find({ server: input.mcp_server, name: input.tool_name });
            return toolResultResponse({
              text: JSON.stringify({
                error: structuredEditRejection({
                  tool: CALL_TOOL_NAME,
                  what: 'the tool_name',
                  received: `'${input.tool_name}'`,
                  expected: `the name of a tool on '${input.mcp_server}'`,
                  hint:
                    indexed === undefined
                      ? `Tools on '${input.mcp_server}': ${boundedNameList(resolved.tools.map(t => t.name))}.`
                      : `'${indexed.name}' is in the tool index. Call ${indexed.name} directly by name.`,
                }),
              }),
              isError: true,
            });
          }

          const response = await server.callTool(
            { name: input.tool_name, arguments: input.input },
            approvalDecision,
            context,
          );

          if (isAuthRequired(response)) {
            return response;
          }

          if (isApprovalRequiredResponse(response)) {
            return response;
          }

          if (!isCallToolResponseResult(response)) {
            throw new Error('Tool call returned an unexpected sub-agent response');
          }

          return response;
        } catch (error) {
          this.logger.error('call_tool failed', {
            ...extractErrorLogFields(error),
            mcpServer: input.mcp_server,
            toolName: input.tool_name,
          });
          return toolResultResponse({
            text: JSON.stringify({ error: `Tool call failed: ${error instanceof Error ? error.message : 'unknown'}` }),
            isError: true,
          });
        }
      },
    });
  }
}
