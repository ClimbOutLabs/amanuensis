import { z } from 'zod';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool, LocalToolMCP, type ToolDefinition } from '../../../src/core/mcp/LocalToolMCP';
import { convertMCPServersToTools } from '../../../src/core/mcp/convertMCPServers';
import { classifyTier, type ClassifyContext, type SentinelAction } from '../../../src/core/permissions/classifier';
import { defaultSentinelServices } from '../../../src/core/permissions/context';
import { requiresNetwork } from '../../../src/core/permissions/networkRequirements';
import { createWebSearchTurnState } from '../../../src/core/permissions/webSearch';
import { NOOP_AGENT_TRACING } from '../../../src/core/tracing/NoopAgentTracing';

/**
 * Finding 9: offline mode reads the declaration each tool makes where it is registered.
 * The tools here are invented for this test: no table anywhere names them, so whatever
 * offline mode does with them comes from their own declarations alone.
 */

class InventedTools extends LocalToolMCP {
  readonly name = 'invented-tools';
  readonly displayName = 'Invented tools';
  private readonly tools: ToolDefinition[];

  constructor(tools: ToolDefinition[]) {
    super({ tracing: NOOP_AGENT_TRACING });
    this.tools = tools;
  }

  protected override getTools(): ToolDefinition[] {
    return this.tools;
  }
}

function inventedTool(name: string, requiresNetworkValue: boolean): ToolDefinition {
  return defineTool({
    name,
    description: `${name} does one invented thing.`,
    schema: z.object({}).strict(),
    requiresNetwork: requiresNetworkValue,
    handler: async () => toolResultResponse({ text: 'done' }),
  });
}

describe('requiresNetwork reads the registration declaration', () => {
  it('a tool declaring it needs no network is let through offline', () => {
    expect(requiresNetwork({ declared: false })).toBe(false);
  });

  it('a tool declaring it needs the network is blocked offline', () => {
    expect(requiresNetwork({ declared: true })).toBe(true);
  });

  it('a call with no declaration reads as needing the network, never as safe by default', () => {
    expect(requiresNetwork({ declared: undefined })).toBe(true);
  });
});

describe('the registry refuses a tool that declares nothing', () => {
  it('listing a tool set whose tool carries no declaration fails loudly and names the tool', async () => {
    // A definition whose declaration was stripped after registration, as a registry built
    // outside the typed registration path could produce: listing must fail, not default.
    const stripped = inventedTool('silent_moth', false);
    const holder: { requires_network?: boolean | undefined } = stripped;
    delete holder.requires_network;
    const set = new InventedTools([stripped]);
    expect(() => set.listTools()).toThrow(/silent_moth.*does not declare/);
  });

  it('a declared invented tool lists with its declaration showing', async () => {
    const set = new InventedTools([inventedTool('pocket_abacus', false), inventedTool('crystal_ball_lookup', true)]);
    const listed = await set.listTools();
    const byName = new Map(listed.result.tools.map(t => [t.name, t.requires_network]));
    expect(byName.get('pocket_abacus')).toBe(false);
    expect(byName.get('crystal_ball_lookup')).toBe(true);
  });
});

describe('offline mode follows the declaration end to end', () => {
  function offlineCtx(): ClassifyContext {
    const services = defaultSentinelServices({ pinned_path: '/usr/bin:/bin' });
    services.isOffline = () => Promise.resolve(true);
    return {
      services,
      tenant_id: 't1',
      created_by: 'u1',
      conversation_id: 'conv-1',
      repository_id: 'r1',
      workspace_cwd: null,
      agent_intent: null,
      web_search: createWebSearchTurnState(),
    };
  }

  function inventedAction(tool_name: string, declared: boolean): SentinelAction {
    return {
      tool_name,
      canonical_params: {},
      tool_type: 'truefoundry-system',
      mcp_hints: {},
      requires_network: declared,
    };
  }

  it('an invented tool declaring no network need is not auto-denied offline', async () => {
    const decision = await classifyTier(inventedAction('pocket_abacus', false), offlineCtx());
    expect(decision.auto_deny).not.toBe('offline_mode');
  });

  it('an invented tool declaring a network need is auto-denied offline', async () => {
    const decision = await classifyTier(inventedAction('crystal_ball_lookup', true), offlineCtx());
    expect(decision.tier).toBe(3);
    expect(decision.auto_deny).toBe('offline_mode');
  });

  it('the listed tool mapping carries the declaration the offline filter reads', async () => {
    const set = new InventedTools([inventedTool('pocket_abacus', false), inventedTool('crystal_ball_lookup', true)]);
    const { convertedTools } = await convertMCPServersToTools({
      tfyManagedServers: [set],
      userServers: [],
    });
    // The same read the thread's offline filter makes over the mapping.
    const visibleOffline = convertedTools.tools.filter(tool => {
      if (tool.type !== 'function') {
        return true;
      }
      const info = convertedTools.toolMapping.get(tool.function.name);
      return info === undefined || !requiresNetwork({ declared: info.requires_network });
    });
    const names = visibleOffline.map(t => (t.type === 'function' ? t.function.name : ''));
    expect(names.some(n => n.includes('pocket_abacus'))).toBe(true);
    expect(names.some(n => n.includes('crystal_ball_lookup'))).toBe(false);
  });
});
