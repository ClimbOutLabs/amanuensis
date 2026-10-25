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
  REVERT_SPACE_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
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
    outboundSecrets: () => Promise.resolve([]),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return toolSet;
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

  it('update_space and revert_space name the space and the new revision, never an id', async () => {
    const store = makeMemoryStore([makeRecord({ id: 'sp-1', name: 'Dog breeds' })]);
    const toolSet = makeToolSet(store);
    const updated = await toolSet.callTool({
      name: UPDATE_SPACE_TOOL_NAME,
      arguments: {
        space_id: 'sp-1',
        name: 'Dog breeds',
        purpose: 'Compare dog breeds.',
        status: 'active',
        body: '# Dog breeds\nUpdated',
      },
    });
    expect(resultText(updated)).toContain('Updated space \\"Dog breeds\\" (revision 2).');
    expect(resultText(updated)).not.toContain('"id"');
    const reverted = await toolSet.callTool({
      name: REVERT_SPACE_TOOL_NAME,
      arguments: { space_id: 'sp-1', revision: 1 },
    });
    expect(resultText(reverted)).toContain('Restored space \\"Dog breeds\\" (revision 3).');
    expect(resultText(reverted)).not.toContain('"id"');
  });
});

describe('spaces found by exact name', () => {
  const dogBreeds = makeRecord({ id: 'sp-dogs', name: 'Dog breeds' });

  it('get_space reads a space by its exact unique name when the id is missing', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(response)).toBe(false);
    expect((JSON.parse(resultText(response)) as { space: { id: string } }).space.id).toBe('sp-dogs');
  });

  it('edit_space applies its change to the space found by name', async () => {
    const store = makeMemoryStore([dogBreeds]);
    const toolSet = makeToolSet(store);
    const response = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Dog breeds',
        edits: [{ type: 'block', anchor: 'auto-body', new_content: '# Dog breeds\nTop ten by intelligence.' }],
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

  it('an ambiguous name returns the plain list of matching ids and does not pick one', async () => {
    const store = makeMemoryStore([
      dogBreeds,
      makeRecord({ id: 'sp-other', name: 'Dog breeds', revision: 4, updated_at: '2026-10-20T00:00:00.000Z' }),
    ]);
    const toolSet = makeToolSet(store);
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(response)).toBe(true);
    const { error } = JSON.parse(resultText(response)) as { error: string };
    expect(error).toContain('More than one space is named "Dog breeds"');
    expect(error).toContain('sp-dogs (revision 1');
    expect(error).toContain('sp-other (revision 4, updated 2026-10-20T00:00:00.000Z)');
  });

  it('a name lookup past one page fails closed instead of guessing', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds], { hasMore: true }));
    const response = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(response)).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error: 'Too many spaces to find "Dog breeds" by name. Call list_spaces, then pass its space_id.',
    });
  });

  it('get_space and update_space reject a call that gives both keys or neither', async () => {
    const toolSet = makeToolSet(makeMemoryStore([dogBreeds]));
    const both = await toolSet.callTool({
      name: GET_SPACE_TOOL_NAME,
      arguments: { space_id: 'sp-dogs', space_name: 'Dog breeds' },
    });
    const neither = await toolSet.callTool({
      name: UPDATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Dog breeds',
        purpose: 'Compare dog breeds.',
        status: 'active',
        body: '# Dog breeds',
      },
    });
    for (const response of [both, neither]) {
      expect(isErrorResponse(response)).toBe(true);
      expect(JSON.stringify(JSON.parse(resultText(response)))).toContain(
        'Provide exactly one of space_id or space_name',
      );
    }
  });
});
