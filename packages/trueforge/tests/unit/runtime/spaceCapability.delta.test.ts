import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core';
/**
 * User journey test for edit_space delta edits.
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
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_BLOCKS_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
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
  body: string;
  revision: number;
  name: string;
  purpose: string;
  status: string;
  format: string;
}

interface SpaceWireResult {
  space?: SpaceWireSpace;
  spaces?: { name: string; link: string }[];
  aggregate_revision?: number;
  /** Per-entry block outcomes, reported by the edit_space path. */
  block_results?: { anchor: string; new_length: number; deleted: boolean }[];
  /** The block outline, reported by list_blocks and by get_space. */
  blocks?: { anchor: string; fingerprint: string }[];
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
    webSearch: createWebSearchTurnState(),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return await toolSet.callTool({ name, arguments: args });
}

/**
 * The id of the space a create call just made, read from the store itself: tool results
 * carry the name and link, never an id, and the tools address spaces by name now. The id
 * is only for this file's own store-level reads. Every store here holds one space per test.
 */
async function expectSpaceId(store: SpaceToolStore, created: CallToolResponse): Promise<string> {
  if (isErrorResponse(created)) {
    throw new Error(`expected the create call to succeed: ${resultText(created)}`);
  }
  const listed = await store.listSpacesWithAggregate({
    tenant_id: 'default',
    created_by: 'user-a',
    status: undefined,
    limit: 10,
  });
  if (listed.records.length !== 1 || listed.records[0] === undefined) {
    throw new Error(`expected exactly one space in the store, got ${String(listed.records.length)}`);
  }
  return listed.records[0].id;
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
  return expectSpaceId(store, created);
}

/** The fingerprint list_blocks shows for one anchor of the named space, read the way a model reads it. */
async function fingerprintOf(store: SpaceToolStore, input: { spaceName: string; anchor: string }): Promise<string> {
  const listed = await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: input.spaceName });
  const block = (resultJson(listed).blocks ?? []).find(candidate => candidate.anchor === input.anchor);
  if (block === undefined) {
    throw new Error(`expected block ${input.anchor} in the list_blocks result for ${input.spaceName}`);
  }
  return block.fingerprint;
}

async function readBody(store: SpaceToolStore, spaceId: string): Promise<string> {
  const listed = await store.listSpacesWithAggregate({
    tenant_id: 'default',
    created_by: 'user-a',
    status: undefined,
    limit: 10,
  });
  const record = listed.records.find(candidate => candidate.id === spaceId);
  if (record === undefined) {
    throw new Error(`expected space ${spaceId} in the store`);
  }
  const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: record.name });
  return expectBody(read);
}

