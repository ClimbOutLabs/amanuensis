/**
 * The per-write size cap on the space tools.
 *
 * Models stall while writing very long tool arguments, so one write carries at most
 * SPACE_WRITE_MAX_LENGTH characters of new content and a bigger space is built in parts.
 * These tests pin the cap at the tool layer: an over-cap write is refused with a plain
 * error that names the limit and the next step, nothing is persisted, and the parts flow
 * (a small create, then follow-up edits) builds a body well past the cap.
 */
import type {
  AgentExecutionTrace,
  AgentLocalToolTrace,
  AgentRemoteMcpToolTrace,
  AgentTracing,
  CallToolResponse,
} from '@truefoundry/trueforge-core/core';
import { createWebSearchTurnState, InstructionBuilder } from '@truefoundry/trueforge-core/core';
import { mapStreamToChunks } from '@truefoundry/trueforge-core/core/llm/VercelAILLM';
import {
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import {
  SpaceAggregateRevisionConflictError,
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
  SPACE_WRITE_TOOL_ARGUMENT_LIMITS,
  spaceCapability,
  type SpaceToolStore,
} from '../../../src/runtime/spaceCapability';
import { SPACE_BODY_MAX_LENGTH, SPACE_WRITE_MAX_LENGTH } from '../../../src/schemas/space';

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

/** A small stateful store: just enough of the production fencing for the tool layer to run. */
class InMemorySpaceStore implements SpaceToolStore {
  private spaces = new Map<string, SpaceRecord>();
  private history = new Map<string, SpaceRecord[]>();
  private aggregateRevision = 0;

  private pushHistory(record: SpaceRecord): void {
    const entries = this.history.get(record.id) ?? [];
    entries.push({ ...record });
    while (entries.length > 20) {
      entries.shift();
    }
    this.history.set(record.id, entries);
  }

  async createSpace(input: CreateSpaceInput): Promise<SpaceMutationResult> {
    if (input.expected_aggregate_revision !== this.aggregateRevision) {
      throw new SpaceAggregateRevisionConflictError({
        expected_revision: input.expected_aggregate_revision,
        actual_revision: this.aggregateRevision,
      });
    }
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
    this.pushHistory(record);
    return { record, aggregate_revision: this.aggregateRevision };
  }

  async updateSpace(input: UpdateSpaceInput): Promise<SpaceMutationResult> {
    const current = this.spaces.get(input.space_id);
    if (current === undefined || current.revision !== input.expected_revision) {
      throw new SpaceRevisionConflictError({
        id: input.space_id,
        expected_revision: input.expected_revision,
        actual_revision: current?.revision ?? 0,
      });
    }
    if (input.expected_aggregate_revision !== this.aggregateRevision) {
      throw new SpaceAggregateRevisionConflictError({
        expected_revision: input.expected_aggregate_revision,
        actual_revision: this.aggregateRevision,
      });
    }
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
    this.pushHistory(updated);
    return { record: updated, aggregate_revision: this.aggregateRevision };
  }

  async revertSpace(input: RevertSpaceInput): Promise<SpaceMutationResult> {
    const current = this.spaces.get(input.space_id);
    if (current === undefined || current.revision !== input.expected_revision) {
      throw new SpaceRevisionConflictError({
        id: input.space_id,
        expected_revision: input.expected_revision,
        actual_revision: current?.revision ?? 0,
      });
    }
    if (input.expected_aggregate_revision !== this.aggregateRevision) {
      throw new SpaceAggregateRevisionConflictError({
        expected_revision: input.expected_aggregate_revision,
        actual_revision: this.aggregateRevision,
      });
    }
    const target = this.history.get(input.space_id)?.find(record => record.revision === input.revision);
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
    this.pushHistory(reverted);
    return { record: reverted, aggregate_revision: this.aggregateRevision };
  }

  async getSpace(input: SpaceIdentityInput): Promise<SpaceRecord | undefined> {
    return this.spaces.get(input.space_id);
  }

  async getSpaceRevision(input: GetSpaceRevisionInput): Promise<SpaceRecord | undefined> {
    return this.history.get(input.space_id)?.find(record => record.revision === input.revision);
  }

  async listSpacesWithAggregate(input: ListSpacesInput) {
    const records = [...this.spaces.values()].filter(
      record => input.status === undefined || record.status === input.status,
    );
    return { records, aggregate_revision: this.aggregateRevision, has_more: false, next_offset: null };
  }
}

interface SpaceWireResult {
  space?: { id: string; body: string; revision?: number };
  spaces?: { id: string }[];
  error?: string;
}

function resultText(response: CallToolResponse): string {
  if (!('result' in response)) {
    throw new Error('expected space tool result');
  }
  const content = response.result.content[0];
  return content?.type === 'text' ? content.text : '';
}

function resultJson(response: CallToolResponse): SpaceWireResult {
  const parsed: SpaceWireResult = JSON.parse(resultText(response));
  return parsed;
}

function isErrorResponse(response: CallToolResponse): boolean {
  return 'result' in response && response.result.isError === true;
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

/** Tests address spaces by their exact names: tool results carry name and link, never an id. */
const PURPOSE = 'Track the dog breeds table.';

function rowRange(from: number, to: number): string {
  const rows: string[] = [];
  for (let index = from; index <= to; index += 1) {
    rows.push(
      `| Breed ${String(index).padStart(2, '0')} | Group ${String(index)} | A longer note about breed ${String(index)}, its temperament, size, and care needs in a family home |`,
    );
  }
  return rows.join('\n');
}

function tablePart(from: number, to: number): string {
  return from === 1
    ? `# Dog breeds\n\n| Breed | Group | Note |\n| --- | --- | --- |\n${rowRange(from, to)}`
    : rowRange(from, to);
}

describe('the space write size cap', () => {
  it('refuses a create whose body is past the cap, with the plain error, and persists nothing', async () => {
    const store = new InMemorySpaceStore();
    const body = 'x'.repeat(SPACE_WRITE_MAX_LENGTH + 1);
    const response = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Too big',
      purpose: PURPOSE,
      status: 'active',
      body,
      format: 'markdown',
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing create_space');
    expect(error).toContain('one write may carry at most 4,000');
    expect(error).toContain('Nothing was persisted');
    expect(error).toContain('add the rest with edit_space');

    const listed = await callTool(store, LIST_SPACES_TOOL_NAME, {});
    expect(resultJson(listed).spaces).toHaveLength(0);
  });

  it('accepts a create whose body is exactly at the cap', async () => {
    const store = new InMemorySpaceStore();
    const response = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Just fits',
      purpose: PURPOSE,
      status: 'active',
      body: 'x'.repeat(SPACE_WRITE_MAX_LENGTH),
      format: 'markdown',
    });
    expect(isErrorResponse(response)).toBe(false);
    expect(resultJson(response).space?.body).toHaveLength(SPACE_WRITE_MAX_LENGTH);
  });

  it('refuses one edit entry whose new content is past the cap and leaves the space unchanged', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Breeds',
      purpose: PURPOSE,
      status: 'active',
      body: tablePart(1, 5),
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      edits: [{ type: 'block', anchor: 'auto-body', new_content: 'y'.repeat(SPACE_WRITE_MAX_LENGTH + 1) }],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing edit_space');
    expect(error).toContain('one write may carry at most 4,000');
    expect(error).toContain('follow-up edit_space call');

    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Breeds' });
    expect(resultJson(read).space?.body).toBe(tablePart(1, 5));
  });

  it('refuses an edit whose new content adds up past the cap, counting every entry', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Breeds',
      purpose: PURPOSE,
      status: 'active',
      body: tablePart(1, 5),
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);
    const half = 'z'.repeat(2_500);
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      edits: [
        { type: 'search', search: 'Breed 01', replace: half },
        { type: 'search', search: 'Breed 02', replace: half },
      ],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing edit_space');
    expect(error).toContain('one write may carry at most 4,000');

    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Breeds' });
    expect(resultJson(read).space?.body).toBe(tablePart(1, 5));
  });

  it('does not count the search text toward the cap: it is copied from the body, not new content', async () => {
    const store = new InMemorySpaceStore();
    // A body just under the cap, so a long search string is available to copy.
    const chunk = 'a'.repeat(3_000);
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Long text',
      purpose: PURPOSE,
      status: 'active',
      body: `${chunk}\n${'b'.repeat(900)}`,
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);
    // Search text is 3,000 characters and the replacement is 3,900: counted together they
    // would pass the cap, but only the replacement is new content, so the edit goes through.
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Long text',
      edits: [{ type: 'search', search: chunk, replace: 'c'.repeat(3_900) }],
    });
    expect(isErrorResponse(response)).toBe(false);
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Long text' });
    expect(resultJson(read).space?.body).toBe(`${'c'.repeat(3_900)}\n${'b'.repeat(900)}`);
  });

  it('builds a 40-row table in parts: a small create, then follow-up edits past the cap in total', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Dog breeds',
      purpose: PURPOSE,
      status: 'active',
      body: tablePart(1, 10),
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);
    for (const [from, to] of [
      [11, 20],
      [21, 30],
      [31, 40],
    ] as const) {
      const lastRow = rowRange(from - 1, from - 1);
      const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        edits: [{ type: 'search', search: lastRow, replace: `${lastRow}\n${rowRange(from, to)}` }],
      });
      expect(isErrorResponse(response)).toBe(false);
    }
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const body = resultJson(read).space?.body ?? '';
    expect(body.length).toBeGreaterThan(SPACE_WRITE_MAX_LENGTH);
    const breedRows = body.split('\n').filter(line => /^\| Breed \d/.test(line));
    expect(breedRows).toHaveLength(40);
    expect(breedRows[0]).toContain('Breed 01');
    expect(breedRows[39]).toContain('Breed 40');
  });

  it('tells the model the cap and the parts flow in the instructions', () => {
    const capability = spaceCapability({
      store: new InMemorySpaceStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const builder = InstructionBuilder.createSystemPrompt('test');
    const firstBuilder = capability.instructionBuilders?.[0];
    if (firstBuilder === undefined) {
      throw new Error('expected the space instruction builder');
    }
    firstBuilder(builder);
    const rendered = builder.build();
    expect(rendered).toContain('one write carries at most about 4,000 characters of new content');
    expect(rendered).toContain('add the rest a few rows at a time');
  });

  it('sets a streamed-argument limit for each write tool, above every valid call', () => {
    // A valid call's arguments hold the new content plus the longest name and purpose and
    // the JSON framing; the limit must clear that with room to spare, or it would cut
    // calls the tool layer accepts.
    const framing = SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 500;
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(CREATE_SPACE_TOOL_NAME) ?? 0).toBeGreaterThan(framing);
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(EDIT_SPACE_TOOL_NAME) ?? 0).toBeGreaterThan(
      SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(CREATE_SPACE_TOOL_NAME) ?? 0,
    );
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.has(UPDATE_SPACE_TOOL_NAME)).toBe(false);
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.has(GET_SPACE_TOOL_NAME)).toBe(false);
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.has(LIST_SPACES_TOOL_NAME)).toBe(false);
  });

  it('derives the streamed limits from the worst valid call, escaping included', () => {
    // The arithmetic written beside the constants in spaceCapability.ts: every string
    // field at six times its source length (a character can stream as a six-character
    // escape), plus one flat framing allowance. Create carries one body at the write
    // cap, a 2,000 purpose, a 160 name, a 160 lookup, and the two short enums.
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(CREATE_SPACE_TOOL_NAME)).toBe(
      6 * (SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) + 2_000,
    );
    // Edit carries up to 50 entries; a search is copied from the stored body, so 50
    // searches at the body's own limit dominate, with 50 anchors at 200 counted as well.
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(EDIT_SPACE_TOOL_NAME)).toBe(
      6 * (50 * SPACE_BODY_MAX_LENGTH + 50 * 200 + SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) + 3_000,
    );
  });
});

