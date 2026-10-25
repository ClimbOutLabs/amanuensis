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
  UPDATE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import type { SpaceRecord } from '../../../src/db/spaceStore';
import { SpaceAggregateRevisionConflictError, SpaceRevisionConflictError } from '../../../src/db/spaceStore';
import { spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { isRecord } from '../../fixtures/jsonGuards';

/**
 * The simplified contract: body is one string everywhere, partial changes go through
 * edit_space alone, every error names its next step, and results carry name and link.
 */

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

const DIRECTIVE = 'Fix the listed fields and send the call again.';

function textOf(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected a space tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

function isErrorResponse(response: CallToolResponse): boolean {
  return 'result' in response && response.result.isError === true;
}

/** Guards for tool-result JSON, so the tests never lean on an assertion escape. */
function parsedObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) {
    throw new Error('expected a JSON object');
  }
  return parsed;
}

function fieldObject(owner: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = owner[field];
  if (!isRecord(value)) {
    throw new Error(`expected an object ${field}`);
  }
  return value;
}

function stringField(owner: Record<string, unknown>, field: string): string {
  const value = owner[field];
  if (typeof value !== 'string') {
    throw new Error(`expected a string ${field}`);
  }
  return value;
}

function numberField(owner: Record<string, unknown>, field: string): number {
  const value = owner[field];
  if (typeof value !== 'number') {
    throw new Error(`expected a number ${field}`);
  }
  return value;
}

function makeStore(): SpaceToolStore {
  const rows = new Map<string, SpaceRecord>();
  let aggregate = 0;
  const save = (record: SpaceRecord) => {
    rows.set(record.id, record);
    aggregate += 1;
    return { record, aggregate_revision: aggregate };
  };
  return {
    createSpace: async input =>
      save({
        tenant_id: AUTHORITY.tenantId,
        created_by: AUTHORITY.userRef,
        id: input.id,
        name: input.name,
        purpose: input.purpose,
        status: input.status,
        body: input.body,
        format: input.format,
        revision: 1,
        created_at: '2026-10-21T00:00:00.000Z',
        updated_at: '2026-10-21T00:00:00.000Z',
      }),
    updateSpace: async input => {
      const current = rows.get(input.space_id);
      if (current === undefined) {
        throw new Error(`no space ${input.space_id}`);
      }
      if (input.expected_revision !== undefined && input.expected_revision !== current.revision) {
        throw new SpaceRevisionConflictError({
          id: current.id,
          expected_revision: input.expected_revision,
          actual_revision: current.revision,
        });
      }
      if (input.expected_aggregate_revision !== undefined && input.expected_aggregate_revision !== aggregate) {
        throw new SpaceAggregateRevisionConflictError({
          expected_revision: input.expected_aggregate_revision,
          actual_revision: aggregate,
        });
      }
      return save({
        ...current,
        name: input.name,
        purpose: input.purpose,
        status: input.status,
        body: input.body,
        format: input.format,
        revision: current.revision + 1,
      });
    },
    revertSpace: async () => {
      throw new Error('not used in these tests');
    },
    getSpace: async input => rows.get(input.space_id),
    getSpaceRevision: async input => {
      const current = rows.get(input.space_id);
      return current !== undefined && current.revision === input.revision ? current : undefined;
    },
    listSpacesWithAggregate: async () => ({
      records: [...rows.values()],
      aggregate_revision: aggregate,
      has_more: false,
      next_offset: null,
    }),
  };
}

