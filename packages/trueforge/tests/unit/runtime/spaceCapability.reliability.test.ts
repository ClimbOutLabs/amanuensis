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
import { AUTO_BLOCK_ANCHOR, spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';

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
  aggregate_revision?: number;
  edit_replacements?: number[];
  block_results?: SpaceWireBlockResult[];
  preamble?: { preview: string; char_count: number } | null;
  blocks?: SpaceWireBlock[];
  space_id?: string;
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
  return expectSpaceId(created);
}

async function createPlainBoard(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
): Promise<string> {
  const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body: PLAIN_BOARD });
  return expectSpaceId(created);
}

async function readBody(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceId: string,
): Promise<string> {
  return expectBody(await callTool(GET_SPACE_TOOL_NAME, { space_id: spaceId }));
}

async function failedEdits(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceId: string,
): Promise<SpaceWireResult> {
  const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
    space_id: spaceId,
    edits: [{ search: 'this text is nowhere in the body', replace: 'x' }],
  });
  expect(isErrorResponse(failed)).toBe(true);
  const parsed = resultJson(failed);
  expect(parsed.error).toBeDefined();
  return parsed;
}

describe('Phase 1: consecutive-failure circuit breaker', () => {
  it('the miss error steers to full-body and never prescribes verbatim re-copy', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    const parsed = await failedEdits(callTool, spaceId);
    expect(parsed.error).toContain('Do not retry this search');
    expect(parsed.error).toContain('full updated body');
    expect(parsed.error).not.toContain('copy the search text verbatim');
    expect(parsed.error).not.toContain('Re-read the body with get_space and copy');
  });

  it('trips after 3 consecutive failures; the 4th delta call gets the terminal lock error', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);

    // Delta mode is now locked: even a would-be-good edit is refused.
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: '\u20ac1,646.91', replace: '\u20ac1,590.00' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    const parsed = resultJson(locked);
    expect(parsed.error).toContain('locked');
    expect(parsed.error).toContain('full updated body');

    // block_edits is delta mode too: locked as well.
    const lockedBlocks = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: AUTO_BLOCK_ANCHOR, new_content: 'x' }],
    });
    expect(isErrorResponse(lockedBlocks)).toBe(true);
    expect(resultJson(lockedBlocks).error).toContain('locked');

    // The refused calls persisted nothing.
    expect(await readBody(callTool, spaceId)).toBe(PLAIN_BOARD);
  });

  it('a success between failures resets the consecutive counter', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    // A successful delta resets the count.
    const good = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: '\u20ac1,646.91', replace: '\u20ac1,590.00' }],
    });
    expect(isErrorResponse(good)).toBe(false);

    // Two more failures are not enough to trip the breaker.
    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    const stillOpen = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: '\u20ac1,590.00', replace: '\u20ac1,500.00' }],
    });
    expect(isErrorResponse(stillOpen)).toBe(false);
    expect(await readBody(callTool, spaceId)).toContain('\u20ac1,500.00');
  });

  it('a successful full-body update unlocks delta mode', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    // Locked: sanity check.
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: 'a', replace: 'b' }],
    });
    expect(resultJson(locked).error).toContain('locked');

    // Full-body update succeeds and unlocks.
    const body = `${PLAIN_BOARD}\n<p>Extra line.</p>`;
    const full = await callTool(UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body,
    });
    expect(isErrorResponse(full)).toBe(false);

    const editsAgain = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: 'Extra line.', replace: 'Another line.' }],
    });
    expect(isErrorResponse(editsAgain)).toBe(false);
    expect(await readBody(callTool, spaceId)).toContain('Another line.');
  });

  it('revert_space unlocks delta mode', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);

    const reverted = await callTool(REVERT_SPACE_TOOL_NAME, { space_id: spaceId, revision: 1 });
    expect(isErrorResponse(reverted)).toBe(false);

    const editsAgain = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: '\u20ac1,646.91', replace: '\u20ac1,590.00' }],
    });
    expect(isErrorResponse(editsAgain)).toBe(false);
  });

  it('the breaker is scoped per session: another session is unaffected', async () => {
    const first = makeHarness();
    const spaceId = await createPlainBoard(first.callTool);
    await failedEdits(first.callTool, spaceId);
    await failedEdits(first.callTool, spaceId);
    await failedEdits(first.callTool, spaceId);

    // A different session (fresh harness, same store would be ideal, but the
    // breaker key includes the session id, so a new harness proves isolation).
    const second = makeHarness();
    const spaceId2 = await createPlainBoard(second.callTool);
    const good = await second.callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId2,
      edits: [{ search: '\u20ac1,646.91', replace: '\u20ac1,590.00' }],
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
    const { callTool } = makeHarness(logger);
    const spaceId = await createPlainBoard(callTool);

    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);
    await failedEdits(callTool, spaceId);

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
    expect(entries[0]?.['space_id']).toBe(spaceId);
  });
});

