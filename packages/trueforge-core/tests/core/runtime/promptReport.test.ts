import { measurePromptRequest } from '../../../src/core/runtime/promptReport';
import { makeMockIMCPServer, OBJECT_INPUT_SCHEMA } from '../harnessMocks';

describe('measurePromptRequest', () => {
  it('reports the system sections and tools the request carries, in order', async () => {
    const report = await measurePromptRequest({
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'Be brief.',
        toolSets: [
          makeMockIMCPServer({
            name: 'notes',
            preload: true,
            tools: [{ name: 'read_note', description: 'Read a note', inputSchema: OBJECT_INPUT_SCHEMA, preload: true }],
          }),
        ],
      },
    });

    const names = report.sections.map(row => row.name);
    expect(names).toContain('agent-identity');
    expect(names).toContain('agent-capabilities');
    expect(names).toContain('agent-capabilities/plain-speech');
    expect(names).toContain('user-instructions');
    // The tool is listed in the index section and sent only once used; the lookup tools are sent.
    expect(names).toContain('agent-capabilities/deferred-tools-instructions');
    expect(report.tools.map(row => row.name)).toEqual([
      'call_tool',
      'get_tool_info',
      'get_tool_output_schema',
      'list_tools',
    ]);
  });

  it('counts each top-level section once and adds the tools to the total', async () => {
    const report = await measurePromptRequest({
      definition: { modelId: undefined, configuredModels: undefined, instruction: 'Be brief.', toolSets: [] },
    });

    const topLevel = report.sections.filter(row => !row.name.includes('/'));
    const topLevelTokens = topLevel.reduce((sum, row) => sum + row.tokens, 0);
    const toolTokens = report.tools.reduce((sum, row) => sum + row.tokens, 0);
    expect(report.totalTokens).toBe(topLevelTokens + toolTokens);
    // Nested rows are inside their parent, so they must not inflate the total.
    const parent = report.sections.find(row => row.name === 'agent-capabilities');
    expect(parent?.tokens ?? 0).toBeGreaterThan(
      report.sections.find(row => row.name === 'agent-capabilities/plain-speech')?.tokens ?? 0,
    );
  });

  it('keeps tag-like user text inside its own section', async () => {
    const report = await measurePromptRequest({
      definition: {
        modelId: undefined,
        configuredModels: undefined,
        instruction: 'Use <agent-identity>this</agent-identity> literally.',
        toolSets: [],
      },
    });

    expect(report.sections.map(row => row.name)).toContain('user-instructions');
    expect(report.sections.map(row => row.name).some(name => name.startsWith('user-instructions/'))).toBe(false);
  });
});