type Call = (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>;

function makeCall(store: SpaceToolStore): Call {
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
  return (name, args) => toolSet.callTool({ name, arguments: args });
}

async function createSpace(call: Call, options: { name: string; body: string }): Promise<void> {
  const response = await call(CREATE_SPACE_TOOL_NAME, {
    name: options.name,
    purpose: `${options.name} purpose.`,
    status: 'active',
    format: 'markdown',
    body: options.body,
  });
  expect(isErrorResponse(response)).toBe(false);
}

async function errorOf(response: CallToolResponse): Promise<string> {
  const parsed = parsedObject(textOf(response));
  const error = parsed['error'];
  return typeof error === 'string' ? error : '';
}

describe('space contract: one string body, one edit shape, guided errors, name and link results', () => {
  it('stores a single string body with its blank lines unchanged', async () => {
    const call = makeCall(makeStore());
    const body = '# Title\n\nLine one.\n\nLine two.';
    await createSpace(call, { name: 'Blank lines', body });
    const read = fieldObject(
      parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: 'Blank lines' }))),
      'space',
    );
    expect(stringField(read, 'body')).toBe(body);
  });

  it('refuses an array body on update_space, since the contract takes one string body only', async () => {
    const call = makeCall(makeStore());
    await createSpace(call, { name: 'Array update', body: '# Array update\nOld line.' });
    const response = await call(UPDATE_SPACE_TOOL_NAME, {
      space_name: 'Array update',
      name: 'Array update',
      purpose: 'Array update purpose.',
      status: 'active',
      format: 'markdown',
      body: ['# Array update', 'A line.'],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = await errorOf(response);
    expect(error).toContain('Invalid space call');
    expect(error).toContain('body');
    expect(error).toContain(DIRECTIVE);
  });

  it('refuses edit_space entries without a type, with an unknown type, and an empty edits list', async () => {
    const call = makeCall(makeStore());
    await createSpace(call, { name: 'Edit shapes', body: '# Edit shapes\nSome text here.' });
    const cases: Record<string, unknown>[] = [
      { edits: [{ search: 'Some', replace: 'Any' }] },
      { edits: [{ type: 'replace', search: 'Some', replace: 'Any' }] },
      { edits: [] },
    ];
    for (const entry of cases) {
      const response = await call(EDIT_SPACE_TOOL_NAME, { space_name: 'Edit shapes', ...entry });
      expect(isErrorResponse(response)).toBe(true);
      const error = await errorOf(response);
      expect(error).toContain('Invalid space call');
      expect(error).toContain(DIRECTIVE);
    }
    const noType = await errorOf(
      await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Edit shapes',
        edits: [{ search: 'Some', replace: 'Any' }],
      }),
    );
    expect(noType).toContain('type');
    const empty = await errorOf(await call(EDIT_SPACE_TOOL_NAME, { space_name: 'Edit shapes', edits: [] }));
    expect(empty).toContain('edits');
  });

  it('refuses a search entry missing its replacement, naming the field and the next step', async () => {
    const call = makeCall(makeStore());
    await createSpace(call, { name: 'Search shape', body: '# Search shape\nSome text here.' });
    const response = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Search shape',
      edits: [{ type: 'search', search: 'Some' }],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = await errorOf(response);
    expect(error).toContain('Invalid space call');
    expect(error).toContain('replace');
    expect(error).toContain(DIRECTIVE);
  });

  it('stale revisions name the recovery call: revision, aggregate, and missing revision', async () => {
    const call = makeCall(makeStore());
    await createSpace(call, { name: 'Stale board', body: '# Stale board\nA line of content here.' });

    const listed = parsedObject(textOf(await call(LIST_SPACES_TOOL_NAME, {})));
    const spaces = listed['spaces'];
    if (!Array.isArray(spaces) || spaces.length !== 1) {
      throw new Error('expected exactly one space');
    }
    const first = spaces[0];
    if (typeof first !== 'object' || first === null || Array.isArray(first)) {
      throw new Error('expected a space object');
    }
    const spaceId = first['id'];
    if (typeof spaceId !== 'string') {
      throw new Error('expected a string space id');
    }

    const missing = await call(GET_SPACE_TOOL_NAME, { space_id: spaceId, revision: 99 });
    expect(isErrorResponse(missing)).toBe(true);
    expect(await errorOf(missing)).toContain('Call get_space without a revision to read the current revision.');

    const conflict = await call(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      name: 'Stale board',
      purpose: 'Stale board purpose.',
      status: 'active',
      format: 'markdown',
      body: '# Stale board\nNew line.',
      expected_revision: 5,
    });
    expect(isErrorResponse(conflict)).toBe(true);
    const conflictError = await errorOf(conflict);
    expect(conflictError).toContain(
      'Call get_space to read the current revision, then send the call again with expected_revision set to the revision in this result.',
    );
    expect(textOf(conflict)).toContain('revision');

    const aggregateConflict = await call(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      name: 'Stale board',
      purpose: 'Stale board purpose.',
      status: 'active',
      format: 'markdown',
      body: '# Stale board\nNew line.',
      expected_aggregate_revision: 9,
    });
    expect(isErrorResponse(aggregateConflict)).toBe(true);
    expect(await errorOf(aggregateConflict)).toContain(
      'Call list_spaces to read the current aggregate_revision, then send the call again with expected_aggregate_revision set to the aggregate_revision in this result.',
    );
    expect(textOf(aggregateConflict)).toContain('aggregate_revision');
  });

  it('the shrink guard names the tool refused, on update and on edit', async () => {
    const call = makeCall(makeStore());
    const longBody = `${'# Shrink board\n'}${'A line of body text that stays.\n'.repeat(20)}`;
    await createSpace(call, { name: 'Shrink board', body: longBody });

    const wiped = await call(UPDATE_SPACE_TOOL_NAME, {
      space_name: 'Shrink board',
      name: 'Shrink board',
      purpose: 'Shrink board purpose.',
      status: 'active',
      format: 'markdown',
      body: '<p>oops</p>',
    });
    expect(isErrorResponse(wiped)).toBe(true);
    expect(await errorOf(wiped)).toContain('call update_space again with confirm_shrink: true');

    const bulk = 'A'.repeat(500);
    await createSpace(call, { name: 'Shrink edit', body: `${bulk}\nKeep this line.` });
    const shrunk = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Shrink edit',
      edits: [{ type: 'search', search: bulk, replace: 'x' }],
    });
    expect(isErrorResponse(shrunk)).toBe(true);
    expect(await errorOf(shrunk)).toContain('call edit_space again with confirm_shrink: true');
  });

  it('edit_space failures name the next step: miss, bad anchor, duplicate anchor, lockout, over-long body', async () => {
    const call = makeCall(makeStore());
    await createSpace(call, {
      name: 'Edit failures',
      body: '# Edit failures\n<!-- @block:main -->\nSome text here.',
    });

    const missed = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Edit failures',
      edits: [{ type: 'search', search: 'absent words', replace: 'x' }],
    });
    expect(await errorOf(missed)).toContain('then pass the full body via update_space');

    const badAnchor = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Edit failures',
      edits: [{ type: 'block', anchor: 'nope', new_content: 'x' }],
    });
    expect(await errorOf(badAnchor)).toContain(
      'Retry edit_space with one of the valid anchors, or send the full updated body via update_space',
    );

    await createSpace(call, {
      name: 'Duplicate anchors',
      body: '<!-- @block:dup --><p>first</p><!-- @block:dup --><p>second</p>',
    });
    const duplicate = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicate anchors',
      edits: [{ type: 'block', anchor: 'dup', new_content: '<p>winner</p>' }],
    });
    expect(isErrorResponse(duplicate)).toBe(true);
    expect(await errorOf(duplicate)).toContain('edit_space needs a unique anchor');

    await createSpace(call, { name: 'Lockout board', body: '# Lockout board\nSome text here.' });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Lockout board',
        edits: [{ type: 'search', search: 'absent words', replace: 'x' }],
      });
      expect(isErrorResponse(failed)).toBe(true);
    }
    const locked = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Lockout board',
      edits: [{ type: 'search', search: 'Some', replace: 'Any' }],
    });
    expect(await errorOf(locked)).toContain('Do not call edit_space again for this space.');

    await createSpace(call, { name: 'Too long board', body: `TOKEN\n${'x'.repeat(64_990)}` });
    const tooLong = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Too long board',
      edits: [{ type: 'search', search: 'TOKEN', replace: 'y'.repeat(2000) }],
    });
    expect(isErrorResponse(tooLong)).toBe(true);
    expect(await errorOf(tooLong)).toContain('Refusing edit_space on');
  });

  it('edit_space results carry name and link, never an id', async () => {
    const call = makeCall(makeStore());
    await createSpace(call, { name: 'Edit board', body: '# Edit board\nSome text here.' });
    const response = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Edit board',
      edits: [{ type: 'search', search: 'Some', replace: 'Any' }],
    });
    expect(isErrorResponse(response)).toBe(false);
    const text = textOf(response);
    const parsed = parsedObject(text);
    const space = fieldObject(parsed, 'space');
    expect(stringField(parsed, 'summary')).toBe('Updated space "Edit board" (revision 2).');
    expect(stringField(space, 'name')).toBe('Edit board');
    expect(stringField(space, 'link')).toMatch(/^\/spaces\/[^/]+$/);
    expect(text).not.toContain('"id"');
    expect(text).not.toContain('(id:');
    expect(numberField(space, 'revision')).toBe(2);
  });
});
