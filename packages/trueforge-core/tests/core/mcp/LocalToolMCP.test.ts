import { z } from 'zod';
import { toolResultResponse } from '../../../src/core/mcp/IMCPServer';
import { defineTool } from '../../../src/core/mcp/LocalToolMCP';

describe('defineTool inputSchema', () => {
  it('omits defaulted fields from required (input-oriented JSON Schema)', () => {
    const tool = defineTool({
      name: 'call_tool',
      requiresNetwork: false,
      description: 'Call a deferred tool',
      schema: z.object({
        mcp_server: z.string(),
        tool_name: z.string(),
        input: z.record(z.string(), z.unknown()).default({}),
      }),
      handler: async () => toolResultResponse({ text: 'ok' }),
    });

    expect(tool.inputSchema.type).toBe('object');
    expect(tool.inputSchema.required).toEqual(['mcp_server', 'tool_name']);
    expect(tool.inputSchema.properties).toHaveProperty('input');
  });

  it('keeps truly required fields in required', () => {
    const tool = defineTool({
      name: 'echo',
      requiresNetwork: false,
      description: 'Echo',
      schema: z.object({
        message: z.string(),
      }),
      handler: async () => toolResultResponse({ text: 'ok' }),
    });

    expect(tool.inputSchema.required).toEqual(['message']);
  });

  it('leaves out the safe-integer bound Zod adds to whole numbers, and keeps real bounds', () => {
    const tool = defineTool({
      name: 'read_page',
      requiresNetwork: false,
      description: 'Read a page',
      schema: z.object({
        revision: z.number().int().positive(),
        lines: z.number().int().min(1).max(1000),
        items: z.array(z.object({ page: z.number().int().nonnegative() })),
      }),
      handler: async () => toolResultResponse({ text: 'ok' }),
    });

    expect(JSON.stringify(tool.inputSchema)).not.toContain(String(Number.MAX_SAFE_INTEGER));
    expect(tool.inputSchema.properties).toMatchObject({
      revision: { type: 'integer', exclusiveMinimum: 0 },
      lines: { type: 'integer', minimum: 1, maximum: 1000 },
      items: { items: { properties: { page: { type: 'integer', minimum: 0 } } } },
    });
  });
});
