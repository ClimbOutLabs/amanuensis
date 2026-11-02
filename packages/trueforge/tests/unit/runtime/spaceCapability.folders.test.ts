import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core';
import {
  GET_SPACE_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  MOVE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import {
  SpaceFolderNotFoundError,
  SpaceNotFoundError,
  type SpaceFolderRecord,
  type SpaceRecord,
} from '../../../src/db/spaceStore';
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

const TENANT = 'default';
const OWNER = 'user-a';
const OTHER_OWNER = 'user-b';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function parsed(response: CallToolResponse): Record<string, unknown> {
  if (!('result' in response)) {
    throw new Error('expected space tool result');
  }
  const content = response.result.content[0];
  const value: unknown = JSON.parse(content?.type === 'text' ? content.text : '');
  if (!isRecord(value)) {
    throw new Error('expected a JSON object result');
  }
  return value;
}

function isErrorResponse(response: CallToolResponse): boolean {
  return 'result' in response && response.result.isError === true;
}

function makeRecord(overrides: Partial<SpaceRecord> & Pick<SpaceRecord, 'id' | 'name'>): SpaceRecord {
  return {
    tenant_id: TENANT,
    created_by: OWNER,
    purpose: 'Track things.',
    status: 'active',
    body: '# Body',
    format: 'markdown',
    revision: 3,
    created_at: '2026-10-21T00:00:00.000Z',
    updated_at: '2026-10-22T00:00:00.000Z',
    ...overrides,
  };
}

/** In-memory spaces and folders; every write that is not a filing throws, so a move that edits fails loudly. */
function makeStore(initial: SpaceRecord[]) {
  const folders: (SpaceFolderRecord & { id: string })[] = [];
  const assignments = new Map<string, string>();
  const spaces = new Map(initial.map(record => [record.id, record]));
  const calls = { createSpaceFolder: 0 };
  const notUsed = async (): Promise<never> => {
    throw new Error('A move must not write the space itself.');
  };
  const store: SpaceToolStore = {
    createSpace: notUsed,
    updateSpace: notUsed,
    revertSpace: notUsed,
    getSpaceRevision: async () => undefined,
    getSpace: async input =>
      input.created_by === OWNER && input.tenant_id === TENANT ? spaces.get(input.space_id) : undefined,
    listSpacesWithAggregate: async input => ({
      records: [...spaces.values()].filter(record => record.created_by === input.created_by),
      aggregate_revision: 7,
      has_more: false,
      next_offset: null,
    }),
    listSpaceFolders: async input => folders.filter(folder => folder.created_by === input.created_by),
    createSpaceFolder: async input => {
      calls.createSpaceFolder += 1;
      const record = { ...input, created_at: '2026-10-23T00:00:00.000Z', updated_at: '2026-10-23T00:00:00.000Z' };
      folders.push(record);
      return record;
    },
    setSpaceFolder: async input => {
      if (!spaces.has(input.space_id)) {
        throw new SpaceNotFoundError({ id: input.space_id });
      }
      if (input.folder_id === null) {
        assignments.delete(input.space_id);
        return;
      }
      if (!folders.some(folder => folder.id === input.folder_id)) {
        throw new SpaceFolderNotFoundError({ id: input.folder_id });
      }
      assignments.set(input.space_id, input.folder_id);
    },
    listSpaceFolderAssignments: async () =>
      [...assignments.entries()].map(([space_id, folder_id]) => ({ space_id, folder_id })),
  };
  return { store, folders, assignments, spaces, calls };
}

function makeToolSet(store: SpaceToolStore, userRef = OWNER) {
  const capability = spaceCapability({
    store,
    authority: { tenantId: TENANT, userRef },
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return toolSet;
}

function folderEntries(result: Record<string, unknown>): Record<string, unknown>[] {
  const spaces = result['spaces'];
  if (!Array.isArray(spaces)) {
    throw new Error('expected a space list');
  }
  return spaces.filter(isRecord);
}

describe('move_space', () => {
  const pets = makeRecord({ id: 'space-pets', name: 'Pets' });

  it('files a space into an existing folder and reports it', async () => {
    const { store, folders, assignments } = makeStore([pets]);
    folders.push({
      id: 'folder-home',
      name: 'Home',
      tenant_id: TENANT,
      created_by: OWNER,
      created_at: 'x',
      updated_at: 'x',
    });
    const response = await makeToolSet(store).callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Pets', folder_name: 'Home' },
    });

    const result = parsed(response);
    expect(isErrorResponse(response)).toBe(false);
    expect(result['summary']).toBe('Moved the space "Pets" into the folder "Home".');
    expect(result['folder']).toBe('Home');
    expect(result['space']).toEqual({ name: 'Pets', link: '/spaces/space-pets' });
    expect(assignments.get('space-pets')).toBe('folder-home');
  });

  it('creates the folder when none has that name, trimming the name', async () => {
    const { store, folders, assignments, calls } = makeStore([pets]);
    const response = await makeToolSet(store).callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Pets', folder_name: '  Home  ' },
    });

    expect(isErrorResponse(response)).toBe(false);
    expect(calls.createSpaceFolder).toBe(1);
    expect(folders.map(folder => folder.name)).toEqual(['Home']);
    expect(assignments.get('space-pets')).toBe(folders[0]?.id);
  });

  it('reuses a folder whose name differs only in capital letters', async () => {
    const { store, folders, assignments, calls } = makeStore([pets]);
    folders.push({
      id: 'folder-home',
      name: 'Home',
      tenant_id: TENANT,
      created_by: OWNER,
      created_at: 'x',
      updated_at: 'x',
    });
    const response = await makeToolSet(store).callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Pets', folder_name: 'home' },
    });

    expect(parsed(response)['folder']).toBe('Home');
    expect(calls.createSpaceFolder).toBe(0);
    expect(assignments.get('space-pets')).toBe('folder-home');
  });

  it('takes the space out of its folder when folder_name is null', async () => {
    const { store, folders, assignments } = makeStore([pets]);
    folders.push({
      id: 'folder-home',
      name: 'Home',
      tenant_id: TENANT,
      created_by: OWNER,
      created_at: 'x',
      updated_at: 'x',
    });
    assignments.set('space-pets', 'folder-home');
    const response = await makeToolSet(store).callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Pets', folder_name: null },
    });

    const result = parsed(response);
    expect(result['summary']).toBe('Took the space "Pets" out of its folder.');
    expect(result['folder']).toBeNull();
    expect(assignments.has('space-pets')).toBe(false);
  });

  it('refuses an unknown space name, says what to do next, and makes no folder', async () => {
    const { store, folders } = makeStore([pets]);
    const response = await makeToolSet(store).callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Nope', folder_name: 'Home' },
    });

    expect(isErrorResponse(response)).toBe(true);
    expect(parsed(response)['error']).toBe('No space is named "Nope". Call list_spaces to see the spaces you have.');
    expect(folders).toEqual([]);
  });

  it('refuses a blank or too long folder name with the field named', async () => {
    const { store } = makeStore([pets]);
    const toolSet = makeToolSet(store);
    for (const folder_name of ['   ', 'x'.repeat(65)]) {
      const response = await toolSet.callTool({
        name: MOVE_SPACE_TOOL_NAME,
        arguments: { space_name: 'Pets', folder_name },
      });
      expect(isErrorResponse(response)).toBe(true);
      expect(String(parsed(response)['error'])).toContain('folder_name');
    }
  });

  it('leaves the space revision and updated time untouched', async () => {
    const { store, spaces } = makeStore([pets]);
    const toolSet = makeToolSet(store);
    await toolSet.callTool({ name: MOVE_SPACE_TOOL_NAME, arguments: { space_name: 'Pets', folder_name: 'Home' } });

    expect(spaces.get('space-pets')).toEqual(pets);
    const read = parsed(await toolSet.callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} }));
    expect(read['aggregate_revision']).toBe(7);
    expect(folderEntries(read)[0]?.['revision']).toBe(3);
  });

  it("does not reach another person's spaces or folders", async () => {
    const mine = makeRecord({ id: 'space-mine', name: 'Shared name' });
    const theirs = makeRecord({ id: 'space-theirs', name: 'Their page', created_by: OTHER_OWNER });
    const { store, folders } = makeStore([mine, theirs]);
    folders.push({
      id: 'folder-theirs',
      name: 'Private',
      tenant_id: TENANT,
      created_by: OTHER_OWNER,
      created_at: 'x',
      updated_at: 'x',
    });
    const toolSet = makeToolSet(store);

    const refused = await toolSet.callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Their page', folder_name: 'Private' },
    });
    expect(isErrorResponse(refused)).toBe(true);

    await toolSet.callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Shared name', folder_name: 'Private' },
    });
    expect(folders.filter(folder => folder.created_by === OWNER).map(folder => folder.name)).toEqual(['Private']);
    const listed = parsed(await toolSet.callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} }));
    expect(listed['folders']).toEqual(['Private']);
  });

  it('asks to send the call again when the folder is removed mid-move', async () => {
    const { store, folders } = makeStore([pets]);
    const racing: SpaceToolStore = {
      ...store,
      createSpaceFolder: async input => {
        const created = await store.createSpaceFolder(input);
        folders.length = 0;
        return created;
      },
    };
    const response = await makeToolSet(racing).callTool({
      name: MOVE_SPACE_TOOL_NAME,
      arguments: { space_name: 'Pets', folder_name: 'Home' },
    });

    expect(isErrorResponse(response)).toBe(true);
    expect(String(parsed(response)['error'])).toContain('Send the move_space call again.');
  });
});

