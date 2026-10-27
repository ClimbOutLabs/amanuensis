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
import { SpaceNotFoundError, SpaceRevisionNotFoundError, type SpaceRecord } from '../../../src/db/spaceStore';
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function errorText(response: CallToolResponse): string {
  const value: unknown = JSON.parse(resultText(response));
  if (isRecord(value) && typeof value['error'] === 'string') {
    return value['error'];
  }
  throw new Error('expected an error response with a message');
}

function listedNames(response: CallToolResponse): string[] {
  const value: unknown = JSON.parse(resultText(response));
  if (!isRecord(value) || !Array.isArray(value['spaces'])) {
    throw new Error('expected a space list response');
  }
  return value['spaces'].map(entry => {
    if (!isRecord(entry) || typeof entry['name'] !== 'string') {
      throw new Error('expected every listed space to carry a name');
    }
    return entry['name'];
  });
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

/**
 * An in-memory store that keeps every revision, the way the real stores do: a
 * read of a past revision returns the space as it was at that revision, and a
 * revert restores that revision's name and body as a new revision.
 */
function makeHistoryStore(): SpaceToolStore {
  const rows = new Map<string, SpaceRecord>();
  const history = new Map<string, SpaceRecord>();
  let aggregate = 0;
  const key = (id: string, revision: number) => `${id}@${String(revision)}`;
  const replace = (record: SpaceRecord) => {
    rows.set(record.id, record);
    history.set(key(record.id, record.revision), record);
    aggregate += 1;
    return { record, aggregate_revision: aggregate };
  };
  return {
    createSpace: async input =>
      replace(
        makeRecord({
          id: input.id,
          name: input.name,
          purpose: input.purpose,
          status: input.status,
          body: input.body,
          format: input.format,
        }),
      ),
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
        updated_at: '2026-10-22T00:00:00.000Z',
      });
    },
    revertSpace: async input => {
      const current = rows.get(input.space_id);
      if (current === undefined) {
        throw new SpaceNotFoundError({ id: input.space_id });
      }
      const historical = history.get(key(input.space_id, input.revision));
      if (historical === undefined) {
        throw new SpaceRevisionNotFoundError({ id: input.space_id, revision: input.revision });
      }
      return replace({
        ...current,
        name: historical.name,
        purpose: historical.purpose,
        status: historical.status,
        body: historical.body,
        format: historical.format,
        revision: current.revision + 1,
        updated_at: '2026-10-22T00:00:00.000Z',
      });
    },
    getSpace: async input => rows.get(input.space_id),
    getSpaceRevision: async input => history.get(key(input.space_id, input.revision)),
    listSpacesWithAggregate: async () => ({
      records: [...rows.values()].filter(record => record.created_by === AUTHORITY.userRef),
      aggregate_revision: aggregate,
      has_more: false,
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

async function createDogBreeds(toolSet: ReturnType<typeof makeToolSet>): Promise<void> {
  const created = await toolSet.callTool({
    name: CREATE_SPACE_TOOL_NAME,
    arguments: { name: 'Dog breeds', purpose: 'Compare dog breeds.', status: 'active', body: '# Dog breeds' },
  });
  expect(isErrorResponse(created)).toBe(false);
}

async function renameDogBreeds(toolSet: ReturnType<typeof makeToolSet>): Promise<void> {
  const renamed = await toolSet.callTool({
    name: EDIT_SPACE_TOOL_NAME,
    arguments: {
      space_name: 'Dog breeds',
      new_title: 'Dog breeds, ranked',
      edits: [{ type: 'search', search: '# Dog breeds', replace: '# Dog breeds, ranked' }],
    },
  });
  expect(isErrorResponse(renamed)).toBe(false);
}

describe('revert_space and the name the restored revision carried', () => {
  it('refuses to restore a name another space has taken since, and writes nothing', async () => {
    const toolSet = makeToolSet(makeHistoryStore());
    await createDogBreeds(toolSet);
    await renameDogBreeds(toolSet);
    const second = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: { name: 'Dog breeds', purpose: 'Track the new list.', status: 'active', body: '# Dog breeds' },
    });
    expect(isErrorResponse(second)).toBe(false);

    const reverted = await toolSet.callTool({
      name: REVERT_SPACE_TOOL_NAME,
      arguments: { space_name: 'Dog breeds, ranked', revision: 1 },
    });
    expect(isErrorResponse(reverted)).toBe(true);
    expect(errorText(reverted)).toBe(
      'A space named "Dog breeds" already exists. Rename the space that has that name now with edit_space, then try again.',
    );

    const listed = await toolSet.callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} });
    expect(listedNames(listed).sort()).toEqual(['Dog breeds', 'Dog breeds, ranked']);
    const first = await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Dog breeds' } });
    expect(isErrorResponse(first)).toBe(false);
    const other = await toolSet.callTool({
      name: GET_SPACE_TOOL_NAME,
      arguments: { space_name: 'Dog breeds, ranked' },
    });
    expect(isErrorResponse(other)).toBe(false);
  });

  it('still restores a name nobody else has taken', async () => {
    const toolSet = makeToolSet(makeHistoryStore());
    await createDogBreeds(toolSet);
    await renameDogBreeds(toolSet);

    const reverted = await toolSet.callTool({
      name: REVERT_SPACE_TOOL_NAME,
      arguments: { space_name: 'Dog breeds, ranked', revision: 1 },
    });
    expect(isErrorResponse(reverted)).toBe(false);
    expect(resultText(reverted)).toContain('Restored space \\"Dog breeds\\" (revision 3).');
    const listed = await toolSet.callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} });
    expect(listedNames(listed)).toEqual(['Dog breeds']);
  });

  it('still reverts when the name never changed, and reverting to the current revision still works', async () => {
    const toolSet = makeToolSet(makeHistoryStore());
    await createDogBreeds(toolSet);
    const edited = await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Dog breeds',
        edits: [{ type: 'search', search: '# Dog breeds', replace: '# Dog breeds\nUpdated' }],
      },
    });
    expect(isErrorResponse(edited)).toBe(false);

    const reverted = await toolSet.callTool({
      name: REVERT_SPACE_TOOL_NAME,
      arguments: { space_name: 'Dog breeds', revision: 1 },
    });
    expect(isErrorResponse(reverted)).toBe(false);
    expect(resultText(reverted)).toContain('Restored space \\"Dog breeds\\" (revision 3).');

    const again = await toolSet.callTool({
      name: REVERT_SPACE_TOOL_NAME,
      arguments: { space_name: 'Dog breeds', revision: 3 },
    });
    expect(isErrorResponse(again)).toBe(false);
    expect(resultText(again)).toContain('Restored space \\"Dog breeds\\" (revision 4).');
  });
});
