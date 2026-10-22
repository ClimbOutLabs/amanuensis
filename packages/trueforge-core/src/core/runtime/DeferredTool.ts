import type { CallToolRequest } from '@modelcontextprotocol/sdk/types.js';
import dedent from 'dedent';
import type { Logger } from 'winston';
import { z } from 'zod';
import type { ApprovalDecision } from '../events/schema';
import { InstructionBuilder } from '../InstructionBuilder';
import type { InternalToolCallInfo } from '../llm/LLMTypes';
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
import type { ConnectorBinding } from '../permissions/approvalTokens';
import { structuredEditRejection } from '../sandbox/structuredEditRejection';
import type { AgentTracing } from '../tracing/AgentTracing';
import { extractErrorLogFields } from '../util/errorLogFields';
import { LOAD_BUNDLE_TOOL_NAME } from './ToolBundles';

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
  private readonly bundled: boolean;

  constructor(
    servers: readonly IToolSet[],
    options: {
      tracing: AgentTracing;
      logger: Logger;
      /** Whether built-in tools come in bundles, so a missing one is loaded with load_bundle. */
      bundled: boolean;
    },
  ) {
    super({ tracing: options.tracing });
    this.logger = options.logger.child({ module: 'DeferredTool' });
    this.bundled = options.bundled;
    this.serverMap = new Map(servers.map(s => [s.name, s]));
    this.tools = this.buildTools();
  }

  buildInstruction(builder: InstructionBuilder): void {
    const servers = [...this.serverMap.values()];

    // Membership follows `preload` only (origin/main). Selective `preload_tools` /
    // `hasPreloadedTools` must not hide a server from deferred discovery instructions.
    const deferredServers = servers.filter(s => !s.preload);

    if (deferredServers.length === 0) {
      return;
    }

    const deferredList = deferredServers
      .map(s => (s.description ? `- ${s.name}: "${s.description.slice(0, MAX_DESCRIPTION_LENGTH)}"` : `- ${s.name}`))
      .join('\n');

    builder.addSection(
      DEFERRED_TOOLS_INSTRUCTION,
      dedent`
        The following MCP servers have deferred tool loading. Their tools are NOT pre-loaded.
        ${deferredList}

        The Agent MUST use ${LIST_TOOLS_NAME} and ${GET_TOOL_INFO_NAME} to discover tools before calling them.
        Built-in tools are called directly by name, never through ${LIST_TOOLS_NAME}.`,
    );
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
    // A built-in tool is never run through call_tool, and anything else names no connector:
    // fail closed with the reason, never with an approval card for call_tool.
    return {
      ...(await super.toolCallInfo(params)),
      is_deferred: true,
      pre_dispatch_failure: {
        kind: 'pre_dispatch_failed',
        message: this.serverNotFoundText(parsed.data.mcp_server),
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

  /**
   * Short and plain: the connectors that exist, then where built-in tools live. Built-in tools are never on a
   * connector, so models that look for one through call_tool need the reminder, not a structured rejection.
   */
  private serverNotFoundText(mcpServer: string): string {
    const servers = [...this.serverMap.keys()];
    const serverList = servers.length === 0 ? 'none' : boundedNameList(servers);
    const builtIn = `Built-in tools are called directly by name, never through ${CALL_TOOL_NAME}`;
    const missing = this.bundled
      ? `; when one is not in your tool list, call ${LOAD_BUNDLE_TOOL_NAME} with its bundle first.`
      : '.';
    return `No server named '${mcpServer}'. Servers: ${serverList}. ${builtIn}${missing}`;
  }

  private serverNotFoundResponse(mcpServer: string): CallToolResponse {
    return toolResultResponse({
      text: JSON.stringify({ error: this.serverNotFoundText(mcpServer) }),
      isError: true,
    });
  }

  private async resolveServerTools(input: { mcpServer: string }): Promise<CallToolResponse | ResolvedServerTools> {
    const server = this.resolveServer(input.mcpServer);
    if (!server) {
      return this.serverNotFoundResponse(input.mcpServer);
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
        Call ${LIST_TOOLS_NAME} first to know which tools a server has.`,
      schema: getToolInfoSchema,
      annotations: { readOnlyHint: true, openWorldHint: false },
      handler: async (input: { mcp_server: string; tool_name: string }) => this.runGetToolInfo(input),
    });
  }

  private async runGetToolOutputSchema(input: { mcp_server: string; tool_name: string }): Promise<CallToolResponse> {
    try {
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
        The Agent MUST call ${GET_TOOL_INFO_NAME} before calling a tool. Built-in tools are called directly by name, never through ${CALL_TOOL_NAME}.
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
          return this.serverNotFoundResponse(input.mcp_server);
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
            return toolResultResponse({
              text: JSON.stringify({
                error: structuredEditRejection({
                  tool: CALL_TOOL_NAME,
                  what: 'the tool_name',
                  received: `'${input.tool_name}'`,
                  expected: `the name of a tool on '${input.mcp_server}'`,
                  hint: `Tools on '${input.mcp_server}': ${boundedNameList(resolved.tools.map(t => t.name))}. A built-in tool is called directly by its name, never through ${CALL_TOOL_NAME}.`,
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