/** One part of a streamed tool call, as the model server sends it. */
type SpaceStreamPart =
  Parameters<typeof mapStreamToChunks>[0]['stream'] extends AsyncIterable<infer Part> ? Part : never;

async function* streamParts(parts: readonly SpaceStreamPart[]): AsyncGenerator<SpaceStreamPart> {
  for (const part of parts) {
    yield part;
  }
}

/** Runs streamed parts through the real stream mapper with the real limits and returns its result. */
async function drainParts(parts: readonly SpaceStreamPart[]) {
  const gen = mapStreamToChunks({
    stream: streamParts(parts),
    chunkMeta: { id: 'stream-pin', created: 0, model: 'test-model' },
    toolArgumentLimits: SPACE_WRITE_TOOL_ARGUMENT_LIMITS,
  });
  let result = await gen.next();
  while (!result.done) {
    result = await gen.next();
  }
  return result.value;
}

/** The parts of one tool call whose JSON arguments arrive in chunks, the way a model streams them. */
function toolCallParts(toolName: string, argsJson: string, chunkSize = 9_973): SpaceStreamPart[] {
  const parts: SpaceStreamPart[] = [{ type: 'tool-input-start', id: 'call-1', toolName }];
  for (let offset = 0; offset < argsJson.length; offset += chunkSize) {
    parts.push({ type: 'tool-input-delta', id: 'call-1', delta: argsJson.slice(offset, offset + chunkSize) });
  }
  parts.push({ type: 'tool-input-end', id: 'call-1' });
  return parts;
}