describe('Phase 2: semantic block anchors', () => {
  it('list_blocks returns anchors with 80-char previews without the body', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
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

  it('block_edits replaces one block and echoes per-block sizes', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const newStats = '<div class="grid-2"><div class="card"><h3>Outbound</h3><p>MOVED to Sep 23</p></div></div>';
    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'stats', new_content: newStats }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const parsed = resultJson(updated);
    // The newline immediately after the marker is layout, not content: it is preserved, so
    // the stored block content (and its echoed length) is the separator plus new_content.
    expect(parsed.block_results).toEqual([{ anchor: 'stats', new_length: newStats.length + 1, deleted: false }]);

    const body = await readBody(callTool, spaceId);
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
    const spaceId = await createAnchoredBoard(callTool);

    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'pricing', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    const parsed = resultJson(failed);
    expect(parsed.error).toContain('Unknown block anchor "pricing"');
    expect(parsed.error).toContain('"header"');
    expect(parsed.error).toContain('"notes"');
    expect(parsed.error).toContain('Nothing was persisted');

    expect(await readBody(callTool, spaceId)).toBe(ANCHORED_BOARD);
  });

  it('a duplicated anchor fails loudly instead of picking one silently', async () => {
    const { callTool } = makeHarness();
    const created = await callTool(CREATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      body: '<!-- @block:dup --><p>first</p><!-- @block:dup --><p>second</p>',
    });
    const spaceId = expectSpaceId(created);

    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'dup', new_content: '<p>winner</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    const parsed = resultJson(failed);
    expect(parsed.error).toContain('appears 2 times');
    expect(parsed.error).toContain('unique anchor');

    // list_blocks reports the duplication honestly.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(expectBlocks(listed)).toEqual([{ anchor: 'dup', preview: '<p>first</p>', occurrences: 2 }]);
  });

  it('an anchorless space gets the stable auto-body block', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    const first = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId }));
    expect(first).toHaveLength(1);
    expect(first[0]?.anchor).toBe(AUTO_BLOCK_ANCHOR);
    expect(first[0]?.occurrences).toBe(1);

    // The id is stable across edits and revisions: no persistence needed.
    await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: AUTO_BLOCK_ANCHOR, new_content: `${PLAIN_BOARD}\n<p>More.</p>` }],
    });
    const second = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId }));
    expect(second[0]?.anchor).toBe(AUTO_BLOCK_ANCHOR);

    // A non-auto anchor on an anchorless space fails closed.
    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'nope', new_content: 'x' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain(`"${AUTO_BLOCK_ANCHOR}"`);
  });

  it('empty new_content deletes the block, marker included', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'notes', new_content: '' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(resultJson(updated).block_results).toEqual([{ anchor: 'notes', new_length: 0, deleted: true }]);

    const body = await readBody(callTool, spaceId);
    expect(body).not.toContain('@block:notes');
    expect(body).not.toContain('Confirm Sep 23-24 extra night.');
    expect(body).toContain('<!-- @block:table -->');

    const blocks = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId }));
    expect(blocks.map(b => b.anchor)).toEqual(['header', 'stats', 'table']);
  });

  it('new anchors inside new_content split the block', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const split = '<p>Before split.</p><!-- @block:stats-extra --><p>After split.</p>';
    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'stats', new_content: split }],
    });
    expect(isErrorResponse(updated)).toBe(false);

    const blocks = expectBlocks(await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId }));
    expect(blocks.map(b => b.anchor)).toEqual(['header', 'stats', 'stats-extra', 'table', 'notes']);

    // The new anchor is immediately addressable.
    const followUp = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'stats-extra', new_content: '<p>Edited.</p>' }],
    });
    expect(isErrorResponse(followUp)).toBe(false);
    expect(await readBody(callTool, spaceId)).toContain('<p>Edited.</p>');
  });

  it('block_edits failures feed the breaker too', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const badAnchor = { anchor: 'nope', new_content: 'x' };
    for (let i = 0; i < 3; i += 1) {
      const failed = await callTool(UPDATE_SPACE_TOOL_NAME, { space_id: spaceId, block_edits: [badAnchor] });
      expect(isErrorResponse(failed)).toBe(true);
    }
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'notes', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
  });

  it('the shrink guard still refuses a block wipe without confirm_shrink', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    const wiped = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: AUTO_BLOCK_ANCHOR, new_content: '' }],
    });
    expect(isErrorResponse(wiped)).toBe(true);
    expect(resultJson(wiped).error).toContain('confirm_shrink');
    expect(await readBody(callTool, spaceId)).toBe(PLAIN_BOARD);
  });

  it('the shrink guard still refuses a tiny full-body update', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    const wiped = await callTool(UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body: '<p>oops</p>',
    });
    expect(isErrorResponse(wiped)).toBe(true);
    expect(resultJson(wiped).error).toContain('confirm_shrink');
    expect(await readBody(callTool, spaceId)).toBe(PLAIN_BOARD);
  });

  it('body and block_edits together are rejected by schema validation', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const rejected = await callTool(UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body: ANCHORED_BOARD,
      block_edits: [{ anchor: 'notes', new_content: 'x' }],
    });
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toContain('Invalid space call');
    expect(parsed.error).toContain('Provide exactly one of body');
  });

  it('edits and block_edits together are rejected by schema validation', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const rejected = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: 'a', replace: 'b' }],
      block_edits: [{ anchor: 'notes', new_content: 'x' }],
    });
    const parsed = resultJson(rejected);
    expect(isErrorResponse(rejected)).toBe(true);
    expect(parsed.error).toContain('Provide exactly one of body');
  });

  it('a reverted block edit restores the previous body', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'notes', new_content: '<p>wrong notes</p>' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, spaceId)).toContain('wrong notes');

    const reverted = await callTool(REVERT_SPACE_TOOL_NAME, { space_id: spaceId, revision: 1 });
    expect(isErrorResponse(reverted)).toBe(false);
    expect(await readBody(callTool, spaceId)).toBe(ANCHORED_BOARD);
  });
});

