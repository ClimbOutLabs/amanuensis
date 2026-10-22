import type { AgentSpec } from './schemas/agentSpec';

/**
 * Narrows one connector's mount on a turn to the tools named here, preloaded, so the model is offered
 * exactly those and a hidden tool cannot be called. A connector the spec does not mount is left alone.
 * `disable_tools` stays as configured, so a user can still subtract from what remains.
 */
export function narrowConnectorTools(
  spec: AgentSpec,
  { server_name, tools }: { server_name: string; tools: readonly string[] },
): AgentSpec {
  const servers = spec.mcp_servers;
  if (!servers?.some(entry => entry.name === server_name)) {
    return spec;
  }
  return {
    ...spec,
    mcp_servers: servers.map(entry =>
      entry.name === server_name ? { ...entry, enable_tools: [...tools], preload: true } : entry,
    ),
  };
}
