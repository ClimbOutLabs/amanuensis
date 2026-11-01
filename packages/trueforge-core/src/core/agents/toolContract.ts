/**
 * Canonical owner of the agent tool names. Saving an agent always asks first. Nothing here edits or deletes
 * an agent.
 */
export const AGENT_SERVER_ID = 'agents';

export const CREATE_AGENT_TOOL_NAME = 'create_agent';

/** Calls that save a new agent and so show an approval card first. */
export function isAgentWriteToolName(tool_name: string): boolean {
  return tool_name === CREATE_AGENT_TOOL_NAME;
}
