import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core';
import {
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import { SpaceNotFoundError, type SpaceRecord } from '../../../src/db/spaceStore';
import { spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';

const NOOP_EXECUTION_TRACE: AgentExecutionTrace = {
  runInContext: operation => operation(),
  startSubAgent: () => NOOP_EXECUTION_TRACE,
  setOutput: () => undefined,
  setMetrics: () => undefined,
  setError: () => undefined,
  setSuccess: () => undefined,
  end: () => undefined,
};
const NOOP_LOCAL_TOOL_TRACE: AgentLocalToolTrace = { setOutput: () => undefined, setSandboxId: () => undefined };
const NOOP_REMOTE_MCP_TOOL_TRACE: AgentRemoteMcpToolTrace = {
  setOutput: () => undefined,
  setNumberOfTools: () => undefined,
};
const NOOP_TRACING: AgentTracing = {
  withInitSpan: operation => operation(),
  startRootSpan: () => NOOP_EXECUTION_TRACE,
  withLocalToolSpan: (_input, operation) => operation(NOOP_LOCAL_TOOL_TRACE),
  withRemoteMcpToolSpan: (_input, operation) => operation(NOOP_REMOTE_MCP_TOOL_TRACE),
};

const AUTHORITY = { tenantId: 'default', userRef: 'user-a' };

function resultText(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected space tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

function isErrorResponse(response: CallToolResponse): boolean {
  return 'result' in response && response.result.isError === true;
}

function makeRecord(overrides: Partial<SpaceRecord> & Pick<SpaceRecord, 'id' | 'name'>): SpaceRecord {
  return {
    tenant_id: 'default',
    created_by: 'user-a',
    purpose: 'Compare dog breeds.',
    status: 'active',
    body: '# Dog breeds',
    format: 'markdown',
    revision: 1,
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: '2026-10-21T00:00:00.000Z',
    ...overrides,
  };
}

/** An in-memory store for the owner's tenant and user, enough for the tool paths under test. */
function makeMemoryStore(initial: SpaceRecord[] = [], options: { hasMore?: boolean } = {}): SpaceToolStore {
  const rows = new Map(initial.map(record => [record.id, record]));
  let aggregate = initial.length;
  let nextId = 0;
  const mine = () => [...rows.values()].filter(record => record.created_by === AUTHORITY.userRef);
  const replace = (record: SpaceRecord) => {
    rows.set(record.id, record);
    aggregate += 1;
    return { record, aggregate_revision: aggregate };
  };
  return {
    createSpace: async input => {
      nextId += 1;
      return replace(
        makeRecord({
          id: input.id,
          name: input.name,
          purpose: input.purpose,
          status: input.status,
          body: input.body,
          format: input.format,
        }),
      );
    },
    updateSpace: async input => {
      const current = rows.get(input.space_id);
      if (current === undefined) {
        throw new SpaceNotFoundError({ id: input.space_id });
      }
      return replace({
        ...current,
        name: input.name,
        purpose: input.purpose,
        status: input.status,
        body: input.body,
        format: input.format,
        revision: current.revision + 1,
      });
    },
    revertSpace: async input => {
      const current = rows.get(input.space_id);
      if (current === undefined) {
        throw new SpaceNotFoundError({ id: input.space_id });
      }
      return replace({ ...current, revision: current.revision + 1 });
    },
    getSpace: async input => rows.get(input.space_id),
    getSpaceRevision: async () => undefined,
    listSpacesWithAggregate: async () => ({
      records: mine(),
      aggregate_revision: aggregate,
      has_more: options.hasMore === true,
      next_offset: null,
    }),
  };
}

function makeToolSet(store: SpaceToolStore) {
  const capability = spaceCapability({
    store,
    authority: AUTHORITY,
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return toolSet;
}

/** The fingerprint the get_space outline shows for one anchor, read the way a model reads it. */
async function fingerprintOf(
  toolSet: ReturnType<typeof makeToolSet>,
  input: { spaceName: string; anchor: string },
): Promise<string> {
  const response = await toolSet.callTool({
    name: GET_SPACE_TOOL_NAME,
    arguments: { space_name: input.spaceName },
  });
  const parsed: { blocks?: { anchor: string; fingerprint: string }[] } = JSON.parse(resultText(response));
  const block = (parsed.blocks ?? []).find(candidate => candidate.anchor === input.anchor);
  if (block === undefined) {
    throw new Error(`expected block ${input.anchor} in the get_space result for ${input.spaceName}`);
  }
  return block.fingerprint;
}

describe('space results lead with the name and link, not an id', () => {
  it('create_space names the new space and link first, and never an id', async () => {
    const toolSet = makeToolSet(makeMemoryStore());
    const response = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: { name: 'Dog breeds', purpose: 'Compare dog breeds.', status: 'active', body: '# Dog breeds' },
    });
    const text = resultText(response);
    expect(text.startsWith('{"summary":')).toBe(true);
    expect(text).toContain('Created space \\"Dog breeds\\" (revision 1).');
    expect(text).toMatch(/"name":"Dog breeds"/);
    expect(text).toMatch(/"link":"\/spaces\/[^"]+"/);
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('(id:');
  });

  it('edit_space and revert_space name the space and the new revision, never an id', async () => {
    const store = makeMemoryStore([makeRecord({ id: 'sp-1', name: 'Dog breeds' })]);
    const toolSet = makeToolSet(store);
    const edited = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [
          {
            type: 'block',
            anchor: 'b1',
            fingerprint: await fingerprintOf(toolSet, { spaceName: 'Dog breeds', anchor: 'b1' }),
            new_content: '# Dog breeds\nUpdated',
          },
        ],
      },
    });
    expect(resultText(edited)).toContain('Updated space \\"Dog breeds\\" (revision 2).');
    expect(resultText(edited)).not.toContain('"id"');
    const reverted = await toolSet.callTool({
      name: REVERT_SPACE_TOOL_NAME,
      arguments: { space_name: 'Dog breeds', revision: 1 },
    });
    expect(resultText(reverted)).toContain('Restored space \\"Dog breeds\\" (revision 3).');
    expect(resultText(reverted)).not.toContain('"id"');
  });

  it('create_space refuses a name an existing space already has, and writes nothing', async () => {
    const store = makeMemoryStore([makeRecord({ id: 'sp-1', name: 'Dog breeds' })]);
    const toolSet = makeToolSet(store);
    const response = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: { name: 'Dog breeds', purpose: 'Track cats instead.', status: 'active', body: '# Cats' },
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error:
        'A space named "Dog breeds" already exists. Pick a different name for the new space, or change the existing one with edit_space.',
    });
    const listed = await toolSet.callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} });
    const spaces = (JSON.parse(resultText(listed)) as { spaces: { name: string }[] }).spaces;
    expect(spaces.map(space => space.name)).toEqual(['Dog breeds']);
  });
});

