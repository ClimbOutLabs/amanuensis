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
import {
  CREATE_SPACE_TOOL_NAME,
  EDIT_SPACE_TOOL_NAME,
  GET_SPACE_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import {
  SpaceAggregateRevisionConflictError,
  SpaceRevisionConflictError,
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
import { SPACE_WRITE_MAX_LENGTH } from '../../../src/schemas/space';

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
  private aggregateRevision = 0;

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
    return { record: updated, aggregate_revision: this.aggregateRevision };
  }

  async revertSpace(_input: RevertSpaceInput): Promise<SpaceMutationResult> {
    throw new Error('not used in this test');
  }

  async getSpace(input: SpaceIdentityInput): Promise<SpaceRecord | undefined> {
    return this.spaces.get(input.space_id);
  }

  async getSpaceRevision(_input: GetSpaceRevisionInput): Promise<SpaceRecord | undefined> {
    return undefined;
  }

  async listSpacesWithAggregate(input: ListSpacesInput) {
    const records = [...this.spaces.values()].filter(
      record => input.status === undefined || record.status === input.status,
    );
    return { records, aggregate_revision: this.aggregateRevision, has_more: false, next_offset: null };
  }
}

interface SpaceWireResult {
  space?: { id: string; body: string };
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

/** The id of the one space in the store, from list_spaces: write results carry name and link, never an id. */
async function createdSpaceId(store: SpaceToolStore): Promise<string> {
  const listed = await callTool(store, LIST_SPACES_TOOL_NAME, {});
  const first = resultJson(listed).spaces?.[0];
  if (first === undefined) {
    throw new Error('expected a listed space');
  }
  return first.id;
}

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

  it('refuses an update whose body is past the cap and leaves the space unchanged', async () => {
    const store = new InMemorySpaceStore();
    const created = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Breeds',
      purpose: PURPOSE,
      status: 'active',
      body: tablePart(1, 5),
      format: 'markdown',
    });
    const spaceId = await createdSpaceId(store);
    const response = await callTool(store, UPDATE_SPACE_TOOL_NAME, {
      space_id: spaceId,
      name: 'Breeds',
      purpose: PURPOSE,
      status: 'active',
      body: 'y'.repeat(SPACE_WRITE_MAX_LENGTH + 1),
      format: 'markdown',
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing update_space');
    expect(error).toContain('one write may carry at most 4,000');
    expect(error).toContain('follow-up edit_space call');

    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
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
    const spaceId = await createdSpaceId(store);
    const half = 'z'.repeat(2_500);
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [
        { type: 'search', search: 'Breed 01', replace: half },
        { type: 'search', search: 'Breed 02', replace: half },
      ],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing edit_space');
    expect(error).toContain('one write may carry at most 4,000');

    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
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
    const spaceId = await createdSpaceId(store);
    // Search text is 3,000 characters and the replacement is 3,900: counted together they
    // would pass the cap, but only the replacement is new content, so the edit goes through.
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_id: spaceId,
      edits: [{ type: 'search', search: chunk, replace: 'c'.repeat(3_900) }],
    });
    expect(isErrorResponse(response)).toBe(false);
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
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
    const spaceId = await createdSpaceId(store);
    for (const [from, to] of [
      [11, 20],
      [21, 30],
      [31, 40],
    ] as const) {
      const lastRow = rowRange(from - 1, from - 1);
      const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_id: spaceId,
        edits: [{ type: 'search', search: lastRow, replace: `${lastRow}\n${rowRange(from, to)}` }],
      });
      expect(isErrorResponse(response)).toBe(false);
    }
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_id: spaceId });
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
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(UPDATE_SPACE_TOOL_NAME) ?? 0).toBeGreaterThan(framing);
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(EDIT_SPACE_TOOL_NAME) ?? 0).toBeGreaterThan(
      SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(CREATE_SPACE_TOOL_NAME) ?? 0,
    );
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.has(GET_SPACE_TOOL_NAME)).toBe(false);
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.has(LIST_SPACES_TOOL_NAME)).toBe(false);
  });
});
