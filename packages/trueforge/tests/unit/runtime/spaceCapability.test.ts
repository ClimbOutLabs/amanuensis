import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import { InstructionBuilder } from '@truefoundry/trueforge-core/core';
import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  type ISpaceStore,
  type SpaceRecord,
} from '../../../src/db/spaceStore';
import {
  CREATE_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  spaceCapability,
  UPDATE_SPACE_TOOL_NAME,
  type SpaceToolStore,
} from '../../../src/runtime/spaceCapability';

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
    listSpacesWithAggregate: jest.fn(),
    getSpace: jest.fn(),
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
    });
    expect(capability.instructionBuilders?.length).toBe(1);
    expect(capability.preLLMProcessors).toBeUndefined();
  });

  it('instructs the model to write an html space with the web-artifacts-builder skill when available', () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
    });
    const builder = InstructionBuilder.createSystemPrompt('test');
    capability.instructionBuilders?.[0]?.(builder);
    const rendered = builder.build();

    expect(rendered).toContain('web-artifacts-builder');
    expect(rendered).toContain("format 'html'");
    expect(rendered).toContain('<style>');
    expect(rendered).toContain('no external stylesheets');
  });

  it('instructs the model on the base stylesheet classes and gives a skeleton example', () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
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

  it('update_space passes the space id and both expected revisions through', async () => {
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
      store: makeStore({ updateSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    await toolSet.callTool({
      name: UPDATE_SPACE_TOOL_NAME,
      arguments: {
        space_id: 'space-1',
        name: 'Spain houses (shortlist)',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |',
        expected_revision: 1,
        expected_aggregate_revision: 1,
      },
    });

    expect(updateSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        space_id: 'space-1',
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
        body: '',
        expected_aggregate_revision: 0,
      },
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('Stale space aggregate revision');
  });

  it('create_space joins a body given as an array of lines, keeping empty-string elements as blank lines', async () => {
    const createSpace = jest.fn().mockResolvedValue({
      record: {
        tenant_id: 'default',
        created_by: 'user-a',
        id: 'space-1',
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |\n\nMore notes.',
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
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    await toolSet.callTool({
      name: CREATE_SPACE_TOOL_NAME,
      arguments: {
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: ['| Address | Price |', '| --- | --- |', '| Calle Mayor 1 | 250000 |', '', 'More notes.'],
        expected_aggregate_revision: 0,
      },
    });

    expect(createSpace).toHaveBeenCalledWith(
      expect.objectContaining({
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |\n\nMore notes.',
      }),
    );
  });

  it('update_space leaves a body given as a string unchanged', async () => {
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
      store: makeStore({ updateSpace }),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }

    await toolSet.callTool({
      name: UPDATE_SPACE_TOOL_NAME,
      arguments: {
        space_id: 'space-1',
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 240000 |',
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
    expect(JSON.parse(text)).toEqual({
      space: {
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
          id: 'space-1',
          name: 'Spain houses',
          purpose: 'Track candidate houses in Spain.',
          status: 'active',
          format: 'markdown',
          revision: 1,
          created_at: '2026-09-13T00:00:00.000Z',
          updated_at: '2026-09-13T00:00:00.000Z',
        },
        {
          id: 'space-2',
          name: 'Spain houses (archive)',
          purpose: 'Track candidate houses in Spain.',
          status: 'archived',
          format: 'markdown',
          revision: 3,
          created_at: '2026-09-13T00:00:00.000Z',
          updated_at: '2026-09-13T00:00:00.000Z',
        },
      ],
      aggregate_revision: 4,
      has_more: false,
    });
  });

  it('get_space returns the full space body plus the current aggregate_revision', async () => {
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord());
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [], aggregate_revision: 4, has_more: false, next_offset: null });
    const store = makeStore({ getSpace, listSpacesWithAggregate });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: 'space-1' });

    expect(getSpace).toHaveBeenCalledWith({ tenant_id: 'default', created_by: 'user-a', space_id: 'space-1' });
    expect(JSON.parse(resultText(response))).toEqual({
      space: {
        id: 'space-1',
        name: 'Spain houses',
        purpose: 'Track candidate houses in Spain.',
        status: 'active',
        body: '| Address | Price |\n| --- | --- |\n| Calle Mayor 1 | 250000 |',
        format: 'markdown',
        revision: 1,
        created_at: '2026-09-13T00:00:00.000Z',
        updated_at: '2026-09-13T00:00:00.000Z',
      },
      aggregate_revision: 4,
    });
  });

  it('get_space returns a terminal error naming list_spaces when the id is unknown', async () => {
    const getSpace = jest.fn().mockResolvedValue(undefined);
    const store = makeStore({ getSpace });

    const response = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: 'missing' });

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

  it('update_space omits both revisions: the host reads the current space and aggregate revisions', async () => {
    const updateSpace = jest
      .fn()
      .mockResolvedValue({ record: makeSpaceRecord({ revision: 2 }), aggregate_revision: 3 });
    const getSpace = jest.fn().mockResolvedValue(makeSpaceRecord({ revision: 1 }));
    const listSpacesWithAggregate = jest
      .fn()
      .mockResolvedValue({ records: [], aggregate_revision: 2, has_more: false, next_offset: null });
    const store = makeStore({ updateSpace, getSpace, listSpacesWithAggregate });

    await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: 'space-1',
      name: 'Spain houses',
      purpose: 'Track candidate houses in Spain.',
      status: 'active',
      body: 'Body text.',
    });

    expect(getSpace).toHaveBeenCalledWith({ tenant_id: 'default', created_by: 'user-a', space_id: 'space-1' });
    expect(updateSpace).toHaveBeenCalledWith(
      expect.objectContaining({ expected_revision: 1, expected_aggregate_revision: 2 }),
    );
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
      body: '',
      expected_aggregate_revision: 0,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error: 'Stale space aggregate revision',
      aggregate_revision: 5,
    });
  });

  it('a supplied stale space revision returns the current revision in the error', async () => {
    const updateSpace = jest
      .fn()
      .mockRejectedValue(new SpaceRevisionConflictError({ id: 'space-1', expected_revision: 1, actual_revision: 4 }));
    const store = makeStore({ updateSpace });

    const response = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: 'space-1',
      name: 'Spain houses',
      purpose: 'Track candidate houses in Spain.',
      status: 'active',
      body: '',
      expected_revision: 1,
      expected_aggregate_revision: 1,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(JSON.parse(resultText(response))).toEqual({
      error: 'Stale space revision: space-1',
      revision: 4,
    });
  });

  it('update_space returns a terminal error naming list_spaces for an unknown space id', async () => {
    const updateSpace = jest.fn().mockRejectedValue(new SpaceNotFoundError({ id: 'missing' }));
    const store = makeStore({ updateSpace });

    const response = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: 'missing',
      name: 'Spain houses',
      purpose: 'Track candidate houses in Spain.',
      status: 'active',
      body: '',
      expected_revision: 1,
      expected_aggregate_revision: 1,
    });

    if (!('result' in response)) {
      throw new Error('expected space tool result');
    }
    expect(response.result.isError).toBe(true);
    expect(resultText(response)).toContain('list_spaces');
  });
});
