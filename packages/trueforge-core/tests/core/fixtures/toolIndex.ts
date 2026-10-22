import { type ConvertToolsResult, convertMCPServersToTools } from '../../../src/core/mcp/convertMCPServers';
import type { IToolSet } from '../../../src/core/mcp/IMCPServer';
import { ToolIndex } from '../../../src/core/runtime/ToolIndex';

/** A tool index over built-in tool sets, built the way the thread builds it, with their converted tools. */
export async function builtInToolIndex(
  builtIns: IToolSet[],
): Promise<{ index: ToolIndex; converted: ConvertToolsResult }> {
  const index = new ToolIndex();
  const { convertedTools } = await convertMCPServersToTools({ tfyManagedServers: builtIns, userServers: [] });
  index.load({ converted: convertedTools, metaToolSet: undefined, deferredServers: true });
  return { index, converted: convertedTools };
}
