import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core';
/**
 * Reliability tests for update_space (Phase 1 circuit breaker + Phase 2 block anchors).
 *
 * Same style as spaceCapability.delta.test.ts: a stateful in-memory store drives the real
 * tool sequence the way Mannie would. Each test gets its own session id so the
 * process-wide breaker map (keyed per tenant/user/session/space, like production) stays
 * isolated between tests.
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
import { Writable } from 'stream';
import { createLogger, format, transports, type Logger } from 'winston';
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

/** Same in-memory store as the delta journey test: real persistence, fencing, history. */
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

interface SpaceWireSpace {
  id: string;
  body: string;
  revision: number;
  name: string;
  purpose: string;
  status: string;
  format: string;
}

interface SpaceWireBlock {
  anchor: string;
  fingerprint: string;
  preview: string;
  occurrences: number;
}

interface SpaceWireBlockResult {
  anchor: string;
  new_length: number;
  deleted: boolean;
}

interface SpaceWireResult {
  space?: SpaceWireSpace;
  spaces?: { name: string; link: string }[];
  aggregate_revision?: number;
  edit_replacements?: number[];
  block_results?: SpaceWireBlockResult[];
  preamble?: { preview: string; char_count: number } | null;
  blocks?: SpaceWireBlock[];
  space_name?: string;
  revision?: number;
  error?: string;
  details?: unknown;
}

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

function resultJson(response: CallToolResponse): SpaceWireResult {
  return JSON.parse(resultText(response)) as SpaceWireResult;
}

let sessionCounter = 0;

/**
 * One harness per test: a fresh store plus ONE capability instance reused across calls,
 * with a unique session id — mirroring production, where the breaker map is keyed per
 * session and survives turn boundaries.
 */
function makeHarness(logger?: Logger, overrides?: { tenantId?: string; userRef?: string; sessionId?: string }) {
  const store = new InMemorySpaceStore();
  sessionCounter += 1;
  const sessionId = overrides?.sessionId ?? `reliability-session-${String(sessionCounter)}`;
  const capability = spaceCapability({
    store,
    authority: { tenantId: overrides?.tenantId ?? 'default', userRef: overrides?.userRef ?? 'user-a' },
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
    sessionId,
    ...(logger === undefined ? {} : { logger }),
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  const callTool = (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });
  return { store, callTool, sessionId };
}

/**
 * The name of the space a create call just made: tool results carry the name and link,
 * never an id, and every later call addresses the space by its exact name. Every board
 * in this file is BOARD_META's, so the name is known once the create succeeds.
 */
async function expectSpaceName(created: CallToolResponse): Promise<string> {
  if (isErrorResponse(created)) {
    throw new Error(`expected the create call to succeed: ${resultText(created)}`);
  }
  return BOARD_META.name;
}

function expectBody(response: CallToolResponse): string {
  const body = resultJson(response).space?.body;
  if (body === undefined) {
    throw new Error(`expected a space body in tool result: ${resultText(response)}`);
  }
  return body;
}

function expectPreamble(response: CallToolResponse): { preview: string; char_count: number } | null {
  const preamble = resultJson(response).preamble;
  return preamble === undefined ? null : preamble;
}

function expectBlocks(response: CallToolResponse): SpaceWireBlock[] {
  const blocks = resultJson(response).blocks;
  if (blocks === undefined) {
    throw new Error(`expected blocks in tool result: ${resultText(response)}`);
  }
  return blocks;
}

const BOARD_META = {
  name: 'Madrid Trip',
  purpose: 'Track Madrid/Ibiza trip details.',
  status: 'active',
  format: 'html',
} as const;

/** Large HTML board with independently-updated sections delimited by block markers. */
const ANCHORED_BOARD = `<!-- @block:header -->
<div class="page-header"><h1>Madrid Trip</h1><p class="subtitle">Sep 22 \u2013 Oct 6, 2026</p></div>
<!-- @block:stats -->
<div class="grid-2"><div class="card"><h3>Outbound</h3><p>Iberia 7JWH6U, Sep 22</p></div>
<div class="card"><h3>Hotel</h3><p>Petit Palace Santa B\u00e1rbara</p></div></div>
<!-- @block:table -->
<table><thead><tr><th>Item</th><th>Detail</th><th>Cost</th></tr></thead><tbody>
<tr><td>Hotel Sep 24-30</td><td>Double room, breakfast</td><td>\u20ac1,646.91</td></tr>
<tr><td>Flight MAD-IBZ</td><td>Iberia Express I21691, Sep 30</td><td>$87</td></tr>
</tbody></table>
<!-- @block:notes -->
<details><summary>Notes</summary><p>Confirm Sep 23-24 extra night.</p></details>`;

/** Same content with no block markers: the anchorless-space case. */
const PLAIN_BOARD = `<div class="page-header"><h1>Madrid Trip</h1><p class="subtitle">Sep 22 \u2013 Oct 6, 2026</p></div>
<div class="grid-2"><div class="card"><h3>Outbound</h3><p>Iberia 7JWH6U, Sep 22</p></div>
<div class="card"><h3>Hotel</h3><p>Petit Palace Santa B\u00e1rbara</p></div></div>
<table><thead><tr><th>Item</th><th>Detail</th><th>Cost</th></tr></thead><tbody>
<tr><td>Hotel Sep 24-30</td><td>Double room, breakfast</td><td>\u20ac1,646.91</td></tr>
</tbody></table>`;

async function createAnchoredBoard(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
): Promise<string> {
  const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body: ANCHORED_BOARD });
  return expectSpaceName(created);
}

