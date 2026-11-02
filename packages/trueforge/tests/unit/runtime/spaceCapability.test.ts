import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import { createWebSearchTurnState, InstructionBuilder, isAuthRequired } from '@truefoundry/trueforge-core/core';
import {
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_BLOCKS_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import {
  SpaceAggregateRevisionConflictError,
  SpaceRevisionConflictError,
  SpaceRevisionNotFoundError,
  type ISpaceStore,
  type SpaceRecord,
} from '../../../src/db/spaceStore';
import { blockFingerprint, spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { noSpaceFolders } from './spaceFolderStoreFake';

/** The default record body: one table, so one block (b1) whose content is the whole body. */
const TABLE_BODY = '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |';
const TABLE_BODY_EDITED = '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |';

const NOOP_EXECUTION_TRACE: AgentExecutionTrace = {
  runInContext: operation => operation(),
  startSubAgent: () => NOOP_EXECUTION_TRACE,
  setOutput: () => undefined,
  setMetrics: () => undefined,
  setError: () => undefined,
  setSuccess: () => undefined,
  end: () => undefined,
};
const NOOP_LOCAL_TOOL_TRACE: AgentLocalToolTrace = {
  setOutput: () => undefined,
  setSandboxId: () => undefined,
};
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

function resultText(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected space tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

function makeStore(overrides: Partial<ISpaceStore> = {}): SpaceToolStore {
  return {
    createSpace: jest.fn(),
    updateSpace: jest.fn(),
    revertSpace: jest.fn(),
    listSpacesWithAggregate: jest
      .fn()
      .mockResolvedValue({ records: [], aggregate_revision: 0, has_more: false, next_offset: null }),
    getSpace: jest.fn(),
    ...noSpaceFolders,
    getSpaceRevision: jest.fn(),
    ...overrides,
  };
}

function makeSpaceRecord(overrides: Partial<SpaceRecord> = {}): SpaceRecord {
  return {
    tenant_id: 'default',
    created_by: 'user-a',
    id: 'space-1',
    name: 'Spain houses',
    purpose: 'Track candidate houses in Spain.',
    status: 'active' as const,
    body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
    format: 'markdown' as const,
    revision: 1,
    created_at: '2026-09-13T00:00:00.000Z',
    updated_at: '2026-09-13T00:00:00.000Z',
    ...overrides,
  };
}

async function callTool(store: SpaceToolStore, name: string, args: Record<string, unknown>) {
  const capability = spaceCapability({
    store,
    authority: { tenantId: 'default', userRef: 'user-a' },
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return await toolSet.callTool({ name, arguments: args });
}

describe('space capability', () => {
  it('declares both tools and an instruction paragraph', () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    expect(capability.instructionBuilders?.length).toBe(1);
    expect(capability.preLLMProcessors).toBeUndefined();
  });

  it('instructs the model to author every html space unconditionally', () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const builder = InstructionBuilder.createSystemPrompt('test');
    capability.instructionBuilders?.[0]?.(builder);
    const rendered = builder.build();

    expect(rendered).toContain('web-artifacts-builder');
    expect(rendered).toContain("format 'html'");
    expect(rendered).toContain('<style>');
    expect(rendered).toContain('no external stylesheets');
    expect(rendered).toContain('Author every html space');
    expect(rendered).not.toContain('If the web-artifacts-builder skill is available');
  });

  it('keeps the rule against writing a space through sandbox files in the always-sent create_space description', async () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }
    const response = await toolSet.listTools();
    const tools = 'result' in response ? response.result.tools : [];
    const createSpace = tools.find(tool => tool.name === CREATE_SPACE_TOOL_NAME);
    expect(createSpace?.description).toContain('never by editing files in the sandbox');
  });

  it('tells the model to use only picture links a search or an opened page returned, and never to make one up', () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const builder = InstructionBuilder.createSystemPrompt('test');
    const firstBuilder = capability.instructionBuilders?.[0];
    expect(firstBuilder).toBeDefined();
    firstBuilder!(builder);
    const rendered = builder.build();

    const expectedSubstrings: string[] = [
      'use only a picture link a search result or a page you opened in this chat returned',
      'a plain link only from a search result',
      'Never make one up; if you have none, leave pictures out and say so.',
    ];
    expectedSubstrings.forEach(substring => expect(rendered).toContain(substring));
  });

  it('instructs the model on the base stylesheet classes and gives a skeleton example', () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const builder = InstructionBuilder.createSystemPrompt('test');
    capability.instructionBuilders?.[0]?.(builder);
    const rendered = builder.build();

    expect(rendered).toContain('base stylesheet');
    expect(rendered).toContain('.page-header');
    expect(rendered).toContain('.card');
    expect(rendered).toContain('.grid-2');
    expect(rendered).toContain('.grid-3');
    expect(rendered).toContain('.badge');
    expect(rendered).toContain('.badge-success');
    expect(rendered).toContain('.badge-warning');
    expect(rendered).toContain('<details>');
    expect(rendered).toContain('<thead>');
    // A skeleton example: page header, a grid of cards, a table, and a details block.
    expect(rendered).toContain('class="page-header"');
    expect(rendered).toContain('class="grid-2"');
  });

  it('create_space calls the store with a generated id and the caller authority', async () => {
    const createSpace = jest.fn().mockResolvedValue({
      record: {
        tenant_id: 'default',
        created_by: 'user-a',
        id: 'space-1',
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
        revision: 1,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      },
      aggregate_revision: 1,
    });
    const capability = spaceCapability({
      store: makeStore({ createSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    const response = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
        expected_aggregate_revision: 0,
      },
    });

    expect(createSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        tenant_id: 'default',
        created_by: 'user-a',
        name: 'Spain houses',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
        expected_aggregate_revision: 0,
      }),
    );
    expect(resultText(response)).toContain('"aggregate_revision":1');
  });

  it('create_space accepts format and defaults it to markdown when omitted', async () => {
    const createSpace = jest.fn().mockResolvedValue({ record: makeSpaceRecord(), aggregate_revision: 1 });
    const capability = spaceCapability({
      store: makeStore({ createSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Launch tracker',
        purpose: 'Track the launch checklist.',
        status: 'active',
        body: '<style>.card{color:red}</style><h1>Launch tracker</h1>',
        format: 'html',
        expected_aggregate_revision: 0,
      },
    });
    expect(createSpace).toHaveBeenCalledWith(expect.objectContaining({ format: 'html' }));

    await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: 'Plain notes.',
        expected_aggregate_revision: 0,
      },
    });
    expect(createSpace).toHaveBeenLastCalledWith(expect.objectContaining({ format: 'markdown' }));
  });

  it('edit_space passes the resolved space id and both expected revisions through', async () => {
    const updateSpace = jest.fn().mockResolvedValue({
      record: {
        tenant_id: 'default',
        created_by: 'user-a',
        id: 'space-1',
        name: 'Spain houses (shortlist)',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |',
        revision: 2,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:05:00.000Z',
      },
      aggregate_revision: 2,
    });
    const capability = spaceCapability({
      store: makeStore({
        updateSpace,
        getSpace: jest.fn().mockResolvedValue(makeSpaceRecord({ revision: 1 })),
        listSpacesWithAggregate: jest.fn().mockResolvedValue({
          records: [makeSpaceRecord({ revision: 1 })],
          aggregate_revision: 1,
          has_more: false,
          next_offset: null,
        }),
      }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Spain houses',
        new_title: 'Spain houses (shortlist)',
        edits: [
          { type: 'block', anchor: 'b1', fingerprint: blockFingerprint(TABLE_BODY), new_content: TABLE_BODY_EDITED },
        ],
        expected_revision: 1,
        expected_aggregate_revision: 1,
      },
    });

    expect(updateSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        space_id: 'space-1',
        name: 'Spain houses (shortlist)',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |',
        expected_revision: 1,
        expected_aggregate_revision: 1,
      }),
    );
  });

  it('returns a terminal tool error, not a throw, for a stale aggregate revision', async () => {
    const createSpace = jest
      .fn()
      .mockRejectedValue(new SpaceAggregateRevisionConflictError({ expected_revision: 0, actual_revision: 1 }));
    const capability = spaceCapability({
      store: makeStore({ createSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    const response = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: 'Spain houses to review.',
        expected_aggregate_revision: 0,
      },
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('Stale space aggregate revision');
  });

  it('create_space refuses a body given as an array of lines: body is one string', async () => {
    const createSpace = jest.fn();
    const capability = spaceCapability({
      store: makeStore({ createSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    const response = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: ['| Address | Price |', '| --- | --- |', '| Calle Mayor 1 | 250000 |', '', 'More notes.'],
        expected_aggregate_revision: 0,
      },
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('Invalid space call');
    expect(resultText(response)).toContain('body');
    expect(resultText(response)).toContain('Fix the listed fields and send the call again.');
    expect(createSpace).not.toHaveBeenCalled();
  });

  it('edit_space passes the edited body to the store as one string', async () => {
    const updateSpace = jest.fn().mockResolvedValue({
      record: {
        tenant_id: 'default',
        created_by: 'user-a',
        id: 'space-1',
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |',
        revision: 2,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:05:00.000Z',
      },
      aggregate_revision: 2,
    });
    const capability = spaceCapability({
      store: makeStore({
        updateSpace,
        getSpace: jest.fn().mockResolvedValue(makeSpaceRecord({ revision: 1 })),
        listSpacesWithAggregate: jest.fn().mockResolvedValue({
          records: [makeSpaceRecord({ revision: 1 })],
          aggregate_revision: 1,
          has_more: false,
          next_offset: null,
        }),
      }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    await toolSet.callTool({
      name: EDIT_SPACE_TOOL_NAME,
      arguments: {
        space_name: 'Spain houses',
        edits: [
          { type: 'block', anchor: 'b1', fingerprint: blockFingerprint(TABLE_BODY), new_content: TABLE_BODY_EDITED },
        ],
        expected_revision: 1,
        expected_aggregate_revision: 1,
      },
    });

    expect(updateSpace).toHaveBeenCalledWith(
      expect.objectContaining({ body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |' }),
    );
  });

  it('does not leak tenant_id or created_by from the store record into the tool result', async () => {
    const createSpace = jest.fn().mockResolvedValue({
      record: {
        tenant_id: 'default',
        created_by: 'user-a',
        id: 'space-1',
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: 'Body text.',
        format: 'markdown',
        revision: 1,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      },
      aggregate_revision: 1,
    });
    const capability = spaceCapability({
      store: makeStore({ createSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    const response = await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: 'Body text.',
        expected_aggregate_revision: 0,
      },
    });

    const text = resultText(response);
    expect(text).not.toContain('tenant_id');
    expect(text).not.toContain('created_by');
    expect(text).not.toContain('default');
    expect(text).not.toContain('user-a');
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('(id:');
    expect(JSON.parse(text)).toEqual({
      summary: 'Created space "Spain houses" (revision 1).',
      space: {
        name: 'Spain houses',
        link: '/spaces/space-1',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: 'Body text.',
        format: 'markdown',
        revision: 1,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      },
      aggregate_revision: 1,
      blocks: [{ anchor: 'b1', fingerprint: blockFingerprint('Body text.'), preview: 'Body text.', occurrences: 1 }],
      format_notes: [],
    });
  });

  it('list_spaces returns summaries without body, plus aggregate_revision and has_more', async () => {
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [
        makeSpaceRecord({ id: 'space-1' }),
        makeSpaceRecord({ id: 'space-2', name: 'Spain houses (archive)', status: 'archived', revision: 3 }),
      ],
      aggregate_revision: 4,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ listSpacesWithAggregate });

    const response = await callTool(store, LIST_SPACES_TOOL_NAME, {});

    expect(listSpacesWithAggregate).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'default', created_by: 'user-a', status: undefined }),
    );
    const text = resultText(response);
    expect(text).not.toContain('body');
    expect(JSON.parse(text)).toEqual({
      spaces: [
        {
          name: 'Spain houses',
          link: '/spaces/space-1',
          folder: null,
          purpose: 'Track candidate houses in Spain.',
          status: 'active',
          format: 'markdown',
          revision: 1,
          created_at: '2026-09-13T00:00:00.000Z',
          updated_at: '2026-09-13T00:00:00.000Z',
        },
        {
          name: 'Spain houses (archive)',
          link: '/spaces/space-2',
          folder: null,
          purpose: 'Track candidate houses in Spain.',
          status: 'archived',
          format: 'markdown',
          revision: 3,
          created_at: '2026-09-13T00:00:00.000Z',
          updated_at: '2026-09-13T00:00:00.000Z',
        },
      ],
      folders: [],
      aggregate_revision: 4,
      has_more: false,
    });
  });

  it('get_space returns the full space body plus the current aggregate_revision', async () => {
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord());
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [makeSpaceRecord()], aggregate_revision: 4, has_more: false, next_offset: null });
    const store = makeStore({ getSpace, listSpacesWithAggregate });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Spain houses' });

    expect(getSpace).toHaveBeenCalledWith({ tenant_id: 'default', created_by: 'user-a', space_id: 'space-1' });
    expect(JSON.parse(resultText(response))).toEqual({
      space: {
        name: 'Spain houses',
        link: '/spaces/space-1',
        folder: null,
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
        format: 'markdown',
        revision: 1,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      },
      blocks: [
        {
          anchor: 'b1',
          fingerprint: blockFingerprint(TABLE_BODY),
          preview: '| Address | Price | | --- | --- | | Calle Mayor 1 | 250000 |',
          occurrences: 1,
        },
      ],
      aggregate_revision: 4,
      format_notes: [],
    });
  });

  it('get_space returns a terminal error naming list_spaces when the name matches nothing', async () => {
    const store = makeStore();

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Missing' });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('list_spaces');
  });

  it('create_space omits expected_aggregate_revision: the host reads the current value and the call succeeds', async () => {
    const createSpace = jest.fn().mockResolvedValue({ record: makeSpaceRecord(), aggregate_revision: 3 });
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [], aggregate_revision: 2, has_more: false, next_offset: null });
    const store = makeStore({ createSpace, listSpacesWithAggregate });

    await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Spain houses',
      purpose: 'Track candidate houses in Spain.',
      status: 'active',
      body: 'Body text.',
    });

    expect(listSpacesWithAggregate).toHaveBeenCalledWith(expect.objectContaining({ limit: 1 }));
    expect(createSpace).toHaveBeenCalledWith(expect.objectContaining({ expected_aggregate_revision: 2 }));
  });

  it('edit_space refuses a call without expected_revision, naming the field: entries address one named revision', async () => {
    const updateSpace = jest
      .fn()
      .mockResolvedValue({ record: makeSpaceRecord({ revision: 2 }), aggregate_revision: 3 });
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord({ revision: 1 }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ revision: 1 })],
      aggregate_revision: 2,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ updateSpace, getSpace, listSpacesWithAggregate });

    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: blockFingerprint(TABLE_BODY), new_content: TABLE_BODY_EDITED },
      ],
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('Invalid space call');
    expect(resultText(response)).toContain('expected_revision');
    expect(updateSpace).not.toHaveBeenCalled();
  });

  it('a supplied stale aggregate revision returns the current aggregate_revision in the error', async () => {
    const createSpace = jest
      .fn()
      .mockRejectedValue(new SpaceAggregateRevisionConflictError({ expected_revision: 0, actual_revision: 5 }));
    const store = makeStore({ createSpace });

    const response = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Spain houses',
      purpose: 'Track candidate houses in Spain.',
      status: 'active',
      body: 'Spain houses to review.',
      expected_aggregate_revision: 0,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error:
        'Stale space aggregate revision. Call list_spaces to read the current aggregate_revision, ' +
        'then send the call again with expected_aggregate_revision set to the aggregate_revision in this result.',
      aggregate_revision: 5,
    });
  });

  it('a supplied stale space revision returns the current revision in the error', async () => {
    const updateSpace = jest
      .fn()
      .mockRejectedValue(new SpaceRevisionConflictError({ id: 'space-1', expected_revision: 1, actual_revision: 4 }));
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord({ revision: 4 }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ revision: 4 })],
      aggregate_revision: 1,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ updateSpace, getSpace, listSpacesWithAggregate });

    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: blockFingerprint(TABLE_BODY), new_content: TABLE_BODY_EDITED },
      ],
      expected_revision: 1,
      expected_aggregate_revision: 1,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error:
        'The space is at revision 4, not 1. The anchors and fingerprints below are current: ' +
        'send the edit again with expected_revision 4 and these fingerprints.',
      revision: 4,
      blocks: [
        { anchor: 'b1', fingerprint: blockFingerprint(TABLE_BODY), preview: expect.any(String), occurrences: 1 },
      ],
    });
    expect(updateSpace).not.toHaveBeenCalled();
  });

  it('a store that loses the revision race after the read returns the fresh outline', async () => {
    const updateSpace = jest
      .fn()
      .mockRejectedValue(new SpaceRevisionConflictError({ id: 'space-1', expected_revision: 1, actual_revision: 2 }));
    const getSpace = jest
      .fn()
      .mockResolvedValueOnce(makeSpaceRecord({ revision: 1 }))
      .mockResolvedValue(makeSpaceRecord({ revision: 2 }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ revision: 1 })],
      aggregate_revision: 1,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ updateSpace, getSpace, listSpacesWithAggregate });

    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: blockFingerprint(TABLE_BODY), new_content: TABLE_BODY_EDITED },
      ],
      expected_revision: 1,
      expected_aggregate_revision: 1,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    const parsed = JSON.parse(resultText(response));
    expect(parsed.error).toBe(
      'The space is at revision 2, not 1. The anchors and fingerprints below are current: ' +
        'send the edit again with expected_revision 2 and these fingerprints.',
    );
    expect(parsed.revision).toBe(2);
    expect(parsed.blocks).toHaveLength(1);
  });

  it('edit_space returns a terminal error naming list_spaces when the name matches nothing', async () => {
    const store = makeStore();

    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Missing',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: '00000000', new_content: 'b' }],
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('list_spaces');
  });

  it('get_space with revision reads a historical revision through getSpaceRevision', async () => {
    const historical = makeSpaceRecord({ revision: 18, body: 'The good version.' });
    const getSpaceRevision = jest.fn().mockResolvedValue(historical);
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [makeSpaceRecord()], aggregate_revision: 21, has_more: false, next_offset: null });
    const store = makeStore({ getSpaceRevision, listSpacesWithAggregate });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Spain houses', revision: 18 });

    expect(getSpaceRevision).toHaveBeenCalledWith({
      tenant_id: 'default',
      created_by: 'user-a',
      space_id: 'space-1',
      revision: 18,
    });
    const parsed = JSON.parse(resultText(response)) as { space: { revision: number; body: string } };
    expect(parsed.space.revision).toBe(18);
    expect(parsed.space.body).toBe('The good version.');
  });

  it('get_space with a revision outside the retained window returns a terminal error', async () => {
    const getSpaceRevision = jest.fn().mockResolvedValue(undefined);
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [makeSpaceRecord()], aggregate_revision: 4, has_more: false, next_offset: null });
    const store = makeStore({ getSpaceRevision, listSpacesWithAggregate });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Spain houses', revision: 1 });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('Only recent revisions are retained');
  });

  it('get_space with include_body=false omits the body from the returned space', async () => {
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord());
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [makeSpaceRecord()], aggregate_revision: 4, has_more: false, next_offset: null });
    const store = makeStore({ getSpace, listSpacesWithAggregate });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Spain houses', include_body: false });

    const parsed = JSON.parse(resultText(response));
    expect(parsed.space).not.toHaveProperty('body');
    expect(parsed).toEqual({
      space: {
        name: 'Spain houses',
        link: '/spaces/space-1',
        folder: null,
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        format: 'markdown',
        revision: 1,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      },
      // The outline rides along without the body: anchors and fingerprints are what an
      // edit names, and the default record is one table, so one block.
      blocks: [
        {
          anchor: 'b1',
          fingerprint: blockFingerprint(TABLE_BODY),
          preview: '| Address | Price | | --- | --- | | Calle Mayor 1 | 250000 |',
          occurrences: 1,
        },
      ],
      aggregate_revision: 4,
      format_notes: [],
    });
  });

  it('get_space with include_body=false and a revision omits the body of the historical revision', async () => {
    const historical = makeSpaceRecord({ revision: 18, body: 'The good version.' });
    const getSpaceRevision = jest.fn().mockResolvedValue(historical);
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [makeSpaceRecord()], aggregate_revision: 21, has_more: false, next_offset: null });
    const store = makeStore({ getSpaceRevision, listSpacesWithAggregate });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      revision: 18,
      include_body: false,
    });

    expect(getSpaceRevision).toHaveBeenCalledWith({
      tenant_id: 'default',
      created_by: 'user-a',
      space_id: 'space-1',
      revision: 18,
    });
    const parsed = JSON.parse(resultText(response));
    expect(parsed.space.revision).toBe(18);
    expect(parsed.space).not.toHaveProperty('body');
  });

  it('revert_space restores a historical revision as a new current revision', async () => {
    const revertSpace = jest.fn().mockResolvedValue({
      record: makeSpaceRecord({ revision: 22, body: 'The good version.' }),
      aggregate_revision: 23,
    });
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord({ revision: 21, body: 'a' }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ revision: 21, body: 'a' })],
      aggregate_revision: 22,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ revertSpace, getSpace, listSpacesWithAggregate });

    const response = await callTool(store, REVERT_SPACE_TOOL_NAME, { space_name: 'Spain houses', revision: 18 });

    expect(revertSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        space_id: 'space-1',
        revision: 18,
        expected_revision: 21,
        expected_aggregate_revision: 22,
      }),
    );
    const parsed = JSON.parse(resultText(response)) as { space: { revision: number; body: string } };
    expect(parsed.space.revision).toBe(22);
    expect(parsed.space.body).toBe('The good version.');
  });

  it('revert_space returns a terminal error naming the current revision when expected_revision is stale', async () => {
    const revertSpace = jest
      .fn()
      .mockRejectedValue(new SpaceRevisionConflictError({ id: 'space-1', expected_revision: 20, actual_revision: 21 }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ revision: 21 })],
      aggregate_revision: 22,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ revertSpace, listSpacesWithAggregate });

    const response = await callTool(store, REVERT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      revision: 18,
      expected_revision: 20,
      expected_aggregate_revision: 22,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error:
        'Stale space revision: space-1. Call get_space to read the current revision, then send the call ' +
        'again with expected_revision set to the revision in this result.',
      revision: 21,
    });
  });

  it('revert_space returns a terminal error for a revision outside the retained window', async () => {
    const revertSpace = jest.fn().mockRejectedValue(new SpaceRevisionNotFoundError({ id: 'space-1', revision: 1 }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ revision: 21 })],
      aggregate_revision: 22,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ revertSpace, listSpacesWithAggregate });

    const response = await callTool(store, REVERT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      revision: 1,
      expected_revision: 21,
      expected_aggregate_revision: 22,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('Only recent revisions are retained');
  });

  it('edit_space refuses a dramatic shrink of the body without confirm_shrink', async () => {
    const updateSpace = jest.fn();
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord({ body: 'x'.repeat(1000) }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ body: 'x'.repeat(1000) })],
      aggregate_revision: 2,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ updateSpace, getSpace, listSpacesWithAggregate });

    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: blockFingerprint('x'.repeat(1000)), new_content: 'a' }],
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('confirm_shrink');
    expect(updateSpace).not.toHaveBeenCalled();
  });

  it('edit_space with confirm_shrink allows replacing almost all of the body', async () => {
    const updateSpace = jest
      .fn()
      .mockResolvedValue({ record: makeSpaceRecord({ revision: 2, body: 'a' }), aggregate_revision: 3 });
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord({ body: 'x'.repeat(1000) }));
    const listSpacesWithAggregate = jest.fn().mockResolvedValue({
      records: [makeSpaceRecord({ body: 'x'.repeat(1000) })],
      aggregate_revision: 2,
      has_more: false,
      next_offset: null,
    });
    const store = makeStore({ updateSpace, getSpace, listSpacesWithAggregate });

    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Spain houses',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: blockFingerprint('x'.repeat(1000)), new_content: 'a' }],
      confirm_shrink: true,
    });

    expect(updateSpace).toHaveBeenCalledWith(expect.objectContaining({ body: 'a' }));
    const parsed = JSON.parse(resultText(response)) as { space: { body: string } };
    expect(parsed.space.body).toBe('a');
  });
});

