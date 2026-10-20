/**
 * Offered tool schemas: a boolean-or-nothing argument (the shape that broke web_fetch's
 * full_content) is offered to the model as a plain true/false. Every other schema shape is
 * offered exactly as the tool server declared it.
 */
import { convertMCPServersToTools, plainBooleanSchema } from '../../../src/core/mcp/convertMCPServers';
import { makeMockIMCPServer } from '../harnessMocks';

describe('plainBooleanSchema', () => {
  it('collapses an anyOf boolean-or-null union to a plain boolean, keeping the description', () => {
    expect(
      plainBooleanSchema({
        anyOf: [{ type: 'boolean' }, { type: 'null' }],
        description: 'Return the full page text.',
      }),
    ).toEqual({ type: 'boolean', description: 'Return the full page text.' });
  });

  it('collapses a type list of boolean and null', () => {
    expect(plainBooleanSchema({ type: ['boolean', 'null'] })).toEqual({ type: 'boolean' });
  });

  it('collapses a oneOf boolean-or-null union', () => {
    expect(plainBooleanSchema({ oneOf: [{ type: 'null' }, { type: 'boolean' }] })).toEqual({ type: 'boolean' });
  });

  it('leaves unions that mean something else alone', () => {
    const stringOrNull = { anyOf: [{ type: 'string' }, { type: 'null' }] };
    expect(plainBooleanSchema(stringOrNull)).toEqual(stringOrNull);
    const booleanOrString = { anyOf: [{ type: 'boolean' }, { type: 'string' }] };
    expect(plainBooleanSchema(booleanOrString)).toEqual(booleanOrString);
    const plainBoolean = { type: 'boolean' };
    expect(plainBooleanSchema(plainBoolean)).toEqual(plainBoolean);
  });

  it('recurses into nested object properties and list items', () => {
    expect(
      plainBooleanSchema({
        type: 'object',
        properties: {
          options: {
            type: 'object',
            properties: { verbose: { anyOf: [{ type: 'boolean' }, { type: 'null' }] } },
          },
          flags: { type: 'array', items: { type: ['boolean', 'null'] } },
        },
      }),
    ).toEqual({
      type: 'object',
      properties: {
        options: { type: 'object', properties: { verbose: { type: 'boolean' } } },
        flags: { type: 'array', items: { type: 'boolean' } },
      },
    });
  });
});

describe('convertMCPServersToTools boolean shaping', () => {
  it('offers web_fetch-style full_content as a plain boolean', async () => {
    const toolSet = makeMockIMCPServer({
      name: 'parallel-web',
      preload: true,
      tools: [
        {
          name: 'web_fetch',
          description: 'Fetch a page',
          preload: true,
          inputSchema: {
            type: 'object',
            properties: {
              urls: { type: 'array', items: { type: 'string' } },
              full_content: { anyOf: [{ type: 'boolean' }, { type: 'null' }], description: 'Full text.' },
            },
            required: ['urls'],
          },
        },
      ],
    });
    const { convertedTools } = await convertMCPServersToTools({ tfyManagedServers: [], userServers: [toolSet] });
    const tool = convertedTools.tools[0];
    expect(tool?.type).toBe('function');
    if (tool?.type === 'function') {
      expect(tool.function.parameters?.['properties']).toEqual({
        urls: { type: 'array', items: { type: 'string' } },
        full_content: { type: 'boolean', description: 'Full text.' },
      });
    }
  });
});