async function createPlainBoard(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
): Promise<string> {
  const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body: PLAIN_BOARD });
  return expectSpaceName(created);
}

async function readBody(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
): Promise<string> {
  return expectBody(await callTool(GET_SPACE_TOOL_NAME, { space_name: spaceName }));
}

async function failedEdits(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
  revision = 1,
): Promise<SpaceWireResult> {
  const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
    space_name: spaceName,
    expected_revision: revision,
    edits: [{ type: 'block', anchor: 'no-such-block', fingerprint: '00000000', new_content: 'x' }],
  });
  expect(isErrorResponse(failed)).toBe(true);
  const parsed = resultJson(failed);
  expect(parsed.error).toBeDefined();
  return parsed;
}

/** The fingerprint list_blocks shows for one anchor, read the way a model reads it. */
async function fingerprintOf(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  input: { spaceName: string; anchor: string },
): Promise<string> {
  const blocks = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: input.spaceName }));
  const block = blocks.find(candidate => candidate.anchor === input.anchor);
  if (block === undefined) {
    throw new Error(`expected block ${input.anchor} in the list_blocks result for ${input.spaceName}`);
  }
  return block.fingerprint;
}

describe('Phase 1: consecutive-failure circuit breaker', () => {
  it('the unknown-anchor error steers to the valid anchors and a fresh read, never to reproducing text', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);

    const parsed = await failedEdits(callTool, spaceName);
    expect(parsed.error).toContain('Retry edit_space with one of the valid anchors');
    expect(parsed.error).toContain('make the change with edit_space in parts');
    expect(parsed.error).not.toContain('search');
    expect(parsed.error).not.toContain('full updated body');
  });

  it('trips after 3 consecutive failures; the 4th delta call gets the terminal lock error', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);
    const boardFingerprint = await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' });

    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);

    // Delta mode is now locked: even a would-be-good edit is refused.
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: boardFingerprint,
          new_content: PLAIN_BOARD.replace('\u20ac1,646.91', '\u20ac1,590.00'),
        },
      ],
    });
    expect(isErrorResponse(locked)).toBe(true);
    const parsed = resultJson(locked);
    expect(parsed.error).toContain('locked');
    expect(parsed.error).toContain("revert_space with the space's current");
    expect(parsed.error).toContain('keeps the body exactly');
    expect(parsed.error).not.toContain('Send the full updated body');

    // An insert entry is delta mode too: locked as well.
    const lockedInsert = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b1', fingerprint: boardFingerprint, new_content: 'x' }],
    });
    expect(isErrorResponse(lockedInsert)).toBe(true);
    expect(resultJson(lockedInsert).error).toContain('locked');

    // The refused calls persisted nothing.
    expect(await readBody(callTool, spaceName)).toBe(PLAIN_BOARD);
  });

  it('a success between failures resets the consecutive counter', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);

    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);
    // A successful delta resets the count.
    const good = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' }),
          new_content: PLAIN_BOARD.replace('\u20ac1,646.91', '\u20ac1,590.00'),
        },
      ],
    });
    expect(isErrorResponse(good)).toBe(false);
    // The fresh fingerprint for the changed board, chained from the edit's own result.
    const freshFingerprint = (resultJson(good).blocks ?? [])[0]?.fingerprint ?? '';

    // Two more failures are not enough to trip the breaker.
    await failedEdits(callTool, spaceName, 2);
    await failedEdits(callTool, spaceName, 2);
    const stillOpen = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 2,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: freshFingerprint,
          new_content: PLAIN_BOARD.replace('\u20ac1,646.91', '\u20ac1,500.00'),
        },
      ],
    });
    expect(isErrorResponse(stillOpen)).toBe(false);
    expect(await readBody(callTool, spaceName)).toContain('\u20ac1,500.00');
  });

  it('no other write unlocks delta mode: creating another space leaves the lock in place', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);
    const boardFingerprint = await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' });

    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);
    // Locked: sanity check.
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: boardFingerprint, new_content: 'b' }],
    });
    expect(resultJson(locked).error).toContain('locked');

    // A successful create_space is a write, but it is not an unlock: revert_space is
    // the only way back into delta mode for the locked space.
    const other = await callTool(CREATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      name: 'Lisbon Trip',
      body: PLAIN_BOARD,
    });
    expect(isErrorResponse(other)).toBe(false);

    const stillLocked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: boardFingerprint, new_content: 'Another line.' }],
    });
    expect(isErrorResponse(stillLocked)).toBe(true);
    expect(resultJson(stillLocked).error).toContain('locked');
  });

  it('revert_space unlocks delta mode', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);
    const boardFingerprint = await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' });

    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);

    const reverted = await callTool(REVERT_SPACE_TOOL_NAME, { space_name: spaceName, revision: 1 });
    expect(isErrorResponse(reverted)).toBe(false);

    // The revert made revision 2; the body (and so the fingerprint) is unchanged.
    const editsAgain = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 2,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: boardFingerprint,
          new_content: PLAIN_BOARD.replace('\u20ac1,646.91', '\u20ac1,590.00'),
        },
      ],
    });
    expect(isErrorResponse(editsAgain)).toBe(false);
  });

  it('the breaker is scoped per session: another session is unaffected', async () => {
    const first = makeHarness();
    const spaceName = await createPlainBoard(first.callTool);
    await failedEdits(first.callTool, spaceName);
    await failedEdits(first.callTool, spaceName);
    await failedEdits(first.callTool, spaceName);

    // A different session (fresh harness, same store would be ideal, but the
    // breaker key includes the session id, so a new harness proves isolation).
    const second = makeHarness();
    const spaceName2 = await createPlainBoard(second.callTool);
    const good = await second.callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName2,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(second.callTool, { spaceName: spaceName2, anchor: 'b1' }),
          new_content: PLAIN_BOARD.replace('\u20ac1,646.91', '\u20ac1,590.00'),
        },
      ],
    });
    expect(isErrorResponse(good)).toBe(false);
  });

  it('delta failures are logged with the consecutive count', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(chunk.toString());
        callback();
      },
    });
    const logger: Logger = createLogger({
      format: format.json(),
      transports: [new transports.Stream({ stream })],
    });
    const { store, callTool } = makeHarness(logger);
    const spaceName = await createPlainBoard(callTool);
    const stored = await store.listSpacesWithAggregate({
      tenant_id: 'default',
      created_by: 'user-a',
      status: undefined,
      limit: 10,
    });
    const internalId = stored.records[0]?.id;

    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);
    await failedEdits(callTool, spaceName);

    const entries = lines
      .map(line => {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return null;
        }
      })
      .filter(
        (entry): entry is Record<string, unknown> => entry !== null && entry['message'] === 'space delta edit failed',
      );
    // Visible at failure #1, not discovered at #8.
    expect(entries.length).toBe(3);
    expect(entries[0]?.['consecutive_failures']).toBe(1);
    expect(entries[1]?.['consecutive_failures']).toBe(2);
    expect(entries[2]?.['consecutive_failures']).toBe(3);
    expect(entries[2]?.['delta_locked']).toBe(true);
    expect(entries[0]?.['space_id']).toBe(internalId);
  });
});