/** One failed block_edits call (unknown anchor): feeds the breaker without touching the body. */
async function failedBlockEdits(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceId: string,
): Promise<SpaceWireResult> {
  const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
    space_id: spaceId,
    block_edits: [{ anchor: 'no-such-block', new_content: '<p>x</p>' }],
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
    const spaceId = expectSpaceId(created);

    // The fenced sample is neither listed nor addressable; the real marker is.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(isErrorResponse(listed)).toBe(false);
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'prices', new_content: '<p>hacked</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "prices"');

    // Editing the real block leaves the documented sample byte-identical: no silent
    // destruction of everything after a documentation marker.
    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'real', new_content: '<p>Edited.</p>' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const finalBody = await readBody(callTool, spaceId);
    expect(finalBody).toContain('<!-- @block:prices -->\n<p>€10</p>');
    expect(finalBody).toContain('<!-- @block:real -->\n<p>Edited.</p>');
  });

  it('markers inside <pre> elements are documentation, not addressable blocks', async () => {
    const { callTool } = makeHarness();
    const body = ['<pre>', '<!-- @block:fake -->', 'sample code', '</pre>', '<!-- @block:real -->', '<p>hi</p>'].join(
      '\n',
    );
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceId = expectSpaceId(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'fake', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "fake"');
    expect(await readBody(callTool, spaceId)).toBe(body);
  });

  it('list_blocks surfaces the preamble; it is not anchor-addressable but a full-body update edits it', async () => {
    const { callTool } = makeHarness();
    const preambleText = '<p>Intro paragraph before any marker.</p>\n';
    const body = `${preambleText}<!-- @block:main -->\n<p>Body</p>`;
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceId = expectSpaceId(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(isErrorResponse(listed)).toBe(false);
    const parsed = resultJson(listed);
    expect(parsed.preamble).toEqual({
      preview: expect.stringContaining('Intro paragraph before any marker.'),
      char_count: preambleText.length,
    });
    expect(parsed.blocks?.map(b => b.anchor)).toEqual(['main']);

    // No anchor addresses the preamble — not even a "preamble" anchor.
    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'preamble', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "preamble"');

    // The recovery journey is complete anyway: a full-body update edits the preamble.
    const full = await callTool(UPDATE_SPACE_TOOL_NAME, {
      ...BOARD_META,
      space_id: spaceId,
      body: `<p>New intro.</p>\n<!-- @block:main -->\n<p>Body</p>`,
    });
    expect(isErrorResponse(full)).toBe(false);
    const finalBody = await readBody(callTool, spaceId);
    expect(finalBody).toContain('<p>New intro.</p>');
    expect(finalBody).not.toContain('Intro paragraph before any marker.');
  });

  it('an unclosed marker with a near-limit whitespace run parses in linear time (no ReDoS)', async () => {
    const { callTool } = makeHarness();
    // The adversarial shape from the security review: an anchor name followed by ~65K
    // spaces with no closing `-->`. The old overlapping-quantifier pattern needed ~10-22s
    // per scan here (and block_edits re-parses up to 50 times); the disjoint pattern is linear.
    const body = `<!-- @block:real -->\n<p>ok</p>\n<!-- @block:prices${' '.repeat(65000)}`;
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    expect(isErrorResponse(created)).toBe(false);
    const spaceId = expectSpaceId(created);

    const start = Date.now();
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
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
    const spaceId = expectSpaceId(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['my block']);

    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'my block', new_content: '<p>y</p>' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, spaceId)).toBe('<!-- @block:my block -->\n<p>y</p>');
  });

  it('a delta-computed body over the size limit feeds the breaker', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createPlainBoard(callTool);

    const tooLong = { anchor: 'auto-body', new_content: 'y'.repeat(70000) };
    for (let i = 0; i < 3; i += 1) {
      const failed = await callTool(UPDATE_SPACE_TOOL_NAME, { space_id: spaceId, block_edits: [tooLong] });
      expect(isErrorResponse(failed)).toBe(true);
      expect(resultJson(failed).error).toContain('exceeds the');
    }
    // Three over-limit deltas trip the lock like any other model-side delta failure.
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'auto-body', new_content: '<p>small</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
    // The over-limit writes never persisted.
    expect(await readBody(callTool, spaceId)).toBe(PLAIN_BOARD);
  });

  it('a revision conflict neither feeds nor resets the breaker', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    // Two genuine delta failures: counter at 2, not locked.
    await failedBlockEdits(callTool, spaceId);
    await failedBlockEdits(callTool, spaceId);

    // A delta that applies cleanly but loses the revision race: the store throws, and the
    // breaker must not move — a conflict is concurrency, not a divergent mental copy.
    const conflicted = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      expected_revision: 999,
      block_edits: [{ anchor: 'notes', new_content: '<p>racy</p>' }],
    });
    expect(isErrorResponse(conflicted)).toBe(true);
    expect(resultJson(conflicted).error).toContain('Stale space revision');
    expect(await readBody(callTool, spaceId)).toBe(ANCHORED_BOARD);

    // If the conflict had fed the breaker, this would already be refused as locked; if it
    // had reset the breaker, the call after this would not lock. Exactly one more genuine
    // failure trips the lock, proving the counter sat untouched at 2 through the conflict.
    const third = await failedBlockEdits(callTool, spaceId);
    expect(third.error).not.toContain('locked');
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'notes', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
  });

  it('locked deltas are refused before any store read', async () => {
    const { store, callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    await failedBlockEdits(callTool, spaceId);
    await failedBlockEdits(callTool, spaceId);
    await failedBlockEdits(callTool, spaceId);

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

    // A locked delta must be cheap: no aggregate resolve, no body read.
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'notes', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
    expect(getSpaceCalls).toBe(0);
    expect(listCalls).toBe(0);
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
    const lockedA = await harnessA.callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceA,
      block_edits: [{ anchor: 'notes', new_content: '<p>x</p>' }],
    });
    expect(resultJson(lockedA).error).toContain('locked');

    // …but tenant B's space in the same session is unaffected.
    const okB = await harnessB.callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceB,
      block_edits: [{ anchor: 'notes', new_content: '<p>tenant B edit</p>' }],
    });
    expect(isErrorResponse(okB)).toBe(false);
    expect(await readBody(harnessB.callTool, spaceB)).toContain('tenant B edit');
  });

  it('the duplicate-anchor error no longer lists the duplicated anchor as unique', async () => {
    const { callTool } = makeHarness();
    const body =
      '<!-- @block:alpha -->\n<p>one</p>\n<!-- @block:beta -->\n<p>two</p>\n<!-- @block:beta -->\n<p>three</p>';
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    const spaceId = expectSpaceId(created);

    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'beta', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    const error = resultJson(failed).error ?? '';
    expect(error).toContain('appears 2 times');
    // Only the genuinely unique anchor is offered as an alternative.
    expect(error).toContain('Currently unique anchors: "alpha".');
    expect(await readBody(callTool, spaceId)).toBe(body);
  });

  it('over-long anchors are rejected by schema validation', async () => {
    const { callTool } = makeHarness();
    const spaceId = await createAnchoredBoard(callTool);

    const rejected = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: `a${'x'.repeat(300)}`, new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(rejected)).toBe(true);
    expect(resultJson(rejected).error).toBe('Invalid space call: block_edits.0.anchor: is too long.');
    expect(await readBody(callTool, spaceId)).toBe(ANCHORED_BOARD);
  });

  it('unclosed fences and pre elements mask to the end of the body (fail closed)', async () => {
    const { callTool } = makeHarness();
    const body = ['<!-- @block:real -->', '<p>ok</p>', '```', '<!-- @block:ghost -->', '<p>docs</p>'].join('\n');
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, format: 'markdown', body });
    const spaceId = expectSpaceId(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const failed = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'ghost', new_content: '<p>x</p>' }],
    });
    expect(isErrorResponse(failed)).toBe(true);
    expect(resultJson(failed).error).toContain('Unknown block anchor "ghost"');
    expect(await readBody(callTool, spaceId)).toBe(body);
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
    const spaceId = expectSpaceId(created);

    // The <pre> inside the fence is sample text, not an element: it must not mask the
    // real marker after the fence closes.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);

    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'real', new_content: '<p>edited</p>' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, spaceId)).toContain('<!-- @block:real -->\n<p>edited</p>');
  });

  it('tilde fences mask documentation markers too', async () => {
    const { callTool } = makeHarness();
    const body = ['~~~', '<!-- @block:ghost -->', 'docs', '~~~', '<!-- @block:real -->', '<p>hi</p>'].join('\n');
    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, format: 'markdown', body });
    const spaceId = expectSpaceId(created);

    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(expectBlocks(listed).map(b => b.anchor)).toEqual(['real']);
  });
});