describe('the streamed-argument limits against real streams', () => {
  it('does not cut an escape-heavy create that the tool layer accepts', async () => {
    // Every character of the body, purpose, and name is a control character, so each one
    // streams as a six-character escape: the harshest valid call there is. Its streamed
    // length passes the old flat limit of three times the write cap many times over.
    const createArgs = JSON.stringify({
      name: 'N'.repeat(160),
      purpose: '\u0001'.repeat(2_000),
      status: 'active',
      body: '\u0001'.repeat(SPACE_WRITE_MAX_LENGTH),
      format: 'markdown',
    });
    expect(createArgs.length).toBeGreaterThan(SPACE_WRITE_MAX_LENGTH * 3);
    const created = await drainParts(toolCallParts(CREATE_SPACE_TOOL_NAME, createArgs));
    expect(created.size_cut_tool_calls).toBeUndefined();
    expect(created.output.tool_calls?.[0]?.function.arguments).toBe(createArgs);
  });

  it('does not cut a valid edit whose search text is long, even a whole stored body', async () => {
    const search30k = JSON.stringify({
      space_name: 'Dog breeds',
      edits: [{ type: 'search', search: 's'.repeat(30_000), replace: 'done' }],
    });
    expect(search30k.length).toBeGreaterThan(24_000);
    const edited = await drainParts(toolCallParts(EDIT_SPACE_TOOL_NAME, search30k));
    expect(edited.size_cut_tool_calls).toBeUndefined();
    expect(edited.output.tool_calls?.[0]?.function.arguments).toBe(search30k);

    const wholeBody = JSON.stringify({
      space_name: 'Dog breeds',
      edits: [{ type: 'search', search: 's'.repeat(SPACE_BODY_MAX_LENGTH), replace: 'done' }],
    });
    const whole = await drainParts(toolCallParts(EDIT_SPACE_TOOL_NAME, wholeBody));
    expect(whole.size_cut_tool_calls).toBeUndefined();
  });

  it('cuts a call that streams past its derived limit, for each write tool', async () => {
    const createLimit = SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(CREATE_SPACE_TOOL_NAME) ?? 0;
    const overCreate = `{"body":"${'x'.repeat(createLimit)}"}`;
    const cutCreate = await drainParts(toolCallParts(CREATE_SPACE_TOOL_NAME, overCreate));
    expect(cutCreate.size_cut_tool_calls).toEqual(['call-1']);

    // One single delta past the edit limit: the cut lands on the accumulated length.
    const editLimit = SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(EDIT_SPACE_TOOL_NAME) ?? 0;
    const overEdit = `{"edits":[{"type":"search","search":"${'x'.repeat(editLimit)}","replace":""}]}`;
    const cutEdit = await drainParts(toolCallParts(EDIT_SPACE_TOOL_NAME, overEdit, overEdit.length));
    expect(cutEdit.size_cut_tool_calls).toEqual(['call-1']);
  });
});

