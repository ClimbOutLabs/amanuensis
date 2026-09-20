/**
 * User journey test for update_space delta edits.
 *
 * This is not a unit test with mocked stores. It uses a stateful in-memory
 * store and drives the real tool sequence the way Mannie would: create a
 * space, make small delta edits to a large board, hit failure modes, and
 * recover with revert_space. The scenario is the Madrid trip board that
 * motivated delta edits — a large HTML page where resending the full body
 * for a one-line change wastes context and risks truncation.
 */
import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import {
  SpaceAggregateRevisionConflictError,
  SpaceNotFoundError,
  SpaceRevisionConflictError,
  SpaceRevisionNotFoundError,
  type CreateSpaceInput,
  type GetSpaceRevisionInput,
  type ListSpacesInput,
  type RevertSpaceInput,
  type SpaceIdentityInput,
  type SpaceMutationResult,
  type SpaceRecord,
  type UpdateSpaceInput,
} from '../../../src/db/spaceStore';
import {
  CREATE_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
  spaceCapability,
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

/** Mirrors the production store's retained-revision window. */
const SPACE_REVISION_HISTORY_LIMIT = 20;

/**
 * A real (in-memory) space store. Unlike jest.fn() mocks, this persists
 * across tool calls, tracks revisions, enforces the same fencing the
 * production store does, and retains bounded history — so the test
 * verifies actual behavior, not canned responses.
 */
class InMemorySpaceStore implements SpaceToolStore {
  private spaces = new Map<string, SpaceRecord>();
  private history = new Map<string, SpaceRecord[]>();
  private aggregateRevision = 0;

  private checkAggregate(expected: number): void {
    if (expected !== this.aggregateRevision) {
      throw new SpaceAggregateRevisionConflictError({
        expected_revision: expected,
        actual_revision: this.aggregateRevision,
      });
    }
  }

  private requireCurrent(space_id: string): SpaceRecord {
    const current = this.spaces.get(space_id);
    if (current === undefined) {
      throw new SpaceNotFoundError({ id: space_id });
    }
    return current;
  }

  private checkRevision(space_id: string, expected: number): SpaceRecord {
    const current = this.requireCurrent(space_id);
    if (expected !== current.revision) {
      throw new SpaceRevisionConflictError({
        id: space_id,
        expected_revision: expected,
        actual_revision: current.revision,
      });
    }
    return current;
  }

  private pushHistory(space_id: string, record: SpaceRecord): void {
    const entries = this.history.get(space_id) ?? [];
    entries.push({ ...record });
    while (entries.length > SPACE_REVISION_HISTORY_LIMIT) {
      entries.shift();
    }
    this.history.set(space_id, entries);
  }

  async createSpace(input: CreateSpaceInput): Promise<SpaceMutationResult> {
    this.checkAggregate(input.expected_aggregate_revision);
    this.aggregateRevision += 1;
    const record: SpaceRecord = {
      tenant_id: input.tenant_id,
      created_by: input.created_by,
      id: input.id,
      name: input.name,
      purpose: input.purpose,
      status: input.status,
      body: input.body,
      format: input.format,
      revision: 1,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this.spaces.set(input.id, record);
    this.pushHistory(input.id, record);
    return { record, aggregate_revision: this.aggregateRevision };
  }

  async updateSpace(input: UpdateSpaceInput): Promise<SpaceMutationResult> {
    const current = this.checkRevision(input.space_id, input.expected_revision);
    this.checkAggregate(input.expected_aggregate_revision);
    this.aggregateRevision += 1;
    const updated: SpaceRecord = {
      ...current,
      name: input.name,
      purpose: input.purpose,
      status: input.status,
      body: input.body,
      format: input.format,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    };
    this.spaces.set(input.space_id, updated);
    this.pushHistory(input.space_id, updated);
    return { record: updated, aggregate_revision: this.aggregateRevision };
  }

  async revertSpace(input: RevertSpaceInput): Promise<SpaceMutationResult> {
    const current = this.checkRevision(input.space_id, input.expected_revision);
    this.checkAggregate(input.expected_aggregate_revision);
    const target = this.history.get(input.space_id)?.find(r => r.revision === input.revision);
    if (target === undefined) {
      throw new SpaceRevisionNotFoundError({ id: input.space_id, revision: input.revision });
    }
    this.aggregateRevision += 1;
    const reverted: SpaceRecord = {
      ...target,
      revision: current.revision + 1,
      updated_at: new Date().toISOString(),
    };
    this.spaces.set(input.space_id, reverted);
    this.pushHistory(input.space_id, reverted);
    return { record: reverted, aggregate_revision: this.aggregateRevision };
  }

  async getSpace(input: SpaceIdentityInput): Promise<SpaceRecord | undefined> {
    return this.spaces.get(input.space_id);
  }

  async getSpaceRevision(input: GetSpaceRevisionInput): Promise<SpaceRecord | undefined> {
    return this.history.get(input.space_id)?.find(r => r.revision === input.revision);
  }

  async listSpacesWithAggregate(input: ListSpacesInput) {
    const offset = input.offset ?? 0;
    const records = [...this.spaces.values()]
      .filter(r => input.status === undefined || r.status === input.status)
      .slice(offset, offset + input.limit);
    return {
      records,
      aggregate_revision: this.aggregateRevision,
      has_more: false,
      next_offset: null,
    };
  }
}

/** The wire shape the space tools return: a space payload, a terminal error, or both. */
interface SpaceWireSpace {
  id: string;
  body: string;
  revision: number;
  name: string;
  purpose: string;
  status: string;
  format: string;
}

interface SpaceWireResult {
  space?: SpaceWireSpace;
  aggregate_revision?: number;
  /** Per-edit replacement counts, reported by the update_space edits path. */
  edit_replacements?: number[];
  error?: string;
  revision?: number;
  details?: unknown;
}

function resultText(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected space tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

/** Terminal tool errors surface as `isError` on the MCP result, not inside the JSON text. */
function isErrorResponse(response: CallToolResponse): boolean {
  return 'result' in response && response.result.isError === true;
}

function resultJson(response: CallToolResponse): SpaceWireResult {
  const parsed: SpaceWireResult = JSON.parse(resultText(response));
  return parsed;
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

function expectSpaceId(response: CallToolResponse): string {
  const id = resultJson(response).space?.id;
  if (id === undefined) {
    throw new Error(`expected a space id in tool result: ${resultText(response)}`);
  }
  return id;
}

function expectBody(response: CallToolResponse): string {
  const body = resultJson(response).space?.body;
  if (body === undefined) {
    throw new Error(`expected a space body in tool result: ${resultText(response)}`);
  }
  return body;
}

function expectSpace(response: CallToolResponse): SpaceWireSpace {
  const space = resultJson(response).space;
  if (space === undefined) {
    throw new Error(`expected a space in tool result: ${resultText(response)}`);
  }
  return space;
}

/** A realistic Madrid trip board: large HTML, one small fact to change. */
const MADRID_BOARD = `<div class="page-header"><h1>Madrid Trip</h1><p class="subtitle">Sep 22 – Oct 6, 2026</p></div>
<div class="grid-2"><div class="card"><h3>Outbound</h3><p>Iberia 7JWH6U, Sep 22</p></div>
<div class="card"><h3>Hotel</h3><p>Petit Palace Santa Bárbara</p></div></div>
<table><thead><tr><th>Item</th><th>Detail</th><th>Cost</th></tr></thead><tbody>
<tr><td>Hotel Sep 24-30</td><td>Double room, breakfast</td><td>€1,646.91</td></tr>
<tr><td>Flight MAD-IBZ</td><td>Iberia Express I21691, Sep 30</td><td>$87</td></tr>
<tr><td>Ushuaïa Sep 30-Oct 6</td><td>Front-row room</td><td>€2,200/night</td></tr>
</tbody></table>
<details><summary>Notes</summary><p>Confirm Sep 23-24 extra night.</p></details>`;

const BOARD_META = {
  name: 'Madrid Trip',
  purpose: 'Track Madrid/Ibiza trip details.',
  status: 'active',
  format: 'html',
} as const;

async function createBoard(store: SpaceToolStore): Promise<string> {
  const created = await callTool(store, CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body: MADRID_BOARD });
  return expectSpaceId(created);
}

async function readBody(store: SpaceToolStore, spaceId: string): Promise<string> {
  const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
  return expectBody(read);
}

describe('update_space delta edits: Madrid board journey', () => {
  it('a small price change via edits leaves the rest of the board untouched', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // The hotel confirms a lower rate: update just that cell via edits,
    // without resending the whole board.
    const updated = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [{ search: '€1,646.91', replace: '€1,590.00' }],
    });
    expect(isErrorResponse(updated)).toBe(false);

    // Only the price changed.
    const body = await readBody(store, spaceId);
    expect(body).toContain('€1,590.00');
    expect(body).not.toContain('€1,646.91');
    expect(body).toContain('Iberia Express I21691');
    expect(body).toContain('€2,200/night');
    expect(body).toContain('Confirm Sep 23-24 extra night.');
  });

  it('a typo in the search text fails cleanly and the board is unchanged', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const failed = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [{ search: '€1,646.92', replace: '€1,590.00' }],
    });
    const parsed = resultJson(failed);
    expect(isErrorResponse(failed)).toBe(true);
    expect(parsed.error).toContain('Edit #1');
    expect(parsed.error).toContain('not found');

    // The board is untouched: the failed edit persisted nothing.
    const body = await readBody(store, spaceId);
    expect(body).toContain('€1,646.91');
    expect(body).not.toContain('€1,590.00');
  });

  it('multi-edit atomicity: a later miss rolls back an earlier hit', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);
    const before = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
    const beforeJson = resultJson(before);
    const beforeSpace = expectSpace(before);
    const beforeRevision = beforeSpace.revision;
    const beforeBody = beforeSpace.body;

    // Edit #1 would succeed; edit #2 misses. Nothing may persist.
    const failed = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [
        { search: '€1,646.91', replace: '€1,590.00' },
        { search: '€9,999.99', replace: '€0.00' },
      ],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Edit #2');

    // Body byte-identical, and neither the revision nor the aggregate revision bumped.
    const after = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
    const afterJson = resultJson(after);
    expect(await readBody(store, spaceId)).toBe(beforeBody);
    expect(expectSpace(after).revision).toBe(beforeRevision);
    expect(afterJson.aggregate_revision).toBe(beforeJson.aggregate_revision);
  });

  it('edits apply in order, so later edits see earlier results', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const updated = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [
        { search: '€1,646.91', replace: 'PRICE_PLACEHOLDER' },
        { search: 'PRICE_PLACEHOLDER', replace: '€1,590.00' },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);

    const body = await readBody(store, spaceId);
    expect(body).toContain('€1,590.00');
    expect(body).not.toContain('PRICE_PLACEHOLDER');
  });

  it('each search replaces every occurrence in the body', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Fruit',
      purpose: 'Track fruit.',
      status: 'active',
      format: 'markdown',
      body: 'apples and apples',
    });
    const spaceId = expectSpaceId(created);

    const updated = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      name: 'Fruit',
      purpose: 'Track fruit.',
      status: 'active',
      format: 'markdown',
      edits: [{ search: 'apples', replace: 'oranges' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const parsed = resultJson(updated);
    // Both occurrences were replaced, and the result says so.
    expect(parsed.edit_replacements).toEqual([2]);
    expect(await readBody(store, spaceId)).toBe('oranges and oranges');
  });

  it('edits without metadata leave name/purpose/status/format unchanged', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // No metadata fields: the edit applies and metadata is preserved from the current record.
    const updated = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: '€1,646.91', replace: '€1,590.00' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
    const space = expectSpace(read);
    expect(space.name).toBe(BOARD_META.name);
    expect(space.purpose).toBe(BOARD_META.purpose);
    expect(space.status).toBe(BOARD_META.status);
    expect(space.format).toBe(BOARD_META.format);
  });

  it('a delta edit that would wipe the board is refused by the shrink guard', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // A buggy edit replacing the entire board with a stub: the shrink guard
    // applies to delta-computed bodies too.
    const wiped = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [{ search: MADRID_BOARD, replace: '<p>oops</p>' }],
    });
    const parsed = resultJson(wiped);
    expect(isErrorResponse(wiped)).toBe(true);
    expect(parsed.error).toContain('confirm_shrink');

    // The refused edit persisted nothing.
    expect(await readBody(store, spaceId)).toBe(MADRID_BOARD);
  });

  it('confirm_shrink allows an intentional wipe via edits', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // Same destructive edit, but the caller explicitly confirms the shrink.
    const wiped = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      confirm_shrink: true,
      edits: [{ search: MADRID_BOARD, replace: '<p>oops</p>' }],
    });
    expect(isErrorResponse(wiped)).toBe(false);
    expect(await readBody(store, spaceId)).toBe('<p>oops</p>');
  });

  it('providing both body and edits is rejected', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const rejected = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body: MADRID_BOARD,
      edits: [{ search: 'a', replace: 'b' }],
    });
    // Schema validation rejects the call before the handler runs.
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toBe('Validation failed');
    expect(JSON.stringify(parsed.details)).toContain('Provide exactly one of body');
  });

  it('more than 50 edits are rejected by schema validation', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const edits = Array.from({ length: 51 }, () => ({ search: 'a', replace: 'b' }));
    const rejected = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits,
    });
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toBe('Validation failed');
  });

  it('exactly 50 edits are accepted, and the result reports per-edit counts', async () => {
    const store = new InMemorySpaceStore();
    // Fixed-width tokens: no token is a substring of another, so each edit
    // matches exactly its own token.
    const tokens = Array.from({ length: 50 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Tokens',
      purpose: 'Boundary probe.',
      status: 'active',
      format: 'markdown',
      body: tokens.join(' '),
    });
    const spaceId = expectSpaceId(created);

    const edits = tokens.map(t => ({ search: t, replace: `u${t.slice(1)}` }));
    const updated = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      name: 'Tokens',
      purpose: 'Boundary probe.',
      status: 'active',
      format: 'markdown',
      edits,
    });
    expect(isErrorResponse(updated)).toBe(false);
    const parsed = resultJson(updated);
    expect(parsed.edit_replacements).toEqual(new Array(50).fill(1));

    const body = await readBody(store, spaceId);
    for (const t of tokens) {
      expect(body).not.toContain(t);
    }
    expect(body).toContain('u00');
    expect(body).toContain('u49');
  });

  it('zero edits are rejected by schema validation', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const rejected = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [],
    });
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toBe('Validation failed');
  });

  it('a delta edit that would exceed the body size limit fails as a clean terminal error', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Big',
      purpose: 'Size-limit probe.',
      status: 'active',
      format: 'markdown',
      body: 'a'.repeat(60_000),
    });
    const spaceId = expectSpaceId(created);

    // One edit doubles every character, pushing the computed body (120,000
    // chars) past the 65,536 cap the body path enforces at the boundary.
    const failed = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      name: 'Big',
      purpose: 'Size-limit probe.',
      status: 'active',
      format: 'markdown',
      edits: [{ search: 'a', replace: 'aa' }],
    });
    const parsed = resultJson(failed);
    expect(isErrorResponse(failed)).toBe(true);
    expect(parsed.error).toContain('65,536');

    // The refused edit persisted nothing.
    expect(await readBody(store, spaceId)).toBe('a'.repeat(60_000));
  });

  it('a delta edit with a stale expected_revision is rejected', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // Advance to revision 2 with a full-body update.
    const moved = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body: [MADRID_BOARD, '<p>Extra line.</p>'],
    });
    expect(isErrorResponse(moved)).toBe(false);

    // A delta edit fenced at the now-stale revision 1 fails before persisting.
    const stale = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      expected_revision: 1,
      edits: [{ search: '€1,646.91', replace: '€1,590.00' }],
    });
    const parsed = resultJson(stale);
    expect(isErrorResponse(stale)).toBe(true);
    expect(parsed.revision).toBe(2);

    // Nothing was persisted.
    expect(await readBody(store, spaceId)).toContain('€1,646.91');
  });

  it('get_space can read the pre-edit revision after a delta update', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const updated = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      edits: [{ search: '€1,646.91', replace: '€1,590.00' }],
    });
    expect(isErrorResponse(updated)).toBe(false);

    // Revision 1 still holds the original price.
    const historic = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId, revision: 1 });
    expect(expectBody(historic)).toContain('€1,646.91');

    // The current revision has the new price.
    expect(await readBody(store, spaceId)).toContain('€1,590.00');
  });

  it('a bad full-body update can be undone with revert_space', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // A truncated full-body update wipes the board (the original bug).
    const broken = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body: '<p>truncated</p>',
      confirm_shrink: true,
    });
    expect(isErrorResponse(broken)).toBe(false);
    expect(await readBody(store, spaceId)).toBe('<p>truncated</p>');

    // Revert to revision 1: the board is back.
    const reverted = await callTool(store, REVERT_SPACE_TOOL_NAME, {
      space_id: spaceId,
      revision: 1,
    });
    expect(isErrorResponse(reverted)).toBe(false);

    const body = await readBody(store, spaceId);
    expect(body).toContain('€1,646.91');
    expect(body).toContain('Iberia Express I21691');
  });
});
