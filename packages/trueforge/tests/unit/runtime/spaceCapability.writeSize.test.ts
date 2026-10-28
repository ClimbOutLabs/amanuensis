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
  LIST_BLOCKS_TOOL_NAME,
  LIST_SPACES_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
  SPACE_WRITE_TOO_LONG_ERROR_CODE,
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
  blocks?: { anchor: string; fingerprint: string; preview?: string }[];
  error?: string;
  error_code?: string;
  summary?: string;
  unsaved_lines?: number;
  unsaved_from?: string;
  continue_after?: { anchor: string; fingerprint: string } | null;
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

/** The last block of the named space, from its list_blocks outline, the way a model reads it. */
async function lastBlockOf(
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
): Promise<{ anchor: string; fingerprint: string }> {
  const listed = await call(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
  const blocks = resultJson(listed).blocks ?? [];
  const last = blocks[blocks.length - 1];
  if (last === undefined) {
    throw new Error(`expected at least one block in ${spaceName}`);
  }
  return last;
}

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
    expect(error).toContain('one write may carry at most 3,600');
    expect(error).toContain('Nothing was persisted');
    expect(error).toContain('add the rest with edit_space');
    // The refusal text is pinned word for word: it is what the model reads and it must not
    // drift. The stable code beside it is what the chat keys its plain note on.
    expect(error).toBe(
      'Refusing create_space: this write carries 4,001 characters of new content, and one write may carry at most 3,600. ' +
        'Nothing was persisted. Send a shorter body now (a heading and the first part), then add the rest with edit_space once the space exists.',
    );
    expect(resultJson(response).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);

    const listed = await callTool(store, LIST_SPACES_TOOL_NAME, {});
    expect(resultJson(listed).spaces).toHaveLength(0);
  });

  it('accepts a create past the told number, under the real cap', async () => {
    const store = new InMemorySpaceStore();
    const response = await callTool(store, CREATE_SPACE_TOOL_NAME, {
      name: 'Past the told number',
      purpose: PURPOSE,
      status: 'active',
      body: 'x'.repeat(3_900),
      format: 'markdown',
    });
    expect(isErrorResponse(response)).toBe(false);
    expect(resultJson(response).space?.body).toHaveLength(3_900);
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
    // The body segments into the heading (b1) and the table group (b2).
    const table = await lastBlockOf((name, args) => callTool(store, name, args), 'Breeds');
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: table.anchor,
          fingerprint: table.fingerprint,
          new_content: 'y'.repeat(SPACE_WRITE_MAX_LENGTH + 1),
        },
      ],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing edit_space');
    expect(error).toContain('one write may carry at most 3,600');
    expect(error).toContain('follow-up edit_space call');
    expect(resultJson(response).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);

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
    const call = (name: string, args: Record<string, unknown>) => callTool(store, name, args);
    const listed = await call(LIST_BLOCKS_TOOL_NAME, { space_name: 'Breeds' });
    const blocks = resultJson(listed).blocks ?? [];
    const half = 'z'.repeat(2_500);
    const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: blocks[0]?.fingerprint ?? '', new_content: half },
        { type: 'block', anchor: 'b2', fingerprint: blocks[1]?.fingerprint ?? '', new_content: half },
      ],
    });
    expect(isErrorResponse(response)).toBe(true);
    const error = resultJson(response).error ?? '';
    expect(error).toContain('Refusing edit_space');
    expect(error).toContain('one write may carry at most 3,600');

    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Breeds' });
    expect(resultJson(read).space?.body).toBe(tablePart(1, 5));
  });

  describe('saving what fits', () => {
    const createInput = (body: string, format: 'markdown' | 'html' = 'markdown') => ({
      name: 'Dog breeds',
      purpose: PURPOSE,
      status: 'active',
      body,
      format,
    });

    it('saves the leading rows of a 60-row create and says where to continue', async () => {
      const store = new InMemorySpaceStore();
      const body = tablePart(1, 60);
      const response = await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(body));
      expect(isErrorResponse(response)).toBe(false);
      const parsed = resultJson(response);
      const saved = parsed.space?.body ?? '';
      expect(saved.length).toBeLessThanOrEqual(3_600);
      expect(body.startsWith(saved)).toBe(true);
      const savedRows = saved.split('\n').filter(line => /^\| Breed \d/.test(line)).length;
      expect(savedRows).toBeGreaterThan(10);
      expect(savedRows).toBeLessThan(60);
      const next = String(savedRows + 1).padStart(2, '0');
      expect(parsed.unsaved_from).toBe(
        body
          .split('\n')
          .find(line => line.startsWith(`| Breed ${next} `))
          ?.slice(0, 80),
      );
      expect(parsed.unsaved_lines).toBe(60 - savedRows);
      expect(parsed.summary).toContain('with the first');
      expect(parsed.summary).toContain('were not saved');
      expect(parsed.summary).toContain('Do not resend the saved lines.');
      expect(parsed.continue_after?.anchor).toBe(parsed.blocks?.[parsed.blocks.length - 1]?.anchor);
    });

    it('returns the block outline from a plain create', async () => {
      const store = new InMemorySpaceStore();
      const response = await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(tablePart(1, 5)));
      const parsed = resultJson(response);
      expect(parsed.blocks?.length).toBe(2);
      expect(parsed.blocks?.[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
      expect(parsed.unsaved_from).toBeUndefined();
    });

    it('saves a prefix of an over-size single insert', async () => {
      const store = new InMemorySpaceStore();
      await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(tablePart(1, 5)));
      const last = await lastBlockOf((name, args) => callTool(store, name, args), 'Dog breeds');
      const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [{ type: 'insert', after: last.anchor, fingerprint: last.fingerprint, new_content: rowRange(6, 60) }],
      });
      expect(isErrorResponse(response)).toBe(false);
      const parsed = resultJson(response);
      expect(parsed.summary).toContain('were not saved');
      expect(parsed.unsaved_lines).toBeGreaterThan(0);
      const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
      const body = resultJson(read).space?.body ?? '';
      expect(body.startsWith(tablePart(1, 5))).toBe(true);
      expect(body).not.toContain('Breed 60');
      expect(body.split('\n').filter(line => /^\| Breed \d/.test(line)).length).toBe(60 - (parsed.unsaved_lines ?? 0));
    });

    it('saves a prefix into a placeholder block but not over real content', async () => {
      const store = new InMemorySpaceStore();
      await callTool(store, CREATE_SPACE_TOOL_NAME, createInput('# Title\n\nplaceholder'));
      const blocks =
        resultJson(await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: 'Dog breeds' })).blocks ?? [];
      const placeholder = blocks[1];
      const saved = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [
          {
            type: 'block',
            anchor: placeholder?.anchor,
            fingerprint: placeholder?.fingerprint,
            new_content: rowRange(1, 60),
          },
        ],
      });
      expect(isErrorResponse(saved)).toBe(false);
      expect(resultJson(saved).unsaved_lines).toBeGreaterThan(0);

      const filled = await callTool(store, CREATE_SPACE_TOOL_NAME, { ...createInput(tablePart(1, 5)), name: 'Real' });
      const real = (resultJson(filled).blocks ?? [])[1];
      const refused = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Real',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: real?.anchor, fingerprint: real?.fingerprint, new_content: rowRange(1, 60) }],
      });
      expect(isErrorResponse(refused)).toBe(true);
      expect(resultJson(refused).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);
    });

    it('says where to insert when the saved rows end mid-body, not after the last block', async () => {
      const store = new InMemorySpaceStore();
      const body = `${tablePart(1, 5)}\n\n## Notes\n\nClosing paragraph.`;
      await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(body));
      const outline =
        resultJson(await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: 'Dog breeds' })).blocks ?? [];
      const table = outline[1];
      const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [
          { type: 'insert', after: table?.anchor, fingerprint: table?.fingerprint, new_content: rowRange(6, 60) },
        ],
      });
      expect(isErrorResponse(response)).toBe(false);
      const parsed = resultJson(response);
      const blocks = parsed.blocks ?? [];
      const index = blocks.findIndex(block => block.anchor === parsed.continue_after?.anchor);
      expect(index).toBeGreaterThan(0);
      expect(blocks[index]?.fingerprint).toBe(parsed.continue_after?.fingerprint);
      expect(blocks[index]?.preview).toMatch(/^\| Breed/);
      expect(blocks[index + 1]?.preview).toBe('## Notes');
      expect(parsed.summary).toContain(`Insert them after block ${parsed.continue_after?.anchor ?? ''} next.`);
      expect(parsed.summary).not.toContain('Append them next.');
    });

    it('says to append when the saved rows end the body', async () => {
      const store = new InMemorySpaceStore();
      await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(tablePart(1, 5)));
      const last = await lastBlockOf((name, args) => callTool(store, name, args), 'Dog breeds');
      const parsed = resultJson(
        await callTool(store, EDIT_SPACE_TOOL_NAME, {
          space_name: 'Dog breeds',
          expected_revision: 1,
          edits: [{ type: 'insert', after: last.anchor, fingerprint: last.fingerprint, new_content: rowRange(6, 60) }],
        }),
      );
      expect(parsed.summary).toContain('Append them next.');
    });

    it('points at the placeholder block that was filled when it is not the last block', async () => {
      const store = new InMemorySpaceStore();
      await callTool(store, CREATE_SPACE_TOOL_NAME, createInput('# Title\n\nplaceholder\n\n## End\n\nClosing.'));
      const outline =
        resultJson(await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: 'Dog breeds' })).blocks ?? [];
      const placeholder = outline[1];
      const parsed = resultJson(
        await callTool(store, EDIT_SPACE_TOOL_NAME, {
          space_name: 'Dog breeds',
          expected_revision: 1,
          edits: [
            {
              type: 'block',
              anchor: placeholder?.anchor,
              fingerprint: placeholder?.fingerprint,
              new_content: rowRange(1, 60),
            },
          ],
        }),
      );
      const blocks = parsed.blocks ?? [];
      const index = blocks.findIndex(block => block.anchor === parsed.continue_after?.anchor);
      expect(blocks[index]?.preview).toMatch(/^\| Breed/);
      expect(blocks[index + 1]?.preview).toBe('## End');
      expect(parsed.summary).toContain('Insert them after block');
    });

    it('refuses a call that cannot be cut for its size before the revision check, leaving the breaker alone', async () => {
      const store = new InMemorySpaceStore();
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
      const call = (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });
      await call(CREATE_SPACE_TOOL_NAME, createInput(tablePart(1, 5)));
      const table = (resultJson(await call(LIST_BLOCKS_TOOL_NAME, { space_name: 'Dog breeds' })).blocks ?? [])[1];
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const refused = await call(EDIT_SPACE_TOOL_NAME, {
          space_name: 'Dog breeds',
          expected_revision: 99,
          edits: [
            { type: 'block', anchor: table?.anchor, fingerprint: table?.fingerprint, new_content: rowRange(1, 60) },
          ],
        });
        expect(resultJson(refused).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);
      }
      const html = await call(CREATE_SPACE_TOOL_NAME, { ...createInput('<p>a</p>', 'html'), name: 'Page' });
      const htmlBlock = (resultJson(await call(LIST_BLOCKS_TOOL_NAME, { space_name: 'Page' })).blocks ?? [])[0];
      expect(isErrorResponse(html)).toBe(false);
      const htmlRefused = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Page',
        expected_revision: 99,
        edits: [
          {
            type: 'insert',
            after: htmlBlock?.anchor,
            fingerprint: htmlBlock?.fingerprint,
            new_content: rowRange(1, 60),
          },
        ],
      });
      expect(resultJson(htmlRefused).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);
      const fine = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [
          { type: 'block', anchor: table?.anchor, fingerprint: table?.fingerprint, new_content: tablePart(2, 3) },
        ],
      });
      expect(isErrorResponse(fine)).toBe(false);
    });

    it('refuses an over-size edit with two insert entries', async () => {
      const store = new InMemorySpaceStore();
      await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(tablePart(1, 5)));
      const outline =
        resultJson(await callTool(store, LIST_BLOCKS_TOOL_NAME, { space_name: 'Dog breeds' })).blocks ?? [];
      const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: 1,
        edits: [
          {
            type: 'insert',
            after: outline[0]?.anchor,
            fingerprint: outline[0]?.fingerprint,
            new_content: rowRange(6, 30),
          },
          {
            type: 'insert',
            after: outline[1]?.anchor,
            fingerprint: outline[1]?.fingerprint,
            new_content: rowRange(31, 60),
          },
        ],
      });
      expect(isErrorResponse(response)).toBe(true);
      expect(resultJson(response).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);
    });

    it('still refuses an over-size html create', async () => {
      const store = new InMemorySpaceStore();
      const body = `<ul>\n${rowRange(1, 60)
        .split('\n')
        .map(line => `<li>${line}</li>`)
        .join('\n')}\n</ul>`;
      const response = await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(body, 'html'));
      expect(isErrorResponse(response)).toBe(true);
      expect(resultJson(response).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);
    });

    it('refuses an over-size line that no part could hold', async () => {
      const store = new InMemorySpaceStore();
      const response = await callTool(
        store,
        CREATE_SPACE_TOOL_NAME,
        createInput(`# Title\n\nintro\n\n${'x'.repeat(5_000)}`),
      );
      expect(isErrorResponse(response)).toBe(true);
      expect(resultJson(response).error_code).toBe(SPACE_WRITE_TOO_LONG_ERROR_CODE);
    });

    it('refuses the whole call when a link in the unsaved tail is not allowed', async () => {
      const store = new InMemorySpaceStore();
      const body = `${tablePart(1, 60)}\n\n[Docs](https://example.invalid/never-searched)`;
      const response = await callTool(store, CREATE_SPACE_TOOL_NAME, createInput(body));
      expect(isErrorResponse(response)).toBe(true);
      expect(resultJson(response).error_code).toBeUndefined();
      const listed = await callTool(store, LIST_SPACES_TOOL_NAME, {});
      expect(resultJson(listed).spaces).toHaveLength(0);
    });
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
    const call = (name: string, args: Record<string, unknown>) => callTool(store, name, args);
    let revision = 1;
    for (const [from, to] of [
      [11, 20],
      [21, 30],
      [31, 40],
    ] as const) {
      const last = await lastBlockOf(call, 'Dog breeds');
      const response = await callTool(store, EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: revision,
        edits: [{ type: 'insert', after: last.anchor, fingerprint: last.fingerprint, new_content: rowRange(from, to) }],
      });
      expect(isErrorResponse(response)).toBe(false);
      revision += 1;
    }
    const read = await callTool(store, GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const body = resultJson(read).space?.body ?? '';
    expect(body.length).toBeGreaterThan(SPACE_WRITE_MAX_LENGTH);
    const breedRows = body.split('\n').filter(line => /^\| Breed \d/.test(line));
    expect(breedRows).toHaveLength(40);
    expect(breedRows[0]).toContain('Breed 01');
    expect(breedRows[39]).toContain('Breed 40');
  });

  it('tells the model the number to aim at and the parts flow in the instructions', () => {
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
    // The model is told one number, 3,600, which leaves headroom under the real cap;
    // the cap itself is never reported to the model.
    expect(rendered).toContain(
      'one write carries at most about 3,600 characters: about 25 table rows or 40 short lines, and a write past the limit',
    );
    expect(rendered).toContain('The one exception is a call whose only entry is an append entry');
    expect(rendered).toContain(
      'When a result says part of the content was not saved, continue from the line it names, without resending saved lines. ' +
        'To add rows or sections at the end, use an append entry (no anchor or fingerprint needed). ' +
        'Send only rows that are not there yet. ' +
        'End every reply that changed a space with one line saying what was saved.',
    );
    expect(rendered).not.toContain('4,000');
    expect(rendered).toContain('add the rest a few rows at a time');
  });

  it('tells the model the same number in the space tool descriptions', async () => {
    const capability = spaceCapability({
      store: new InMemorySpaceStore(),
      authority: { tenantId: 'default', userRef: 'user-a' },
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }
    const listed = await toolSet.listTools();
    const tools = 'result' in listed ? listed.result.tools : [];
    for (const name of [CREATE_SPACE_TOOL_NAME, EDIT_SPACE_TOOL_NAME]) {
      const tool = tools.find(candidate => candidate.name === name);
      if (tool === undefined) {
        throw new Error(`expected the ${name} tool to be listed`);
      }
      expect(tool.description ?? '').toContain('about 3,600 characters: about 25 table rows or 40 short lines');
      expect(tool.description ?? '').not.toContain('4,000');
    }
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
    // Edit carries up to 50 entries; an entry names one anchor (200) and one block
    // fingerprint (8), and the new content across the call is capped at the write cap.
    expect(SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(EDIT_SPACE_TOOL_NAME)).toBe(
      6 * (50 * 208 + SPACE_WRITE_MAX_LENGTH + 2_000 + 160 + 160 + 8 + 8) + 3_000,
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

  it('does not cut the largest valid edit: 50 entries at their widest, escape-heavy', async () => {
    // The widest edit the tool layer accepts: 50 entries, each with a 200-character
    // anchor and an 8-character fingerprint, and new content of control characters
    // (each streaming as a six-character escape) summing to exactly the write cap.
    const widest = JSON.stringify({
      space_name: 'n'.repeat(160),
      expected_revision: 1,
      new_title: 't'.repeat(160),
      edits: Array.from({ length: 50 }, () => ({
        type: 'block',
        anchor: 'a'.repeat(200),
        fingerprint: '0123abcd',
        new_content: '\u0001'.repeat(80),
      })),
    });
    const edited = await drainParts(toolCallParts(EDIT_SPACE_TOOL_NAME, widest));
    expect(edited.size_cut_tool_calls).toBeUndefined();
    expect(edited.output.tool_calls?.[0]?.function.arguments).toBe(widest);
  });

  it('cuts a call that streams past its derived limit, for each write tool', async () => {
    const createLimit = SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(CREATE_SPACE_TOOL_NAME) ?? 0;
    const overCreate = `{"body":"${'x'.repeat(createLimit)}"}`;
    const cutCreate = await drainParts(toolCallParts(CREATE_SPACE_TOOL_NAME, overCreate));
    expect(cutCreate.size_cut_tool_calls).toEqual(['call-1']);

    // One single delta past the edit limit: the cut lands on the accumulated length.
    const editLimit = SPACE_WRITE_TOOL_ARGUMENT_LIMITS.get(EDIT_SPACE_TOOL_NAME) ?? 0;
    const overEdit = `{"edits":[{"type":"block","anchor":"b1","fingerprint":"00000000","new_content":"${'x'.repeat(editLimit)}"}]}`;
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
  it('a missed edit, a lockout, and a revert all recover in parts without losing content', async () => {
    const store = new InMemorySpaceStore();
    recoverySessionCounter += 1;
    const call = makeSessionCallTool(store, `write-size-recovery-${String(recoverySessionCounter)}`);

    // Build the 40-row table in parts, the flow the cap prescribes: the finished body is
    // well past one write's 4,000 characters. Revisions: create 1, then 2, 3, 4.
    const created = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Dog breeds',
      purpose: PURPOSE,
      status: 'active',
      body: tablePart(1, 10),
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);
    let revision = 1;
    for (const [from, to] of [
      [11, 20],
      [21, 30],
      [31, 40],
    ] as const) {
      const last = await lastBlockOf(call, 'Dog breeds');
      const extended = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: revision,
        edits: [{ type: 'insert', after: last.anchor, fingerprint: last.fingerprint, new_content: rowRange(from, to) }],
      });
      expect(isErrorResponse(extended)).toBe(false);
      revision += 1;
    }
    const built = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const builtBody = resultJson(built).space?.body ?? '';
    expect(builtBody.length).toBeGreaterThan(SPACE_WRITE_MAX_LENGTH);

    // A missed anchor: the error teaches the parts recovery, and following it works.
    const missed = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: revision,
      edits: [{ type: 'block', anchor: 'b99', fingerprint: '00000000', new_content: 'x' }],
    });
    expect(isErrorResponse(missed)).toBe(true);
    const missError = resultJson(missed).error ?? '';
    expect(missError).toContain('call list_blocks');
    expect(missError).toContain('make the change with edit_space in parts');
    // Only the size refusal carries the code; other refusals stay plain failures in the chat.
    expect(resultJson(missed).error_code).toBeUndefined();
    const last = await lastBlockOf(call, 'Dog breeds');
    const appended = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: revision,
      edits: [
        {
          type: 'insert',
          after: last.anchor,
          fingerprint: last.fingerprint,
          new_content: '| Breed 41 | Group 5 | Added after the miss |',
        },
      ],
    });
    expect(isErrorResponse(appended)).toBe(false);
    revision += 1;

    // Three more misses lock delta mode. The taught unlock is revert_space to the current
    // revision: the body survives byte for byte, and edits work again.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: revision,
        edits: [{ type: 'block', anchor: 'b99', fingerprint: '00000000', new_content: 'x' }],
      });
      expect(isErrorResponse(failed)).toBe(true);
    }
    const lastAfterLock = await lastBlockOf(call, 'Dog breeds');
    const locked = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: revision,
      edits: [
        { type: 'insert', after: lastAfterLock.anchor, fingerprint: lastAfterLock.fingerprint, new_content: 'x' },
      ],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error ?? '').toContain("call revert_space with the space's current revision");

    const beforeRevert = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const bodyBeforeRevert = resultJson(beforeRevert).space?.body ?? '';
    const currentRevision = resultJson(beforeRevert).space?.revision ?? 0;
    expect(currentRevision).toBe(revision);
    const reverted = await call(REVERT_SPACE_TOOL_NAME, { space_name: 'Dog breeds', revision: currentRevision });
    expect(isErrorResponse(reverted)).toBe(false);
    const afterRevert = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    expect(resultJson(afterRevert).space?.body).toBe(bodyBeforeRevert);

    const lastAfterRevert = await lastBlockOf(call, 'Dog breeds');
    const editsAgain = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: currentRevision + 1,
      edits: [
        {
          type: 'insert',
          after: lastAfterRevert.anchor,
          fingerprint: lastAfterRevert.fingerprint,
          new_content: '| Breed 42 | Group 5 | Added after the recovery |',
        },
      ],
    });
    expect(isErrorResponse(editsAgain)).toBe(false);
    const finalRead = await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const finalBody = resultJson(finalRead).space?.body ?? '';
    expect(finalBody).toContain('| Breed 41 |');
    expect(finalBody).toContain('| Breed 42 |');
    expect(finalBody.split('\n').filter(line => /^\| Breed \d/.test(line))).toHaveLength(42);
  });

  it('a duplicated anchor recovers by reverting to a revision where it was unique, as its error teaches', async () => {
    const store = new InMemorySpaceStore();
    recoverySessionCounter += 1;
    const call = makeSessionCallTool(store, `write-size-recovery-${String(recoverySessionCounter)}`);
    const body = '<!-- @block:dup -->\n<p>first</p>\n<!-- @block:other -->\n<p>other</p>';
    const created = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Duplicates',
      purpose: PURPOSE,
      status: 'active',
      body,
      format: 'markdown',
    });
    expect(isErrorResponse(created)).toBe(false);

    // A later edit introduces a second copy of the marker: dup is duplicated now.
    const listed = await call(LIST_BLOCKS_TOOL_NAME, { space_name: 'Duplicates' });
    const otherFingerprint = (resultJson(listed).blocks ?? []).find(b => b.anchor === 'other')?.fingerprint ?? '';
    const introduced = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'other',
          fingerprint: otherFingerprint,
          new_content: '<p>other</p>\n<!-- @block:dup -->\n<p>second</p>',
        },
      ],
    });
    expect(isErrorResponse(introduced)).toBe(false);

    // No edit can rename one copy (the anchor names them all), so the refusal teaches
    // the revert: back to a revision where the anchor was unique.
    const blocked = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'dup', fingerprint: '00000000', new_content: '<p>winner</p>' }],
    });
    expect(isErrorResponse(blocked)).toBe(true);
    const dupError = resultJson(blocked).error ?? '';
    expect(dupError).toContain('appears 2 times');
    expect(dupError).toContain('revert_space to that revision brings the unique anchor back');

    const reverted = await call(REVERT_SPACE_TOOL_NAME, { space_name: 'Duplicates', revision: 1 });
    expect(isErrorResponse(reverted)).toBe(false);

    // Unique again at the new revision (3): the edit that was refused now lands.
    const listedAfter = await call(LIST_BLOCKS_TOOL_NAME, { space_name: 'Duplicates' });
    const dupFingerprint = (resultJson(listedAfter).blocks ?? []).find(b => b.anchor === 'dup')?.fingerprint ?? '';
    const landed = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Duplicates',
      expected_revision: 3,
      edits: [{ type: 'block', anchor: 'dup', fingerprint: dupFingerprint, new_content: '<p>first updated</p>' }],
    });
    expect(isErrorResponse(landed)).toBe(false);
    const read = await call(GET_SPACE_TOOL_NAME, { space_name: 'Duplicates' });
    // A marked block's replacement is its whole content, as before this change: the
    // line break after the old content was part of that content, so the next marker
    // follows the new content directly.
    expect(resultJson(read).space?.body).toBe(
      '<!-- @block:dup -->\n<p>first updated</p><!-- @block:other -->\n<p>other</p>',
    );
  });
});
