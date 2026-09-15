import { dynamicSubAgents } from '../../../../src/core/capabilities/builtins/DynamicSubAgents';
import { isCallToolResponseCreateSubAgent } from '../../../../src/core/mcp/IMCPServer';
import { NOOP_AGENT_TRACING } from '../../../../src/core/tracing/NoopAgentTracing';

describe('dynamicSubAgents coding workspace handoff', () => {
  it('preserves an explicit local checkout in the child request', async () => {
    const capability = dynamicSubAgents({ sandboxAvailable: true, tracing: NOOP_AGENT_TRACING });
    const toolSet = capability.systemToolSets?.[0];
    const listed = await toolSet?.listTools();
    if (!listed || 'authRequired' in listed) throw new Error('expected sub-agent tool');

    expect(listed.result.tools[0]?.inputSchema).toMatchObject({
      properties: { workspace_cwd: { type: 'string' } },
    });

    const response = await toolSet?.callTool({
      name: 'create_sub_agent',
      arguments: {
        name: 'reviewer',
        input: 'Review the focused diff.',
        workspace_cwd: '/workspace/amanuensis',
      },
    });
    if (!response || !isCallToolResponseCreateSubAgent(response)) throw new Error('expected sub-agent response');

    expect(response.createSubAgent).toMatchObject({
      input: 'Review the focused diff.',
      workspace_cwd: '/workspace/amanuensis',
    });
  });
});