describe('edit_space delta edits: Madrid board journey', () => {
  it('a small price change via edits leaves the rest of the board untouched', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // The hotel confirms a lower rate: update just that cell via edits,
    // without resending the whole board. The board has no markers and no blank
    // lines, so it is one structural block, b1.
    const updated = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: MADRID_BOARD.replace('€1,646.91', '€1,590.00'),
        },
      ],
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

  it('an unknown block anchor fails cleanly and the board is unchanged', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    const failed = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b9', fingerprint: '00000000', new_content: '€1,590.00' }],
    });
    const parsed = resultJson(failed);
    expect(isErrorResponse(failed)).toBe(true);
    expect(parsed.error).toContain('entry #1');
    expect(parsed.error).toContain('Unknown block anchor');

    // The board is untouched: the failed edit persisted nothing.
    const body = await readBody(store, spaceId);
    expect(body).toContain('€1,646.91');
    expect(body).not.toContain('€1,590.00');
  });

  it('multi-edit atomicity: a later miss rolls back an earlier hit', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);
    const before = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: BOARD_META.name });
    const beforeJson = resultJson(before);
    const beforeSpace = expectSpace(before);
    const beforeRevision = beforeSpace.revision;
    const beforeBody = beforeSpace.body;

    // Edit #1 would succeed; edit #2 names a block that does not exist. Nothing may persist.
    const failed = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: MADRID_BOARD.replace('€1,646.91', '€1,590.00'),
        },
        { type: 'block', anchor: 'b9', fingerprint: '00000000', new_content: '€0.00' },
      ],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('entry #2');

    // Body byte-identical, and neither the revision nor the aggregate revision bumped.
    const after = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: BOARD_META.name });
    const afterJson = resultJson(after);
    expect(await readBody(store, spaceId)).toBe(beforeBody);
    expect(expectSpace(after).revision).toBe(beforeRevision);
    expect(afterJson.aggregate_revision).toBe(beforeJson.aggregate_revision);
  });

  it('entries in one call all apply against the blocks of the one revision the call names', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Notes',
      purpose: 'Two paragraphs.',
      status: 'active',
      format: 'markdown',
      body: 'First paragraph.\n\nSecond paragraph.',
    });
    const spaceId = await expectSpaceId(store, created);

    // Both entries resolve against revision 1's blocks, in one call, one revision bump.
    const updated = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Notes',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: 'Notes', anchor: 'b1' }),
          new_content: 'First paragraph, updated.',
        },
        {
          type: 'block',
          anchor: 'b2',
          fingerprint: await fingerprintOf(store, { spaceName: 'Notes', anchor: 'b2' }),
          new_content: 'Second paragraph, updated.',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(store, spaceId)).toBe('First paragraph, updated.\n\nSecond paragraph, updated.');
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Notes' });
    expect(expectSpace(read).revision).toBe(2);
  });

  it('edits without metadata leave name/purpose/status/format unchanged', async () => {
    const store = new InMemorySpaceStore();
    await createBoard(store);

    // No metadata fields: the edit applies and metadata is preserved from the current record.
    const updated = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: MADRID_BOARD.replace('€1,646.91', '€1,590.00'),
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: BOARD_META.name });
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
    const wiped = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: '<p>oops</p>',
        },
      ],
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
    const wiped = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      confirm_shrink: true,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: '<p>oops</p>',
        },
      ],
    });
    expect(isErrorResponse(wiped)).toBe(false);
    expect(await readBody(store, spaceId)).toBe('<p>oops</p>');
  });

  it('edit_space rejects a full body field, and update_space is not a tool any more', async () => {
    const store = new InMemorySpaceStore();
    await createBoard(store);

    // edit_space takes an edits list only: a body is not one of its fields.
    const editCall = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      body: MADRID_BOARD,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: '00000000', new_content: 'b' }],
    });
    // Schema validation rejects the call before the handler runs, naming the bad field.
    const editError = resultJson(editCall);
    expect(isErrorResponse(editCall)).toBe(true);
    expect(editError.error).toContain('Invalid space call');
    expect(editError.error).toContain('body');
    expect(editError.error).toContain('Fix the listed fields and send the call again.');

    // The old whole-body tool is gone: a call to it is refused as unknown.
    const retiredCall = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      name: BOARD_META.name,
      purpose: BOARD_META.purpose,
      status: BOARD_META.status,
      body: MADRID_BOARD,
    });
    expect(isErrorResponse(retiredCall)).toBe(true);
    expect(resultText(retiredCall)).toContain('Unknown tool: update_space');
  });

  it('more than 50 edits are rejected by schema validation', async () => {
    const store = new InMemorySpaceStore();
    await createBoard(store);

    const edits = Array.from({ length: 51 }, () => ({
      type: 'block',
      anchor: 'b1',
      fingerprint: '00000000',
      new_content: 'b',
    }));
    const rejected = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits,
    });
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toContain('edits: is too long');
  });

  it('exactly 50 edits are accepted, and the result reports per-entry outcomes', async () => {
    const store = new InMemorySpaceStore();
    // Fifty paragraphs: fifty structural blocks, one per edit entry.
    const tokens = Array.from({ length: 50 }, (_, i) => `w${String(i).padStart(2, '0')}`);
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Tokens',
      purpose: 'Boundary probe.',
      status: 'active',
      format: 'markdown',
      body: tokens.join('\n\n'),
    });
    const spaceId = await expectSpaceId(store, created);

    const listed = await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: 'Tokens' });
    const fingerprints = new Map((resultJson(listed).blocks ?? []).map(b => [b.anchor, b.fingerprint]));
    const edits = tokens.map((t, i) => ({
      type: 'block',
      anchor: `b${String(i + 1)}`,
      fingerprint: fingerprints.get(`b${String(i + 1)}`) ?? '',
      new_content: `u${t.slice(1)}`,
    }));
    const updated = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Tokens',
      expected_revision: 1,
      edits,
    });
    expect(isErrorResponse(updated)).toBe(false);
    const parsed = resultJson(updated);
    expect(parsed.block_results).toHaveLength(50);
    expect(parsed.block_results?.[0]).toEqual({ anchor: 'b1', new_length: 3, deleted: false });

    const body = await readBody(store, spaceId);
    for (const t of tokens) {
      expect(body).not.toContain(t);
    }
    expect(body).toContain('u00');
    expect(body).toContain('u49');
  });

  it('zero edits are rejected by schema validation', async () => {
    const store = new InMemorySpaceStore();
    await createBoard(store);

    const rejected = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      edits: [],
    });
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toContain('edits: is too short');
  });

  it('a delta edit that would exceed the body size limit fails as a clean terminal error', async () => {
    const store = new InMemorySpaceStore();
    // Seeded directly in the store: one write may no longer carry 62,000 characters (a
    // space this size is built in parts now), and this test's subject is the delta whose
    // computed body crosses the stored limit, not the write that first made the space.
    const seeded = await store.createSpace({
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'big-space',
      name: 'Big',
      purpose: 'Size-limit probe.',
      status: 'active',
      format: 'markdown',
      body: 'a'.repeat(62_000),
      expected_aggregate_revision: 0,
    });
    const spaceId = seeded.record.id;

    // The body is one structural block. An insert of 4,000 more characters (the most
    // one write may carry) pushes the computed body past the 65,536 cap.
    const listed = await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: 'Big' });
    const fingerprint = (resultJson(listed).blocks ?? [])[0]?.fingerprint ?? '';
    const failed = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Big',
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b1', fingerprint, new_content: 'a'.repeat(4_000) }],
    });
    const parsed = resultJson(failed);
    expect(isErrorResponse(failed)).toBe(true);
    expect(parsed.error).toContain('65,536');

    // The refused edit persisted nothing.
    expect(await readBody(store, spaceId)).toBe('a'.repeat(62_000));
  });

  it('a delta edit with a stale expected_revision is rejected', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // Advance to revision 2 with an edit that appends a line after the board's one block.
    const boardFingerprint = await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' });
    const moved = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b1', fingerprint: boardFingerprint, new_content: '<p>Extra line.</p>' }],
    });
    expect(isErrorResponse(moved)).toBe(false);

    // The same insert sent again at the now-stale revision 1 would add a second copy: refused before persisting.
    const stale = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b1', fingerprint: boardFingerprint, new_content: '<p>Extra line.</p>' }],
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

    const updated = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: MADRID_BOARD.replace('€1,646.91', '€1,590.00'),
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);

    // Revision 1 still holds the original price.
    const historic = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: BOARD_META.name, revision: 1 });
    expect(expectBody(historic)).toContain('€1,646.91');

    // The current revision has the new price.
    expect(await readBody(store, spaceId)).toContain('€1,590.00');
  });

  it('a bad edit that wipes the board can be undone with revert_space', async () => {
    const store = new InMemorySpaceStore();
    const spaceId = await createBoard(store);

    // A bad edit replaces the whole board with a stub (the wipe the shrink guard exists for).
    const broken = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(store, { spaceName: BOARD_META.name, anchor: 'b1' }),
          new_content: '<p>truncated</p>',
        },
      ],
      confirm_shrink: true,
    });
    expect(isErrorResponse(broken)).toBe(false);
    expect(await readBody(store, spaceId)).toBe('<p>truncated</p>');

    // Revert to revision 1: the board is back.
    const reverted = await callTool(store, REVERT_SPACE_TOOL_NAME, {
      space_name: BOARD_META.name,
      revision: 1,
    });
    expect(isErrorResponse(reverted)).toBe(false);

    const body = await readBody(store, spaceId);
    expect(body).toContain('€1,646.91');
    expect(body).toContain('Iberia Express I21691');
  });
});