describe('Phase 2: semantic block anchors', () => {
  it('list_blocks returns anchors with 80-char previews without the body', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(isErrorResponse(listed)).toBe(false);
    const blocks = expectBlocks(listed);
    expect(blocks.map(b => b.anchor)).toEqual(['header', 'stats', 'table', 'notes']);
    for (const block of blocks) {
      expect(block.preview.length).toBeLessThanOrEqual(81);
      expect(block.occurrences).toBe(1);
    }
    expect(blocks[0]?.preview).toContain('Madrid Trip');
    // No body in the payload: the cheap recovery read stays cheap.
    expect(resultJson(listed).space).toBeUndefined();
  });

  it('edit_space block edits replace one block and echo per-block sizes', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const newStats = '<div class="grid-2"><div class="card"><h3>Outbound</h3><p>MOVED to Sep 23</p></div></div>';
    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'stats',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'stats' }),
          new_content: newStats,
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const parsed = resultJson(updated);
    // The newline immediately after the marker is layout, not content: it is preserved, so
    // the stored block content (and its echoed length) is the separator plus new_content.
    expect(parsed.block_results).toEqual([{ anchor: 'stats', new_length: newStats.length + 1, deleted: false }]);

    const body = await readBody(callTool, spaceName);
    expect(body).toContain('MOVED to Sep 23');
    // The marker stays on its own line: new_content is not glued to `-->`.
    expect(body).toContain(`<!-- @block:stats -->\n${newStats}`);
    // Everything else untouched, markers intact.
    expect(body).toContain('<!-- @block:header -->');
    expect(body).toContain('<!-- @block:table -->');
    expect(body).toContain('<!-- @block:notes -->');
    expect(body).toContain('\u20ac1,646.91');
    expect(body).toContain('Confirm Sep 23-24 extra night.');
  });

  it('an unknown anchor fails closed and lists the valid anchors', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'pricing', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    const parsed = resultJson(failed);
    expect(parsed.error).toContain('Unknown block anchor "pricing"');
    expect(parsed.error).toContain('"header"');
    expect(parsed.error).toContain('"notes"');
    expect(parsed.error).toContain('Nothing was persisted');

    expect(await readBody(callTool, spaceName)).toBe(ANCHORED_BOARD);
  });

  it('a duplicated anchor fails loudly instead of picking one silently', async () => {
    const { callTool } = makeHarness();
    const created = await callTool(CREATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      body: '<!-- @block:dup --><p>first</p><!-- @block:dup --><p>second</p>',
    });
    const spaceName = await expectSpaceName(created);

    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'dup', fingerprint: '00000000', new_content: '<p>winner</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    const parsed = resultJson(failed);
    expect(parsed.error).toContain('appears 2 times');
    expect(parsed.error).toContain('unique anchor');

    // list_blocks reports the duplication honestly.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(expectBlocks(listed)).toEqual([
      expect.objectContaining({ anchor: 'dup', preview: '<p>first</p>', occurrences: 2 }),
    ]);
  });

  it('a space with no markers gets structural blocks, stable for the body they segment', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);

    const first = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName }));
    expect(first).toHaveLength(1);
    expect(first[0]?.anchor).toBe('b1');
    expect(first[0]?.occurrences).toBe(1);
    expect(first[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);

    // The board is one run of lines with no blanks, so it stays one block, b1, after
    // the edit too: anchors are recomputed from the body each revision.
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: first[0]?.fingerprint ?? '',
          new_content: `${PLAIN_BOARD}\n<p>More.</p>`,
        },
      ],
    });
    const second = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName }));
    expect(second[0]?.anchor).toBe('b1');

    // An unknown anchor on the space fails closed and names the real one.
    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'nope', fingerprint: '00000000', new_content: 'x' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('"b1"');
  });

  it('empty new_content deletes the block, marker included', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'notes',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'notes' }),
          new_content: '',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(resultJson(updated).block_results).toEqual([{ anchor: 'notes', new_length: 0, deleted: true }]);

    const body = await readBody(callTool, spaceName);
    expect(body).not.toContain('@block:notes');
    expect(body).not.toContain('Confirm Sep 23-24 extra night.');
    expect(body).toContain('<!-- @block:table -->');

    const blocks = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName }));
    expect(blocks.map(b => b.anchor)).toEqual(['header', 'stats', 'table']);
  });

  it('new anchors inside new_content split the block', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const split = '<p>Before split.</p><!-- @block:stats-extra --><p>After split.</p>';
    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'stats',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'stats' }),
          new_content: split,
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);

    const blocks = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName }));
    expect(blocks.map(b => b.anchor)).toEqual(['header', 'stats', 'stats-extra', 'table', 'notes']);
    const extraFingerprint = blocks.find(b => b.anchor === 'stats-extra')?.fingerprint ?? '';

    // The new anchor is immediately addressable.
    const followUp = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'stats-extra', fingerprint: extraFingerprint, new_content: '<p>Edited.</p>' }],
    });
    expect(isErrorResponse(followUp)).toBe(false);
    expect(await readBody(callTool, spaceName)).toContain('<p>Edited.</p>');
  });

  it('edit_space block failures feed the breaker too', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const badAnchor = { type: 'block', anchor: 'nope', fingerprint: '00000000', new_content: 'x' };
    for (let i = 0; i < 3; i += 1) {
      const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: spaceName,
        expected_revision: 1,
        edits: [badAnchor],
      });
      expect(isErrorResponse(failed)).toBe(true);
    }
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'notes',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'notes' }),
          new_content: '<p>x</p>',
        },
      ],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
  });

  it('the shrink guard still refuses a block wipe without confirm_shrink', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);

    const wiped = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' }),
          new_content: '',
        },
      ],
    });
    expect(isErrorResponse(wiped)).toBe(true);
    expect(resultJson(wiped).error).toContain('confirm_shrink');
    expect(await readBody(callTool, spaceName)).toBe(PLAIN_BOARD);
  });

  it('the shrink guard still refuses a tiny replacement of the only block', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createPlainBoard(callTool);

    const wiped = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' }),
          new_content: '<p>oops</p>',
        },
      ],
    });
    expect(isErrorResponse(wiped)).toBe(true);
    expect(resultJson(wiped).error).toContain('confirm_shrink');
    expect(await readBody(callTool, spaceName)).toBe(PLAIN_BOARD);
  });

  it('edit_space rejects a full body field, and update_space is not a tool any more', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const editRejected = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      body: ANCHORED_BOARD,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: '00000000', new_content: 'x' }],
    });
    const editParsed = resultJson(editRejected);
    expect(isErrorResponse(editRejected)).toBe(true);
    expect(editParsed.error).toContain('Invalid space call');
    expect(editParsed.error).toContain('body');
    expect(editParsed.error).toContain('Fix the listed fields and send the call again.');

    // The old whole-body tool is gone: a call to it is refused as unknown.
    const retiredCall = await callTool(UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_name: spaceName,
      body: ANCHORED_BOARD,
    });
    expect(isErrorResponse(retiredCall)).toBe(true);
    expect(resultText(retiredCall)).toContain('Unknown tool: update_space');
  });

  it('edit_space accepts block and insert entries together in one list, against the one revision', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'notes',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'notes' }),
          new_content: '<p>Updated notes.</p>',
        },
        {
          type: 'insert',
          after: 'table',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'table' }),
          new_content: '<p>Inserted.</p>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const body = await readBody(callTool, spaceName);
    expect(body).toContain('Updated notes.');
    expect(body).toContain('Inserted.');
  });

  it('a reverted block edit restores the previous body', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'notes',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'notes' }),
          new_content: '<p>wrong notes</p>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, spaceName)).toContain('wrong notes');

    const reverted = await callTool(REVERT_SPACE_TOOL_NAME, { space_name: spaceName, revision: 1 });
    expect(isErrorResponse(reverted)).toBe(false);
    expect(await readBody(callTool, spaceName)).toBe(ANCHORED_BOARD);
  });
});

