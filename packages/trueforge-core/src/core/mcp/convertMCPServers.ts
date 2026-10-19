import type { ChatCompletionTool } from 'openai/resources/chat';
import type { MCPServerInitInfo } from '../events/schema';
import type { MCPAuthRequired } from '../mcp/IMCPServer';
import { type IToolSet, isAuthRequired } from './IMCPServer';
import { getUniqueSanitizedToolName } from './toolNames';

export interface MappedMCPTool {
  toolSet: IToolSet;
  originalToolName: string;
}

export interface ConvertToolsResult {
  tools: ChatCompletionTool[];
  toolMapping: Map<string, MappedMCPTool>;
}

export interface ConvertMCPServersToToolsResult {
  convertedTools: ConvertToolsResult;
  initializationInfo: MCPServerInitInfo[];
  authRequirementInfo: MCPAuthRequired[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The member types of a union-shaped schema (anyOf, oneOf, or a type list); undefined when not a union. */
function unionMemberTypes(schema: Record<string, unknown>): string[] | undefined {
  const members = schema['anyOf'] ?? schema['oneOf'];
  if (Array.isArray(members)) {
    const types: string[] = [];
    for (const member of members) {
      if (!isRecord(member) || typeof member['type'] !== 'string') {
        return undefined;
      }
      types.push(member['type']);
    }
    return types;
  }
  if (Array.isArray(schema['type'])) {
    return schema['type'].filter((entry): entry is string => typeof entry === 'string');
  }
  return undefined;
}

/**
 * One property schema with boolean-or-nothing unions collapsed to a plain boolean, recursing
 * into nested objects and list items. Some tool servers declare a simple true/false argument as
 * an either-or (a boolean or null); offered that way, models answer it with junk like "[" and
 * the call fails inside the provider. A plain true/false type is all the argument ever meant.
 * Anything that is not exactly a boolean-or-null union is returned unchanged.
 */
export function plainBooleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const memberTypes = unionMemberTypes(schema);
  if (
    memberTypes !== undefined &&
    memberTypes.length > 0 &&
    memberTypes.every(type => type === 'boolean' || type === 'null') &&
    memberTypes.includes('boolean')
  ) {
    const rest: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(schema)) {
      if (key !== 'anyOf' && key !== 'oneOf' && key !== 'type') {
        rest[key] = value;
      }
    }
    return { ...rest, type: 'boolean' };
  }
  const result: Record<string, unknown> = { ...schema };
  if (isRecord(schema['properties'])) {
    result['properties'] = Object.fromEntries(
      Object.entries(schema['properties']).map(([key, value]) => [
        key,
        isRecord(value) ? plainBooleanSchema(value) : value,
      ]),
    );
  }
  if (isRecord(schema['items'])) {
    result['items'] = plainBooleanSchema(schema['items']);
  }
  return result;
}

export async function convertMCPServersToTools(params: {
  tfyManagedServers: IToolSet[];
  userServers: IToolSet[];
}): Promise<ConvertMCPServersToToolsResult> {
  const { tfyManagedServers, userServers } = params;
  const tools: ChatCompletionTool[] = [];
  const toolMapping = new Map<string, MappedMCPTool>();
  const initializationInfo: MCPServerInitInfo[] = [];
  const authRequirementInfo: MCPAuthRequired[] = [];
  const registeredNames = new Set<string>();

  // Skip non-preloaded servers that have no preloaded tools, to avoid unnecessary listTools() calls and OAuth triggers.
  // Non-preloaded servers with some preloaded tools are kept so those tools can be registered.
  // A server whose auto-preload is still pending (spec left `preload` unset) is also kept: its
  // tool count is unknown until listTools() runs, so skipping it here would mean it can never
  // become preloaded, defeating auto-preload for small connectors entirely.
  const filteredUserServers = userServers.filter(s => s.preload || s.hasPreloadedTools || s.preloadPending);

  // TFY-managed servers first so they claim their original tool names before user servers.
  const sortedTfyServers = [...tfyManagedServers].sort((a, b) => (a.name > b.name ? 1 : -1));
  const sortedUserServers = [...filteredUserServers].sort((a, b) => (a.name > b.name ? 1 : -1));
  const allServers = [...sortedTfyServers, ...sortedUserServers];
  const managedServers = new Set(tfyManagedServers);

  const listResults = await Promise.all(
    allServers.map(async server => ({ serverName: server.name, response: await server.listTools() })),
  );

  for (let i = 0; i < allServers.length; i++) {
    const listResult = listResults[i];
    if (!listResult) {
      continue;
    }
    const { serverName, response: listResponse } = listResult;
    if (isAuthRequired(listResponse)) {
      authRequirementInfo.push(listResponse.authRequired);
      continue;
    }
    const { result: mcpTools, wasInitialized } = listResponse;
    if (wasInitialized) {
      initializationInfo.push(wasInitialized);
    }

    const toolSet = allServers[i];
    if (toolSet === undefined) {
      throw new Error(`Unreachable: missing tool set at index ${String(i)}`);
    }
    const sortedTools = [...mcpTools.tools].sort((a, b) => (a.name > b.name ? 1 : -1));
    for (const mcpTool of sortedTools) {
      if (!mcpTool.preload) {
        continue;
      }
      const { name: toolName } = getUniqueSanitizedToolName(mcpTool.name, registeredNames);
      registeredNames.add(toolName);
      const description = `mcp server: ${serverName}\n${mcpTool.description ?? ''}`;
      tools.push({
        type: 'function',
        function: {
          name: toolName,
          description: description,
          ...(managedServers.has(toolSet) ? { strict: true } : {}),
          parameters: {
            type: 'object',
            properties: Object.fromEntries(
              Object.entries(mcpTool.inputSchema.properties ?? {}).map(([key, value]) => [
                key,
                isRecord(value) ? plainBooleanSchema(value) : value,
              ]),
            ),
            required: mcpTool.inputSchema.required ?? [],
            ...(managedServers.has(toolSet) ? { additionalProperties: false } : {}),
          },
        },
      });

      toolMapping.set(toolName, {
        toolSet,
        originalToolName: mcpTool.name,
      });
    }
  }

  return { convertedTools: { tools, toolMapping }, initializationInfo, authRequirementInfo };
}