/**
 * One capability reused across calls, with a session id: the delta breaker is keyed per
 * session and survives turn boundaries, so the recovery journey needs the same shape
 * production has.
 */
function makeSessionCallTool(store: SpaceToolStore, sessionId: string) {
  const capability = spaceCapability({
    store,
    authority: { tenantId: 'default', userRef: 'user-a' },
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
    sessionId,
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  return (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });
}

let recoverySessionCounter = 0;

describe('recovering a space past the write cap, end to end', () => {
  it('a missed edit, a lockout, and a rename all recover in parts without losing content', async () => {
    const store = new InMemorySpaceStore();
    recoverySessionCounter += 1;
    const call = makeSessionCallTool(store, `write-size-recovery-${String(recoverySessionCounter)}`);

    // Build the 40-row table in parts, the flow the cap prescribes: the finished body is
    // well past one write's 4,000 characters.
    const created = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Dog breeds',
      purpose: PURPOSE,
      status: 'active',
      body: tablePart(1, 10),
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);
    for (const [from, to] of [
      [11, 20],
      [21, 30],
      [31, 40],
    ] as const) {
      const lastRow = rowRange(from - 1, from - 1);
      const extended = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        edits: [{ type: 'search', search: lastRow, replace: `${lastRow}\n${rowRange(from, to)}` }],
      });
      expect(isErrorResponse(extended)).toBe(false);
    }
    const built = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const builtBody = resultJson(built).space?.body ?? '';
    expect(builtBody.length).toBeGreaterThan(SPACE_WRITE_MAX_LENGTH);

    // A missed search: the error teaches the parts recovery, and following it works.
    const missed = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      edits: [{ type: 'search', search: 'Breed 99', replace: 'x' }],
    });
    expect(isErrorResponse(missed)).toBe(true);
    const missError = resultJson(missed).error ?? '';
    expect(missError).toContain('Re-read the space with get_space');
    expect(missError).toContain('make the change with edit_space in parts');
    const lastRow = rowRange(40, 40);
    const appended = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      edits: [
        { type: 'search', search: lastRow, replace: `${lastRow}\n| Breed 41 | Group 5 | Added after the miss |` },
      ],
    });
    expect(isErrorResponse(appended)).toBe(false);

    // Three more misses lock delta mode. The taught unlock is revert_space to the current
    // revision: the body survives byte for byte, and edits work again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        edits: [{ type: 'search', search: 'no such text', replace: 'x' }],
      });
      expect(isErrorResponse(failed)).toBe(true);
    }
    const locked = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      edits: [{ type: 'search', search: 'Breed 41', replace: 'Breed 41' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error ?? '').toContain("call revert_space with the space's current revision");

    const beforeRevert = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const bodyBeforeRevert = resultJson(beforeRevert).space?.body ?? '';
    const currentRevision = resultJson(beforeRevert).space?.revision ?? 0;
    expect(currentRevision).toBeGreaterThan(1);
    const reverted = await call(REVERT_SPACE_TOOL_NAME, { space_name: 'Dog breeds', revision: currentRevision });
    expect(isErrorResponse(reverted)).toBe(false);
    const afterRevert = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    expect(resultJson(afterRevert).space?.body).toBe(bodyBeforeRevert);

    const editsAgain = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      edits: [{ type: 'search', search: 'Breed 41', replace: 'Breed 41 (recovered)' }],
    });
    expect(isErrorResponse(editsAgain)).toBe(false);
    const finalRead = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const finalBody = resultJson(finalRead).space?.body ?? '';
    expect(finalBody).toContain('Breed 41 (recovered)');
    expect(finalBody.split('\n').filter(line => /^\| Breed \d/.test(line))).toHaveLength(41);
  });

  it('a duplicated anchor is renamed with a search edit, as its error teaches', async () => {
    const store = new InMemorySpaceStore();
    recoverySessionCounter += 1;
    const call = makeSessionCallTool(store, `write-size-recovery-${String(recoverySessionCounter)}`);
    const body = '<!-- @block:dup -->\n<p>first</p>\n<!-- @block:dup -->\n<p>second</p>';
    const created = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Duplicates',
      purpose: PURPOSE,
      status: 'active',
      body,
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);

    const blocked = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      edits: [{ type: 'block', anchor: 'dup', new_content: '<p>winner</p>' }],
    });
    expect(isErrorResponse(blocked)).toBe(true);
    const dupError = resultJson(blocked).error ?? '';
    expect(dupError).toContain('Rename all but one of the duplicates');
    expect(dupError).toContain('matches only that one copy');

    // The taught rename: the marker plus the text right after it matches only one copy.
    const renamed = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      edits: [
        {
          type: 'search',
          search: '<!-- @block:dup -->\n<p>second</p>',
          replace: '<!-- @block:dup-two -->\n<p>second</p>',
        },
      ],
    });
    expect(isErrorResponse(renamed)).toBe(false);

    const firstEdit = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      edits: [{ type: 'block', anchor: 'dup', new_content: '<p>first updated</p>' }],
    });
    expect(isErrorResponse(firstEdit)).toBe(false);
    const secondEdit = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      edits: [{ type: 'block', anchor: 'dup-two', new_content: '<p>second updated</p>' }],
    });
    expect(isErrorResponse(secondEdit)).toBe(false);
    const read = await call(GET_SPACE_TOOL_NAME, { space_name: 'Duplicates' });
    expect(resultJson(read).space?.body).toContain('<p>first updated</p>');
    expect(resultJson(read).space?.body).toContain('<p>second updated</p>');
  });
});