/** One failed edit_space block call (unknown anchor): feeds the breaker without touching the body. */
async function failedBlockEdits(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
): Promise<SpaceWireResult> {
  const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
    space_name: spaceName,
    expected_revision: 1,
    edits: [{ type: 'block', anchor: 'no-such-block', fingerprint: '00000000', new_content: '<p>x</p>' }],
  });
  expect(isErrorResponse(failed)).toBe(true);
  return resultJson(failed);
}

describe('fix-pass: reliability hardening', () => {
  it('markers inside fenced code blocks are documentation, not addressable blocks', async () => {
    const { callTool } = makeHarness();
    const body = [
      '# Section syntax',
      '',
      'Delimit sections like this:',
      '',
      '```html',
      '<!-- @block:prices -->',
      '<p>€10</p>',
      '```',
      '',
      '<!-- @block:real -->',
      '<p>Actual content</p>',
    ].join('\n');
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, format: 'markdown', body });
    expect(isErrorResponse(created)).toBe(false);
    const spaceName = await expectSpaceName(created);

    // The fenced sample is neither listed nor addressable; the real marker is.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(isErrorResponse(listed)).toBe(false);
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'prices', fingerprint: '00000000', new_content: '<p>hacked</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "prices"');

    // Editing the real block leaves the documented sample byte-identical: no silent
    // destruction of everything after a documentation marker.
    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'real',
          fingerprint: expectBlocks(listed).find(b => b.anchor === 'real')?.fingerprint ?? '',
          new_content: '<p>Edited.</p>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const finalBody = await readBody(callTool, spaceName);
    expect(finalBody).toContain('<!-- @block:prices -->\n<p>€10</p>');
    expect(finalBody).toContain('<!-- @block:real -->\n<p>Edited.</p>');
  });

  it('markers inside <pre> elements are documentation, not addressable blocks', async () => {
    const { callTool } = makeHarness();
    const body = ['<pre>', '<!-- @block:fake -->', 'sample code', '</pre>', '<!-- @block:real -->', '<p>hi</p>'].join(
      '\n',
    );
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceName = await expectSpaceName(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'fake', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "fake"');
    expect(await readBody(callTool, spaceName)).toBe(body);
  });

  it('list_blocks surfaces the preamble; it is not anchor-addressable and block edits leave it untouched', async () => {
    const { callTool } = makeHarness();
    const preambleText = '<p>Intro paragraph before any marker.</p>\n';
    const body = `${preambleText}<!-- @block:main -->\n<p>Body</p>`;
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceName = await expectSpaceName(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(isErrorResponse(listed)).toBe(false);
    const parsed = resultJson(listed);
    expect(parsed.preamble).toEqual({
      preview: expect.stringContaining('Intro paragraph before any marker.'),
      char_count: preambleText.length,
    });
    expect(parsed.blocks?.map(b => b.anchor)).toEqual(['main']);

    // No anchor addresses the preamble — not even a "preamble" anchor.
    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'preamble', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "preamble"');

    // A block edit touches only its block: the preamble survives byte-identical. It is
    // model-authored fixed framing; changing it means rebuilding the space's head,
    // which is deliberate, and the instruction says to keep it short and stable.
    const edited = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'main',
          fingerprint: expectBlocks(listed).find(b => b.anchor === 'main')?.fingerprint ?? '',
          new_content: '<p>Body, updated.</p>',
        },
      ],
    });
    expect(isErrorResponse(edited)).toBe(false);
    expect(await readBody(callTool, spaceName)).toBe(`${preambleText}<!-- @block:main -->\n<p>Body, updated.</p>`);
  });

  it('an unclosed marker with a near-limit whitespace run parses in linear time (no ReDoS)', async () => {
    const { store, callTool } = makeHarness();
    // The adversarial shape from the security review: an anchor name followed by ~65K
    // spaces with no closing `-->`. The old overlapping-quantifier pattern needed ~10-22s
    // per scan here (and edit_space re-parses up to 50 times); the disjoint pattern is linear.
    // Seeded directly in the store: one write may no longer carry a near-limit body (a
    // space this size is built in parts now); the subject is parsing the stored body.
    const body = `<!-- @block:real -->\n<p>ok</p>\n<!-- @block:prices${' '.repeat(65000)}`;
    await store.createSpace({
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'redos-space',
      name: BOARD_META.name,
      purpose: BOARD_META.purpose,
      status: BOARD_META.status,
      format: BOARD_META.format,
      body,
      expected_aggregate_revision: 0,
    });
    const spaceName = BOARD_META.name;

    const start = Date.now();
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    const elapsedMs = Date.now() - start;
    expect(isErrorResponse(listed)).toBe(false);
    // Only the complete marker parses; the unclosed one is not a block.
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);
    expect(elapsedMs).toBeLessThan(5000);
  });

  it('anchor names with internal spaces still parse (the ReDoS fix did not over-restrict)', async () => {
    const { callTool } = makeHarness();
    const body = '<!-- @block:my block -->\n<p>x</p>';
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceName = await expectSpaceName(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['my block']);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'my block',
          fingerprint: expectBlocks(listed).find(b => b.anchor === 'my block')?.fingerprint ?? '',
          new_content: '<p>y</p>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, spaceName)).toBe('<!-- @block:my block -->\n<p>y</p>');
  });

  it('a delta-computed body over the size limit feeds the breaker', async () => {
    const { store, callTool } = makeHarness();
    // Seeded directly in the store, just under the stored limit: one write may no longer
    // carry a near-limit body. Each edit below stays under the per-write cap, but the body
    // it computes crosses the stored limit, which is the failure that feeds the breaker.
    const seededBody = `${'x'.repeat(64_000)}\nTAIL`;
    await store.createSpace({
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'near-limit-space',
      name: BOARD_META.name,
      purpose: BOARD_META.purpose,
      status: BOARD_META.status,
      format: 'markdown',
      body: seededBody,
      expected_aggregate_revision: 0,
    });
    const spaceName = BOARD_META.name;

    // The seeded body is one run of lines, so one block, b1. An insert after it stays
    // under the per-write cap but computes a body over the stored limit.
    const wholeBodyFingerprint = await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'b1' });
    const tooLong = { type: 'insert', after: 'b1', fingerprint: wholeBodyFingerprint, new_content: 'y'.repeat(3_900) };
    for (let i = 0; i < 3; i += 1) {
      const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: spaceName,
        expected_revision: 1,
        edits: [tooLong],
      });
      expect(isErrorResponse(failed)).toBe(true);
      expect(resultJson(failed).error).toContain('exceeds the');
    }
    // Three over-limit deltas trip the lock like any other model-side delta failure.
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: wholeBodyFingerprint, new_content: '<p>small</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
    // The over-limit writes never persisted.
    expect(await readBody(callTool, spaceName)).toBe(seededBody);
  });

  it('a stale expected_revision feeds the breaker, as the brief settled: a named revision is the copy the model read', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);
    const notesFingerprint = await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'notes' });

    // Two genuine delta failures: counter at 2, not locked.
    await failedBlockEdits(callTool, spaceName);
    await failedBlockEdits(callTool, spaceName);

    // A call naming a revision the space has moved past: refused with the current one,
    // and it counts as the third failure: the model's copy diverged, which is exactly
    // what the breaker exists to stop a loop on.
    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 999,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: notesFingerprint, new_content: '<p>racy</p>' }],
    });
    expect(isErrorResponse(stale)).toBe(true);
    expect(resultJson(stale).error).toContain('Stale space revision');
    expect(await readBody(callTool, spaceName)).toBe(ANCHORED_BOARD);

    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: notesFingerprint, new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
  });

  it('a store-level revision race neither feeds nor resets the breaker', async () => {
    const { store, callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);
    const notesFingerprint = await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'notes' });

    // Two genuine delta failures: counter at 2, not locked.
    await failedBlockEdits(callTool, spaceName);
    await failedBlockEdits(callTool, spaceName);

    // Another writer lands between this edit's read at the CURRENT revision and its
    // fenced update: the store throws the conflict, and the breaker must not move,
    // that race is concurrency, not a divergent mental copy (unlike the stale named
    // revision above, which the model itself sent).
    const originalUpdate = store.updateSpace.bind(store);
    let armed = true;
    store.updateSpace = async input => {
      if (armed) {
        armed = false;
        throw new SpaceRevisionConflictError({
          id: input.space_id,
          expected_revision: input.expected_revision,
          actual_revision: 999,
        });
      }
      return originalUpdate(input);
    };
    const conflicted = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: notesFingerprint, new_content: '<p>racy</p>' }],
    });
    expect(isErrorResponse(conflicted)).toBe(true);
    expect(resultJson(conflicted).error).toContain('Stale space revision');
    expect(await readBody(callTool, spaceName)).toBe(ANCHORED_BOARD);

    // If the race had fed the breaker, this failure would be refused as locked; if it
    // had reset the breaker, the call after it would not lock. Exactly one more genuine
    // failure trips the lock, proving the counter sat untouched at 2 through the race.
    const third = await failedBlockEdits(callTool, spaceName);
    expect(third.error).not.toContain('locked');
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: notesFingerprint, new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
  });

  it('locked deltas are refused before any store read', async () => {
    const { store, callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    await failedBlockEdits(callTool, spaceName);
    await failedBlockEdits(callTool, spaceName);
    await failedBlockEdits(callTool, spaceName);

    let getSpaceCalls = 0;
    let listCalls = 0;
    const origGetSpace = store.getSpace.bind(store);
    const origList = store.listSpacesWithAggregate.bind(store);
    store.getSpace = async input => {
      getSpaceCalls += 1;
      return origGetSpace(input);
    };
    store.listSpacesWithAggregate = async input => {
      listCalls += 1;
      return origList(input);
    };

    // A locked delta must be cheap: the name lookup is the only store read, no
    // aggregate resolve and no body read before the refusal.
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
    expect(getSpaceCalls).toBe(0);
    expect(listCalls).toBe(1);
  });

  it('breaker entries are isolated per space and per tenant', async () => {
    const sharedSession = 'isolation-session-1';
    const harnessA = makeHarness(undefined, { sessionId: sharedSession, tenantId: 'ab', userRef: 'c' });
    const harnessB = makeHarness(undefined, { sessionId: sharedSession, tenantId: 'a', userRef: 'bc' });
    // Adversarial tenant/userRef split: 'ab'+'c' === 'a'+'bc' under naive concatenation.
    const spaceA = await createAnchoredBoard(harnessA.callTool);
    const spaceB = await createAnchoredBoard(harnessB.callTool);

    await failedBlockEdits(harnessA.callTool, spaceA);
    await failedBlockEdits(harnessA.callTool, spaceA);
    await failedBlockEdits(harnessA.callTool, spaceA);

    // Tenant A's space is locked…
    const lockedA = await harnessA.callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceA,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'notes', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(resultJson(lockedA).error).toContain('locked');

    // …but tenant B's space in the same session is unaffected.
    const okB = await harnessB.callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceB,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'notes',
          fingerprint: await fingerprintOf(harnessB.callTool, { spaceName: spaceB, anchor: 'notes' }),
          new_content: '<p>tenant B edit</p>',
        },
      ],
    });
    expect(isErrorResponse(okB)).toBe(false);
    expect(await readBody(harnessB.callTool, spaceB)).toContain('tenant B edit');
  });

  it('the duplicate-anchor error no longer lists the duplicated anchor as unique', async () => {
    const { callTool } = makeHarness();
    const body =
      '<!-- @block:alpha -->\n<p>one</p>\n<!-- @block:beta -->\n<p>two</p>\n<!-- @block:beta -->\n<p>three</p>';
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceName = await expectSpaceName(created);

    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'beta', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    const error = resultJson(failed).error ?? '';
    expect(error).toContain('appears 2 times');
    // Only the genuinely unique anchor is offered as an alternative.
    expect(error).toContain('Currently unique anchors: "alpha".');
    expect(await readBody(callTool, spaceName)).toBe(body);
  });

  it('over-long anchors are rejected by schema validation', async () => {
    const { callTool } = makeHarness();
    const spaceName = await createAnchoredBoard(callTool);

    const rejected = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: `a${'x'.repeat(300)}`, fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(rejected)).toBe(true);
    expect(resultJson(rejected).error).toBe(
      'Invalid space call: edits.0.anchor: is too long. Fix the listed fields and send the call again.',
    );
    expect(await readBody(callTool, spaceName)).toBe(ANCHORED_BOARD);
  });

  it('unclosed fences and pre elements mask to the end of the body (fail closed)', async () => {
    const { callTool } = makeHarness();
    const body = ['<!-- @block:real -->', '<p>ok</p>', '```', '<!-- @block:ghost -->', '<p>docs</p>'].join('\n');
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, format: 'markdown', body });
    const spaceName = await expectSpaceName(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'ghost', fingerprint: '00000000', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "ghost"');
    expect(await readBody(callTool, spaceName)).toBe(body);
  });
});