/** The model-facing schemas of the space tools, read the way the model receives them. */
describe('space tool model-facing schemas', () => {
  async function listedSpaceTools(): Promise<Map<string, { required: string[]; properties: string[] }>> {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }
    const listed = await toolSet.listTools();
    if (isAuthRequired(listed)) {
      throw new Error('space tools should not require auth');
    }
    return new Map(
      listed.result.tools.map(tool => [
        tool.name,
        {
          required: tool.inputSchema.required ?? [],
          properties: Object.keys(tool.inputSchema.properties ?? {}),
        },
      ]),
    );
  }

  it.each([
    [LIST_SPACES_TOOL_NAME, []],
    [GET_SPACE_TOOL_NAME, ['space_name']],
    [CREATE_SPACE_TOOL_NAME, ['body', 'name', 'purpose', 'status']],
    [EDIT_SPACE_TOOL_NAME, ['edits', 'expected_revision', 'space_name']],
    [REVERT_SPACE_TOOL_NAME, ['revision', 'space_name']],
    [LIST_BLOCKS_TOOL_NAME, ['space_name']],
  ])('%s keeps the required fields the model must send', async (name, required) => {
    const tools = await listedSpaceTools();
    expect([...(tools.get(name)?.required ?? [])].sort()).toEqual(required);
  });

  it('update_space is not offered, and edit_space offers the one edits list addressed by name', async () => {
    const tools = await listedSpaceTools();
    expect(tools.has(UPDATE_SPACE_TOOL_NAME)).toBe(false);
    const editProperties = tools.get(EDIT_SPACE_TOOL_NAME)?.properties ?? [];
    expect(editProperties).toEqual(
      expect.arrayContaining(['edits', 'confirm_shrink', 'expected_revision', 'space_name', 'new_title']),
    );
    expect(editProperties).not.toContain('body');
    expect(editProperties).not.toContain('block_edits');
    expect(editProperties).not.toContain('space_id');
    expect(editProperties).not.toContain('name');
  });
});
