import type { ChatCompletionTool } from 'openai/resources/chat';
import type { AgentToolSchema, IToolSet, ListToolsResponse } from '../../../src/core/mcp/IMCPServer';
import { convertMCPServersToTools, meetsStrictSchemaRules } from '../../../src/core/mcp/convertMCPServers';
import '../harnessMocks';
import { makeMockIMCPServer } from '../harnessMocks';

/** FastMCP hoists nested models to top-level `$defs` with `#/$defs/<Model>` refs. */
const FASTMCP_STYLE_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    name: { type: 'string' },
    address: { $ref: '#/$defs/Address' },
  },
  required: ['name', 'address'],
  $defs: {
    Address: {
      type: 'object',
      properties: { street: { type: 'string' }, city: { type: 'string' } },
      required: ['street', 'city'],
    },
  },
};

/** Draft-04 spelling still emitted by older generators. */
const DRAFT04_DEFINITIONS_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    address: { $ref: '#/definitions/Address' },
  },
  required: ['address'],
  definitions: {
    Address: {
      type: 'object',
      properties: { city: { type: 'string' } },
      required: ['city'],
    },
  },
};

function makeServer(name: string, tools: AgentToolSchema[]): IToolSet {
  const base = makeMockIMCPServer({ name, preload: true, tools });
  return {
    ...base,
    listTools: jest.fn((): Promise<ListToolsResponse> =>
      Promise.resolve({
        result: { tools },
        wasInitialized: undefined,
      }),
    ),
  };
}

function functionParameters(tool: ChatCompletionTool | undefined): Record<string, unknown> | undefined {
  if (tool === undefined || tool.type !== 'function') {
    throw new Error('Expected a function tool');
  }
  return tool.function.parameters;
}

async function convertParameters(inputSchema: AgentToolSchema['inputSchema']) {
  const tools: AgentToolSchema[] = [{ name: 'probe', description: 'probe', inputSchema, preload: true }];
  const { convertedTools } = await convertMCPServersToTools({
    tfyManagedServers: [],
    userServers: [makeServer('server', tools)],
  });
  expect(convertedTools.tools).toHaveLength(1);
  return functionParameters(convertedTools.tools[0]);
}

describe('convertMCPServersToTools JSON Schema containers', () => {
  it.each([
    ['$defs', FASTMCP_STYLE_INPUT_SCHEMA, FASTMCP_STYLE_INPUT_SCHEMA.$defs],
    ['definitions', DRAFT04_DEFINITIONS_INPUT_SCHEMA, DRAFT04_DEFINITIONS_INPUT_SCHEMA.definitions],
  ] as const)('preserves top-level %s so local $refs stay resolvable', async (container, inputSchema, expected) => {
    const parameters = await convertParameters(inputSchema);
    expect(parameters?.[container]).toEqual(expected);
  });

  it('does not introduce $defs or definitions for schemas without them', async () => {
    const parameters = await convertParameters({ type: 'object', properties: {} });
    expect(parameters).toEqual({ type: 'object', properties: {}, required: [] });
  });
});

describe('strict tools', () => {
  async function convertManaged(inputSchema: AgentToolSchema['inputSchema']) {
    const tools: AgentToolSchema[] = [{ name: 'probe', description: 'probe', inputSchema, preload: true }];
    const { convertedTools } = await convertMCPServersToTools({
      tfyManagedServers: [makeServer('managed', tools)],
      userServers: [],
    });
    const tool = convertedTools.tools[0];
    if (tool === undefined || tool.type !== 'function') throw new Error('Expected a function tool');
    return tool.function;
  }

  it('marks a managed tool strict when every field is required', async () => {
    const fn = await convertManaged({
      type: 'object',
      properties: { place: { type: 'string' } },
      required: ['place'],
    });
    expect(fn.strict).toBe(true);
    expect(fn.parameters?.['additionalProperties']).toBe(false);
  });

  it('sends a managed tool with an optional field without strict, so strict providers accept the request', async () => {
    const fn = await convertManaged({
      type: 'object',
      properties: { place: { type: 'string' }, poi: { type: 'string' } },
      required: ['place'],
    });
    expect(fn.strict).toBeUndefined();
  });

  it('checks nested objects too', async () => {
    const fn = await convertManaged({
      type: 'object',
      properties: {
        stop: {
          type: 'object',
          properties: { city: { type: 'string' }, note: { type: 'string' } },
          required: ['city'],
        },
      },
      required: ['stop'],
    });
    expect(fn.strict).toBeUndefined();
  });
});

describe('meetsStrictSchemaRules', () => {
  it('accepts an empty object and nested fully required objects', () => {
    expect(meetsStrictSchemaRules({ type: 'object', properties: {} })).toBe(true);
    expect(
      meetsStrictSchemaRules({
        type: 'object',
        properties: { list: { type: 'array', items: { type: 'object', properties: { a: {} }, required: ['a'] } } },
        required: ['list'],
      }),
    ).toBe(true);
  });

  it('refuses an optional field inside an array item or a definition', () => {
    expect(
      meetsStrictSchemaRules({
        type: 'object',
        properties: {
          list: { type: 'array', items: { type: 'object', properties: { a: {}, b: {} }, required: ['a'] } },
        },
        required: ['list'],
      }),
    ).toBe(false);
    expect(
      meetsStrictSchemaRules({
        type: 'object',
        properties: {},
        $defs: { Thing: { type: 'object', properties: { a: {} } } },
      }),
    ).toBe(false);
  });
});