describe('fix-pass: large-body end-to-end journey', () => {
  it('a near-limit HTML board survives block edits byte-identically, then the breaker locks and a full-body update recovers', async () => {
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

    const created = await callTool(CREATE_SPACE_TOOL_NAME, { ...BOARD_META, body });
    expect(isErrorResponse(created)).toBe(false);
    const spaceId = expectSpaceId(created);

    // Compaction recovery: list_blocks without the body; the fenced sample is not a block.
    const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_id: spaceId });
    expect(isErrorResponse(listed)).toBe(false);
    const parsed = expectBlocks(listed);
    expect(parsed.map(b => b.anchor)).toEqual(Array.from({ length: sectionCount }, (_, i) => `sec-${i}`));
    expect(parsed.some(b => b.anchor === 'example')).toBe(false);
    expect(expectPreamble(listed)).not.toBeNull();

    // Surgical block edit: every byte outside the edited block is preserved.
    const before = await readBody(callTool, spaceId);
    const updated = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'sec-5', new_content: '<div class="card"><h3>Section 5</h3><p>UPDATED</p></div>' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const after = await readBody(callTool, spaceId);
    const fenceIdx = (s: string, marker: string) => s.indexOf(marker);
    expect(after.slice(0, fenceIdx(after, '<!-- @block:sec-5 -->'))).toBe(
      before.slice(0, fenceIdx(before, '<!-- @block:sec-5 -->')),
    );
    expect(after.slice(fenceIdx(after, '<!-- @block:sec-6 -->'))).toBe(
      before.slice(fenceIdx(before, '<!-- @block:sec-6 -->')),
    );
    expect(sha256(after)).not.toBe(sha256(before));

    // Burn loop: 3 missed deltas trip the breaker; the 4th is refused before any store read.
    const failing = () =>
      callTool(UPDATE_SPACE_TOOL_NAME, { space_id: spaceId, edits: [{ search: 'zz-no-such-text', replace: 'x' }] });
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
    const locked = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ search: 'zz-no-such-text', replace: 'x' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
    expect(reads).toBe(0);

    // Full-body recovery unlocks delta mode; a block edit works again.
    const full = await callTool(UPDATE_SPACE_TOOL_NAME, { ...BOARD_META, space_id: spaceId, body: after });
    expect(isErrorResponse(full)).toBe(false);
    const again = await callTool(UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      block_edits: [{ anchor: 'sec-5', new_content: '<p>again</p>' }],
    });
    expect(isErrorResponse(again)).toBe(false);
  });
});