describe('folders in space reads', () => {
  it('shows each space folder name or null, and every folder name, in list_spaces', async () => {
    const filed = makeRecord({ id: 'space-filed', name: 'Filed' });
    const loose = makeRecord({ id: 'space-loose', name: 'Loose' });
    const { store, folders, assignments } = makeStore([filed, loose]);
    folders.push(
      { id: 'f1', name: 'Home', tenant_id: TENANT, created_by: OWNER, created_at: 'x', updated_at: 'x' },
      { id: 'f2', name: 'Work', tenant_id: TENANT, created_by: OWNER, created_at: 'x', updated_at: 'x' },
    );
    assignments.set('space-filed', 'f1');

    const result = parsed(await makeToolSet(store).callTool({ name: LIST_SPACES_TOOL_NAME, arguments: {} }));

    expect(folderEntries(result).map(entry => [entry['name'], entry['folder']])).toEqual([
      ['Filed', 'Home'],
      ['Loose', null],
    ]);
    expect(result['folders']).toEqual(['Home', 'Work']);
    expect(JSON.stringify(result)).not.toContain('folder_id');
  });

  it('shows the folder in get_space metadata', async () => {
    const filed = makeRecord({ id: 'space-filed', name: 'Filed' });
    const { store, folders, assignments } = makeStore([filed]);
    folders.push({ id: 'f1', name: 'Home', tenant_id: TENANT, created_by: OWNER, created_at: 'x', updated_at: 'x' });
    assignments.set('space-filed', 'f1');

    const result = parsed(
      await makeToolSet(store).callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Filed' } }),
    );

    expect(isRecord(result['space']) ? result['space']['folder'] : undefined).toBe('Home');
  });
});
