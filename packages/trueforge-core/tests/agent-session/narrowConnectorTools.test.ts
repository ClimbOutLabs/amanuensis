import { narrowConnectorTools } from '../../src/agent-session/narrowConnectorTools';
import { AgentSpecSchema } from '../../src/agent-session/schemas/agentSpec';
import { makeAgentSpec } from './testHelpers';

function specWithMounts(names: Array<Record<string, unknown>>) {
  return { ...makeAgentSpec(), mcp_servers: AgentSpecSchema.shape.mcp_servers.unwrap().parse(names) };
}

const TOOLS = ['list_emails_metadata', 'send_email'];

describe('narrowConnectorTools', () => {
  it('replaces the enabled tools of the named mount, preloaded, and leaves other mounts alone', () => {
    const spec = specWithMounts([{ name: 'Email', enable_tools: ['@all'] }, { name: 'other' }]);
    const narrowed = narrowConnectorTools(spec, { server_name: 'Email', tools: TOOLS });
    expect(narrowed.mcp_servers?.[0]).toMatchObject({ name: 'Email', enable_tools: TOOLS, preload: true });
    expect(narrowed.mcp_servers?.[1]).toEqual(spec.mcp_servers?.[1]);
  });

  it('returns the spec unchanged when the connector is not mounted', () => {
    const spec = specWithMounts([{ name: 'other' }]);
    expect(narrowConnectorTools(spec, { server_name: 'Email', tools: TOOLS })).toBe(spec);
  });
});
