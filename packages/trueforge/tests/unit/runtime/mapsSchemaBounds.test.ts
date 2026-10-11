import type { AgentTracing } from '@truefoundry/trueforge-core/core';
import { mapsCapability } from '../../../src/runtime/mapsCapability';

/**
 * The inference engine crashes on tool JSON schema bounds over 128
 * (maxLength/maxItems/minLength/minItems, regex quantifiers). Every maps tool
 * schema bound must stay at or under 128.
 */
describe('maps tool schema bounds', () => {
  const tracing = {} as AgentTracing;
  const logger = { error: jest.fn(), warn: jest.fn(), info: jest.fn() } as never;

  function getServer() {
    const capability = mapsCapability({ tracing, logger });
    const server = capability.systemToolSets?.[0];
    if (server === undefined) {
      throw new Error('maps capability has no tool sets');
    }
    return server;
  }

  it('emits schemas with no bound over 128 and no regex patterns', () => {
    const server = getServer();
    return server.listTools().then(response => {
      const tools = 'result' in response ? response.result.tools : [];
      expect(tools.map(t => t.name).sort()).toEqual(['render_map', 'render_route']);
      for (const tool of tools) {
        const schema = JSON.stringify(tool.inputSchema);
        expect(schema).not.toMatch(/"pattern"/);
        const bounds = [...schema.matchAll(/"(?:maxLength|maxItems|minLength|minItems)"\s*:\s*(\d+)/g)];
        for (const [, value] of bounds) {
          expect(Number(value)).toBeLessThanOrEqual(128);
        }
        // No numeric {n,m} regex quantifiers either.
        expect(schema).not.toMatch(/\{\d+,\d+\}/);
      }
    });
  });

  it('render_map schema caps place_name at 128 and poi at 64', async () => {
    const response = await getServer().listTools();
    const tools = 'result' in response ? response.result.tools : [];
    const renderMap = tools.find(t => t.name === 'render_map')!;
    const props = (renderMap.inputSchema as { properties: Record<string, { maxLength?: number }> }).properties;
    expect(props['place_name']?.maxLength).toBe(128);
    expect(props['poi']?.maxLength).toBe(64);
  });

  it('zoom is an integer 1..18', async () => {
    const response = await getServer().listTools();
    const tools = 'result' in response ? response.result.tools : [];
    const renderMap = tools.find(t => t.name === 'render_map')!;
    const props = (renderMap.inputSchema as { properties: Record<string, { maximum?: number; minimum?: number }> })
      .properties;
    expect(props['zoom']?.minimum).toBe(1);
    expect(props['zoom']?.maximum).toBe(18);
  });
});