describe('spaces found by exact name', () => {
  const dogBreeds = makeRecord({ id: 'sp-dogs', name: 'Dog breeds' });

  it('get_space reads a space by its exact unique name, and the result carries the link, not an id', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(response)).toBe(false);
    const { space } = JSON.parse(resultText(response)) as { space: Record<string, unknown> };
    expect(space['name']).toBe('Dog breeds');
    expect(space['link']).toBe('/spaces/sp-dogs');
    expect('id' in space).toBe(false);
  });

  it('list_spaces gives names and links, never ids', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const response = await toolSet.callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} });
    expect(isErrorResponse(response)).toBe(false);
    const { spaces } = JSON.parse(resultText(response)) as { spaces: Record<string, unknown>[] };
    expect(spaces).toHaveLength(1);
    expect(spaces[0]?.['name']).toBe('Dog breeds');
    expect(spaces[0]?.['link']).toBe('/spaces/sp-dogs');
    expect(spaces[0] !== undefined && 'id' in spaces[0]).toBe(false);
    expect(spaces[0] !== undefined && 'body' in spaces[0]).toBe(false);
  });

  it('edit_space applies its change to the space found by name', async () => {
    const store = makeMemoryStore([dogBreeds]);
    const toolSet = makeToolSet(store);
    const response = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [
          {
            type: 'block',
            anchor: 'b1',
            fingerprint: await fingerprintOf(toolSet, { spaceName: 'Dog breeds', anchor: 'b1' }),
            new_content: '# Dog breeds\nTop ten by intelligence.',
          },
        ],
      },
    });
    expect(isErrorResponse(response)).toBe(false);
    expect((JSON.parse(resultText(response)) as { summary: string }).summary).toBe(
      'Updated space "Dog breeds" (revision 2).',
    );
  });

  it('a name with no match is a terminal error that says to call list_spaces', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Cat breeds' } });
    expect(isErrorResponse(response)).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error: 'No space is named "Cat breeds". Call list_spaces to see the spaces you have.',
    });
  });

  it('an ambiguous name refuses to pick one and says to rename one in the Spaces view', async () => {
    const store = makeMemoryStore([
      dogBreeds,
      makeRecord({ id: 'sp-other', name: 'Dog breeds', revision: 4, updated_at: '2026-10-20T00:00:00.000Z' }),
    ]);
    const toolSet = makeToolSet(store);
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(response)).toBe(true);
    const { error } = JSON.parse(resultText(response)) as { error: string };
    expect(error).toContain('More than one space is named "Dog breeds"');
    expect(error).toContain('rename one of them in the Spaces view');
    expect(error).not.toContain('sp-dogs');
    expect(error).not.toContain('sp-other');
  });

  it('a name lookup past one page fails closed instead of guessing', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds], { hasMore: true }));
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(response)).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error: 'Too many spaces to find "Dog breeds" by name for sure. Call list_spaces to see the spaces you have.',
    });
  });

  it('a call carrying space_id is refused as an unknown field on every addressed tool', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const calls: { name: string; arguments: Record<string, unknown> }[] = [
      { name: GET_SPACE_TOOL_NAME, arguments: { space_id: 'sp-dogs', space_name: 'Dog breeds' } },
      {
        name: EDIT_SPACE_TOOL_NAME,
        arguments: {
          space_id: 'sp-dogs',
          space_name: 'Dog breeds',
          expected_revision: 1,
          edits: [{ type: 'block', anchor: 'b1', fingerprint: '00000000', new_content: 'x' }],
        },
      },
      { name: REVERT_SPACE_TOOL_NAME, arguments: { space_id: 'sp-dogs', space_name: 'Dog breeds', revision: 1 } },
    ];
    for (const call of calls) {
      const response = await toolSet.callTool(call);
      expect(isErrorResponse(response)).toBe(true);
      expect(JSON.stringify(JSON.parse(resultText(response)))).toContain('space_id');
    }
  });

  it('a call with no space_name is refused, and the error names the missing field', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: {} });
    expect(isErrorResponse(response)).toBe(true);
    expect(JSON.stringify(JSON.parse(resultText(response)))).toContain('space_name');
  });

  it('edit_space renames through new_title, and refuses the old name field', async () => {
    const store = makeMemoryStore([dogBreeds]);
    const toolSet = makeToolSet(store);
    const renamed = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Dog breeds',
        new_title: 'Dog breeds, ranked',
        expected_revision: 1,
        edits: [
          {
            type: 'block',
            anchor: 'b1',
            fingerprint: await fingerprintOf(toolSet, { spaceName: 'Dog breeds', anchor: 'b1' }),
            new_content: '# Dog breeds, ranked',
          },
        ],
      },
    });
    expect(isErrorResponse(renamed)).toBe(false);
    expect(resultText(renamed)).toContain('Updated space \\"Dog breeds, ranked\\" (revision 2).');
    const refused = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Dog breeds, ranked',
        name: 'Dogs',
        expected_revision: 2,
        edits: [{ type: 'block', anchor: 'b1', fingerprint: '00000000', new_content: 'ranked' }],
      },
    });
    expect(isErrorResponse(refused)).toBe(true);
    expect(JSON.stringify(JSON.parse(resultText(refused)))).toContain('name');
  });

  it('edit_space refuses a new_title another space already has', async () => {
    const store = makeMemoryStore([dogBreeds, makeRecord({ id: 'sp-cats', name: 'Cat breeds' })]);
    const toolSet = makeToolSet(store);
    const response = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Cat breeds',
        new_title: 'Dog breeds',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: 'b1', fingerprint: '00000000', new_content: '# Cat breeds' }],
      },
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error: 'A space named "Dog breeds" already exists. Pick a different new_title, or leave the name unchanged.',
    });
  });
});