describe('fix-pass: documentation masking edge cases', () => {
  it('a <pre> tag inside a fenced block does not leak into the tag depth', async () => {
    const { callTool } = makeHarness();
    const body = [
      '```html',
      '<pre>',
      '<!-- @block:ghost -->',
      '</pre>',
      '```',
      '<!-- @block:real -->',
      '<p>hi</p>',
    ].join('\n');
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, format: 'markdown', body });
    const spaceName = await expectSpaceName(created);

    // The <pre> inside the fence is sample text, not an element: it must not mask the
    // real marker after the fence closes.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'real',
          fingerprint: expectBlocks(listed).find(b => b.anchor === 'real')?.fingerprint ?? '',
          new_content: '<p>edited</p>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, spaceName)).toContain('<!-- @block:real -->\n<p>edited</p>');
  });

  it('tilde fences mask documentation markers too', async () => {
    const { callTool } = makeHarness();
    const body = ['~~~', '<!-- @block:ghost -->', 'docs', '~~~', '<!-- @block:real -->', '<p>hi</p>'].join('\n');
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, format: 'markdown', body });
    const spaceName = await expectSpaceName(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);
  });
});

describe('fix-pass: large-body end-to-end journey', () => {
  it('a near-limit HTML board survives block edits byte-identically, then the breaker locks and reverting to the current revision recovers it whole', async () => {
    const { createHash } = await import('node:crypto');
    const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
    const { store, callTool } = makeHarness();

    // Near-limit HTML body (~60KB): preamble + anchored sections + a fenced doc sample.
    const section = (n: number) =>
      `<!-- @block:sec-${n} -->\n<div class="card"><h3>Section ${n}</h3><p>${'lorem ipsum dolor sit amet '.repeat(170)}</p></div>\n`;
    const tail = '```html\n<!-- @block:example -->\n<p>documented sample, not a block</p>\n```\n';
    const sections: string[] = [];
    let body = `<div class="page-header"><h1>Trip board</h1><p>intro preamble</p></div>\n`;
    while (body.length + tail.length < 62000) {
      const chunk = section(sections.length);
      if (body.length + chunk.length + tail.length >= 65536) {
        break;
      }
      sections.push(chunk);
      body += chunk;
    }
    body += tail;
    expect(body.length).toBeGreaterThan(60000);
    expect(body.length).toBeLessThan(65536);
    const sectionCount = sections.length;

    // Seeded directly in the store: one write may no longer carry a near-limit body (a
    // space this size is built in parts now); the subject is living with a stored one.
    await store.createSpace({
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'trip-board',
      name: BOARD_META.name,
      purpose: BOARD_META.purpose,
      status: BOARD_META.status,
      format: BOARD_META.format,
      body,
      expected_aggregate_revision: 0,
    });
    const spaceName = BOARD_META.name;

    // Compaction recovery: list_blocks without the body; the fenced sample is not a block.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
    expect(isErrorResponse(listed)).toBe(false);
    const parsed = expectBlocks(listed);
    expect(parsed.map(b => b.anchor)).toEqual(Array.from({ length: sectionCount }, (_, i) => `sec-${i}`));
    expect(parsed.some(b => b.anchor === 'example')).toBe(false);
    expect(expectPreamble(listed)).not.toBeNull();

    // Surgical block edit: every byte outside the edited block is preserved.
    const before = await readBody(callTool, spaceName);
    const sec5Fingerprint = parsed.find(b => b.anchor === 'sec-5')?.fingerprint ?? '';
    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'sec-5',
          fingerprint: sec5Fingerprint,
          new_content: '<div class="card"><h3>Section 5</h3><p>UPDATED</p></div>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const after = await readBody(callTool, spaceName);
    const fenceIdx = (s: string, marker: string) => s.indexOf(marker);
    expect(after.slice(0, fenceIdx(after, '<!-- @block:sec-5 -->'))).toBe(
      before.slice(0, fenceIdx(before, '<!-- @block:sec-5 -->')),
    );
    expect(after.slice(fenceIdx(after, '<!-- @block:sec-6 -->'))).toBe(
      before.slice(fenceIdx(before, '<!-- @block:sec-6 -->')),
    );
    expect(sha256(after)).not.toBe(sha256(before));

    // Burn loop: 3 missed deltas trip the breaker; the 4th is refused after the name
    // lookup alone, before any body read.
    const failing = () =>
      callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: spaceName,
        expected_revision: 2,
        edits: [{ type: 'block', anchor: 'no-such-block', fingerprint: '00000000', new_content: 'x' }],
      });
    expect(isErrorResponse(await failing())).toBe(true);
    expect(isErrorResponse(await failing())).toBe(true);
    expect(isErrorResponse(await failing())).toBe(true);
    let reads = 0;
    const origGetSpace = store.getSpace.bind(store);
    const origList = store.listSpacesWithAggregate.bind(store);
    store.getSpace = async input => {
      reads += 1;
      return origGetSpace(input);
    };
    store.listSpacesWithAggregate = async input => {
      reads += 1;
      return origList(input);
    };
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'no-such-block', fingerprint: '00000000', new_content: 'x' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
    // The only read the locked call pays is the name lookup: no body read follows it.
    expect(reads).toBe(1);

    // Recovery is the path the lock error teaches: revert_space to the CURRENT revision.
    // A full-body update cannot carry this body (one write is capped at 4,000 characters),
    // and the old fixture's small replacement body with confirm_shrink threw the board
    // away. Restoring the current revision clears the lock and keeps every byte.
    const current = resultJson(await callTool(GET_SPACE_TOOL_NAME, { space_name: spaceName })).space;
    expect(current?.revision).toBe(2);
    const bodyBeforeRecovery = await readBody(callTool, spaceName);
    const reverted = await callTool(REVERT_SPACE_TOOL_NAME, { space_name: spaceName, revision: 2 });
    expect(isErrorResponse(reverted)).toBe(false);
    expect(await readBody(callTool, spaceName)).toBe(bodyBeforeRecovery);
    expect(sha256(await readBody(callTool, spaceName))).toBe(sha256(bodyBeforeRecovery));

    // Unlocked: a block edit works again, on the whole board, nothing lost. The revert
    // made revision 3; sec-5's fingerprint is read fresh from the restored outline.
    const again = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: spaceName,
      expected_revision: 3,
      edits: [
        {
          type: 'block',
          anchor: 'sec-5',
          fingerprint: await fingerprintOf(callTool, { spaceName: spaceName, anchor: 'sec-5' }),
          new_content: '<p>again</p>',
        },
      ],
    });
    expect(isErrorResponse(again)).toBe(false);
    const recovered = await readBody(callTool, spaceName);
    expect(recovered.length).toBeGreaterThan(60000);
    expect(recovered).toContain('<p>again</p>');
    expect(recovered).toContain(`<!-- @block:sec-${String(sectionCount - 1)} -->`);
  });
});
