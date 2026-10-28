/**
 * The block-edits contract: every space body has addressable blocks, and edit_space
 * changes a body by block anchors alone.
 *
 * Same style as spaceCapability.delta.test.ts: a stateful in-memory store drives the
 * real tool sequence through ONE capability instance, the way a model would live it:
 * read the blocks, note the revision, edit by anchor, extend a table in parts.
 */
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
  LIST_BLOCKS_TOOL_NAME,
  REVERT_SPACE_TOOL_NAME,
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

/** A real (in-memory) space store: persistence, revisions, fencing, bounded history. */
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

interface SpaceWireBlock {
  anchor: string;
  fingerprint: string;
  preview: string;
  occurrences: number;
}

interface SpaceWireResult {
  summary?: string;
  revision_was_stale?: boolean;
  block_results?: { anchor: string; new_length: number; deleted: boolean }[];
  space?: { body: string; revision: number; name: string; purpose: string; status: string };
  blocks?: SpaceWireBlock[];
  revision?: number;
  error?: string;
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
  const parsed: SpaceWireResult = JSON.parse(resultText(response));
  return parsed;
}

let sessionCounter = 0;

/** One harness per test: a fresh store plus ONE capability instance reused across calls. */
function makeHarness() {
  const store = new InMemorySpaceStore();
  sessionCounter += 1;
  const capability = spaceCapability({
    store,
    authority: { tenantId: 'default', userRef: 'user-a' },
    tracing: NOOP_TRACING,
    webSearch: createWebSearchTurnState(),
    sessionId: `blocks-session-${String(sessionCounter)}`,
  });
  const toolSet = capability.systemToolSets?.[0];
  if (toolSet === undefined) {
    throw new Error('expected space tool set');
  }
  const callTool = (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });
  return { store, callTool };
}

async function createSpace(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  input: { name: string; body: string },
): Promise<void> {
  const created = await callTool(CREATE_SPACE_TOOL_NAME, {
    name: input.name,
    purpose: `${input.name} purpose.`,
    status: 'active',
    format: 'markdown',
    body: input.body,
  });
  expect(isErrorResponse(created)).toBe(false);
}

async function listBlocks(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
): Promise<SpaceWireResult> {
  const listed = await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: spaceName });
  expect(isErrorResponse(listed)).toBe(false);
  return resultJson(listed);
}

async function readBody(
  callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
): Promise<string> {
  const read = await callTool(GET_SPACE_TOOL_NAME, { space_name: spaceName });
  const body = resultJson(read).space?.body;
  if (body === undefined) {
    throw new Error(`expected a space body in tool result: ${resultText(read)}`);
  }
  return body;
}

describe('structural blocks for a body with no markers', () => {
  it('segments headings, paragraphs, a list group, and a table, with stable ordinal anchors', async () => {
    const { callTool } = makeHarness();
    const body = [
      '# Trip notes',
      '',
      'Pack the passports.',
      '',
      'Buy snacks:',
      '- apples',
      '- oranges',
      '',
      'First paragraph repeats.',
      '',
      'First paragraph repeats.',
      '',
      '| City | Day |',
      '| --- | --- |',
      '| Paris | Mon |',
      '| Lyon | Tue |',
    ].join('\n');
    await createSpace(callTool, { name: 'Trip notes', body });

    const listed = await listBlocks(callTool, 'Trip notes');
    expect(listed.revision).toBe(1);
    const blocks = listed.blocks ?? [];
    expect(blocks.map(b => b.anchor)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
    expect(blocks[0]?.preview).toContain('Trip notes');
    expect(blocks[1]?.preview).toBe('Pack the passports.');
    expect(blocks[2]?.preview).toContain('Buy snacks:');
    // The two identical paragraphs are separate blocks with the same preview.
    expect(blocks[3]?.preview).toBe('First paragraph repeats.');
    expect(blocks[4]?.preview).toBe('First paragraph repeats.');
    expect(blocks[5]?.preview).toContain('| City | Day |');
    for (const block of blocks) {
      expect(block.occurrences).toBe(1);
    }

    // The anchors are stable for the revision: a second read names the same blocks.
    const relisted = await listBlocks(callTool, 'Trip notes');
    expect((relisted.blocks ?? []).map(b => b.anchor)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5', 'b6']);
  });

  it('two identical paragraphs are addressable distinctly by ordinal', async () => {
    const { callTool } = makeHarness();
    const body = 'Same line here.\n\nSame line here.\n\nA different end.';
    await createSpace(callTool, { name: 'Repeats', body });

    // Identical blocks share a fingerprint by construction: the anchor, not the
    // fingerprint, says which copy an edit means.
    const blocks = (await listBlocks(callTool, 'Repeats')).blocks ?? [];
    expect(blocks[0]?.fingerprint).toBe(blocks[1]?.fingerprint);
    expect(blocks[0]?.fingerprint).not.toBe(blocks[2]?.fingerprint);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Repeats',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b2', fingerprint: blocks[1]?.fingerprint ?? '', new_content: 'Changed line.' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    // Only the second copy changed; the first is byte-identical.
    expect(await readBody(callTool, 'Repeats')).toBe('Same line here.\n\nChanged line.\n\nA different end.');
  });

  it('a heading is a block of its own; the content under it is separate blocks', async () => {
    const { callTool } = makeHarness();
    const body = '# Plan\nThe lead paragraph.\n\nThe next paragraph.\n\n## Part two\nMore text.';
    await createSpace(callTool, { name: 'Plan', body });

    const blocks = (await listBlocks(callTool, 'Plan')).blocks ?? [];
    expect(blocks.map(b => b.anchor)).toEqual(['b1', 'b2', 'b3', 'b4', 'b5']);
    expect(blocks[0]?.preview).toBe('# Plan');
    expect(blocks[1]?.preview).toBe('The lead paragraph.');
    expect(blocks[2]?.preview).toBe('The next paragraph.');
    expect(blocks[3]?.preview).toBe('## Part two');
    expect(blocks[4]?.preview).toBe('More text.');

    // Changing just the heading resends just the heading: one small block edit.
    const renamed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Plan',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: blocks[0]?.fingerprint ?? '', new_content: '# The plan' }],
    });
    expect(isErrorResponse(renamed)).toBe(false);
    expect(await readBody(callTool, 'Plan')).toBe(
      '# The plan\nThe lead paragraph.\n\nThe next paragraph.\n\n## Part two\nMore text.',
    );
  });

  it('headings and table rows inside a fenced code block are text, not structure', async () => {
    const { callTool } = makeHarness();
    const body = ['Intro.', '', '```', '# not a heading', '| not a table |', '```', '', 'After.'].join('\n');
    await createSpace(callTool, { name: 'Fences', body });

    const blocks = (await listBlocks(callTool, 'Fences')).blocks ?? [];
    expect(blocks.map(b => b.anchor)).toEqual(['b1', 'b2', 'b3']);
    expect(blocks[1]?.preview).toContain('# not a heading');
    expect(blocks[2]?.preview).toBe('After.');
  });

  it('a long table splits into a header group and row groups', async () => {
    const { store, callTool } = makeHarness();
    const rows: string[] = [];
    for (let index = 1; index <= 60; index += 1) {
      rows.push(`| Row ${String(index).padStart(2, '0')} | ${'x'.repeat(95)} |`);
    }
    const body = ['# Big table', '', '| Breed | Note |', '| --- | --- |', ...rows].join('\n');
    // Seeded directly in the store: the finished table is past the per-write cap, so
    // it could only have been built in parts; the subject here is its segmentation.
    await store.createSpace({
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'big-table',
      name: 'Big table',
      purpose: 'Segmentation probe.',
      status: 'active',
      format: 'markdown',
      body,
      expected_aggregate_revision: 0,
    });

    const blocks = (await listBlocks(callTool, 'Big table')).blocks ?? [];
    // One heading block plus several table groups (each group is capped near 2,000
    // characters, so 60 rows of about 110 characters cannot be one block).
    expect(blocks.length).toBeGreaterThan(3);
    expect(blocks.length).toBeLessThan(8);
    expect(blocks[0]?.preview).toContain('Big table');
    // The header is pinned to the first table group.
    expect(blocks[1]?.preview).toContain('| Breed | Note |');
    for (const block of blocks.slice(2)) {
      expect(block.preview).not.toContain('| Breed | Note |');
      expect(block.preview.startsWith('| Row')).toBe(true);
    }

    // The last group is addressable on its own: one more row lands after it.
    const last = blocks[blocks.length - 1];
    if (last === undefined) {
      throw new Error('expected at least one block');
    }
    const extended = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Big table',
      expected_revision: 1,
      edits: [
        {
          type: 'insert',
          after: last.anchor,
          fingerprint: last.fingerprint,
          new_content: `| Row 61 | ${'y'.repeat(95)} |`,
        },
      ],
    });
    expect(isErrorResponse(extended)).toBe(false);
    const finalBody = await readBody(callTool, 'Big table');
    expect(finalBody.split('\n').filter(line => line.startsWith('| Row'))).toHaveLength(61);
  });
});

describe('the dog-table flow: build a 40-row table in parts by block edits', () => {
  const BREEDS = [
    'Labrador Retriever',
    'German Shepherd',
    'Golden Retriever',
    'French Bulldog',
    'Bulldog',
    'Poodle',
    'Beagle',
    'Rottweiler',
    'Dachshund',
    'German Shorthaired Pointer',
    'Pembroke Welsh Corgi',
    'Australian Shepherd',
    'Yorkshire Terrier',
    'Cavalier King Charles Spaniel',
    'Doberman Pinscher',
    'Great Dane',
    'Miniature Schnauzer',
    'Siberian Husky',
    'Bernese Mountain Dog',
    'Cane Corso',
    'Shih Tzu',
    'Boston Terrier',
    'Pomeranian',
    'Havanese',
    'English Springer Spaniel',
    'Shetland Sheepdog',
    'Brittany',
    'Cocker Spaniel',
    'Border Collie',
    'Miniature American Shepherd',
    'Vizsla',
    'Pug',
    'Basset Hound',
    'Mastiff',
    'Belgian Malinois',
    'Chihuahua',
    'Collie',
    'Maltese',
    'Weimaraner',
    'Rhodesian Ridgeback',
  ];
  const SIZES = ['Small', 'Medium', 'Large'];
  const ENERGY = ['Low', 'Moderate', 'High'];
  const rowFor = (breed: string, index: number): string =>
    `| ${breed} | ${SIZES[index % 3] ?? 'Medium'} | ${ENERGY[index % 3] ?? 'Moderate'} | Yes | A steady, people-focused dog that fits family life well. |`;
  const rowsFor = (from: number, to: number): string =>
    BREEDS.slice(from - 1, to)
      .map((breed, offset) => rowFor(breed, from - 1 + offset))
      .join('\n');

  it('creates with the heading and first rows, then extends by inserts past the cap in total', async () => {
    const { callTool } = makeHarness();
    const header = [
      '# Dog breeds',
      '',
      '| Breed | Size | Energy | Good with kids | Note |',
      '| --- | --- | --- | --- | --- |',
    ].join('\n');
    await createSpace(callTool, { name: 'Dog breeds', body: `${header}\n${rowsFor(1, 8)}` });

    // The first part reads the blocks once. Each later part chains from what the
    // previous edit handed back: its result carries the new revision and the fresh
    // block outline, so no re-read is paid between edits. No entry ever reproduces
    // text that is already in the body.
    let outline = (await listBlocks(callTool, 'Dog breeds')).blocks ?? [];
    let revision = 1;
    for (const [from, to] of [
      [9, 16],
      [17, 24],
      [25, 32],
      [33, 40],
    ] as const) {
      const last = outline[outline.length - 1];
      if (last === undefined) {
        throw new Error('expected at least one block');
      }
      const extended = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: revision,
        edits: [{ type: 'insert', after: last.anchor, fingerprint: last.fingerprint, new_content: rowsFor(from, to) }],
      });
      expect(isErrorResponse(extended)).toBe(false);
      const parsed = resultJson(extended);
      revision += 1;
      expect(parsed.space?.revision).toBe(revision);
      outline = parsed.blocks ?? [];
      expect(outline.length).toBeGreaterThan(0);
    }

    const read = await callTool(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' });
    const space = resultJson(read).space;
    expect(space?.revision).toBe(5);
    const body = space?.body ?? '';
    // The finished body is well past one write's 4,000 characters, and every row is in it.
    expect(body.length).toBeGreaterThan(4_000);
    const breedRows = body
      .split('\n')
      .filter(line => line.startsWith('| ') && !line.startsWith('| Breed') && !line.startsWith('| ---'));
    expect(breedRows).toHaveLength(40);
    for (const breed of BREEDS) {
      expect(body).toContain(`| ${breed} |`);
    }

    // The finished table is several blocks, not one: the heading on its own, then
    // table groups small enough to edit one at a time. A group in the middle takes
    // an insert by its own anchor, which is what the segmentation is for: as one
    // whole-body block there would be no middle anchor to name, and this step of
    // the flow could not be expressed at all.
    const finalOutline = (await listBlocks(callTool, 'Dog breeds')).blocks ?? [];
    expect(finalOutline.length).toBeGreaterThan(2);
    expect(finalOutline[0]?.preview).toContain('# Dog breeds');
    const middle = finalOutline[2];
    if (middle === undefined) {
      throw new Error('expected a middle table group');
    }
    const withExtra = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      expected_revision: 5,
      edits: [
        {
          type: 'insert',
          after: middle.anchor,
          fingerprint: middle.fingerprint,
          new_content:
            '| Border Terrier | Medium | High | Yes | A steady, people-focused dog that fits family life well. |',
        },
      ],
    });
    expect(isErrorResponse(withExtra)).toBe(false);
    const finalBody = await readBody(callTool, 'Dog breeds');
    expect(finalBody).toContain('| Border Terrier |');
    expect(
      finalBody
        .split('\n')
        .filter(line => line.startsWith('| ') && !line.startsWith('| Breed') && !line.startsWith('| ---')),
    ).toHaveLength(41);
  });

  it('a search entry is refused: edit_space entries are block and insert entries only', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'No search', body: 'Some text here.' });

    const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'No search',
      expected_revision: 1,
      edits: [{ type: 'search', search: 'Some', replace: 'Any' }],
    });
    expect(isErrorResponse(refused)).toBe(true);
    expect(resultJson(refused).error).toContain('Invalid space call');
    expect(await readBody(callTool, 'No search')).toBe('Some text here.');
  });
});

describe('block edits carry the revision they were read at', () => {
  it('a stale expected_revision refuses, names the current revision, and persists nothing', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Stale', body: 'First paragraph.\n\nSecond paragraph.' });
    const outline = (await listBlocks(callTool, 'Stale')).blocks ?? [];

    const moved = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Stale',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b1',
          fingerprint: outline[0]?.fingerprint ?? '',
          new_content: 'First paragraph, updated.',
        },
      ],
    });
    expect(isErrorResponse(moved)).toBe(false);
    const bodyAfterMove = await readBody(callTool, 'Stale');

    // The caller's copy is revision 1; the space is at revision 2 now.
    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Stale',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: 'b2',
          fingerprint: outline[1]?.fingerprint ?? '',
          new_content: 'Second paragraph, updated.',
        },
      ],
    });
    expect(isErrorResponse(stale)).toBe(true);
    const parsed = resultJson(stale);
    expect(parsed.revision).toBe(2);
    expect(parsed.error).toContain('Call get_space to read the current revision');
    expect(await readBody(callTool, 'Stale')).toBe(bodyAfterMove);
  });

  it('a successful edit returns the new revision and the fresh block outline', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Outline', body: '# Title\n\nFirst.\n\nSecond.' });
    const before = (await listBlocks(callTool, 'Outline')).blocks ?? [];

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Outline',
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b3', fingerprint: before[2]?.fingerprint ?? '', new_content: 'Third.' }],
    });
    expect(isErrorResponse(updated)).toBe(false);
    const parsed = resultJson(updated);
    expect(parsed.space?.revision).toBe(2);
    // The outline in the result is the new revision's outline: the same anchors and
    // previews a list_blocks call returns now, so the next edit can chain from it.
    const listed = await listBlocks(callTool, 'Outline');
    expect(parsed.blocks).toEqual(listed.blocks);
    expect((parsed.blocks ?? []).map(b => b.anchor)).toEqual(['b1', 'b2', 'b3', 'b4']);
    expect((parsed.blocks ?? [])[3]?.preview).toBe('Third.');
  });

  it('an edit call without expected_revision is refused, naming the field', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'No revision', body: 'Some text here.' });
    const outline = (await listBlocks(callTool, 'No revision')).blocks ?? [];

    const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'No revision',
      edits: [{ type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'Other text.' }],
    });
    expect(isErrorResponse(refused)).toBe(true);
    const error = resultJson(refused).error ?? '';
    expect(error).toContain('Invalid space call');
    expect(error).toContain('expected_revision');
    expect(await readBody(callTool, 'No revision')).toBe('Some text here.');
  });

  it('entries in one call all apply to the named revision, and one block takes one entry', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Atomic', body: 'One.\n\nTwo.\n\nThree.' });
    const outline = (await listBlocks(callTool, 'Atomic')).blocks ?? [];
    const fp = (index: number): string => outline[index]?.fingerprint ?? '';

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Atomic',
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: fp(0), new_content: 'One, updated.' },
        { type: 'insert', after: 'b3', fingerprint: fp(2), new_content: 'Four.' },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, 'Atomic')).toBe('One, updated.\n\nTwo.\n\nThree.\n\nFour.');

    // Two entries naming the same block in one call refuse, and nothing persists.
    const repeated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Atomic',
      expected_revision: 2,
      edits: [
        { type: 'block', anchor: 'b2', fingerprint: fp(1), new_content: 'Two, first.' },
        { type: 'block', anchor: 'b2', fingerprint: fp(1), new_content: 'Two, second.' },
      ],
    });
    expect(isErrorResponse(repeated)).toBe(true);
    expect(resultJson(repeated).error).toContain('named by two entries');
    expect(await readBody(callTool, 'Atomic')).toBe('One, updated.\n\nTwo.\n\nThree.\n\nFour.');
  });
});

describe("Wendy's flow: bad anchors lock the space, a revert to the current revision unlocks it", () => {
  it('repeated bad-anchor edits trip the breaker; revert unlocks; a correct block edit then lands', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Bulletin', body: 'First line of the notice.\n\nSecond line of the notice.' });
    const outline = (await listBlocks(callTool, 'Bulletin')).blocks ?? [];
    const firstFingerprint = outline[0]?.fingerprint ?? '';

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Bulletin',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: 'b99', fingerprint: '00000000', new_content: 'x' }],
      });
      expect(isErrorResponse(failed)).toBe(true);
      expect(resultJson(failed).error).toContain('Unknown block anchor "b99"');
    }

    // Locked: even the correct edit is refused until the unlock.
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Bulletin',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: firstFingerprint, new_content: 'First line, fixed.' }],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');

    // The taught unlock: revert_space to the CURRENT revision keeps the body and clears the lock.
    const reverted = await callTool(REVERT_SPACE_TOOL_NAME, { space_name: 'Bulletin', revision: 1 });
    expect(isErrorResponse(reverted)).toBe(false);
    expect(await readBody(callTool, 'Bulletin')).toBe('First line of the notice.\n\nSecond line of the notice.');

    // The revert made a new revision (2), and a correct block edit against it lands.
    const fixed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Bulletin',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: firstFingerprint, new_content: 'First line, fixed.' }],
    });
    expect(isErrorResponse(fixed)).toBe(false);
    expect(await readBody(callTool, 'Bulletin')).toBe('First line, fixed.\n\nSecond line of the notice.');
  });

  it('a stale revision counts toward the breaker like any other failed block edit', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Counting', body: 'Alpha.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Counting')).blocks ?? [];

    const moved = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Counting',
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'Alpha, updated.' },
      ],
    });
    expect(isErrorResponse(moved)).toBe(false);

    // Failure 1: a stale revision. Failures 2 and 3: unknown anchors at the current revision.
    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Counting',
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b2', fingerprint: outline[1]?.fingerprint ?? '', new_content: 'Beta, updated.' },
      ],
    });
    expect(isErrorResponse(stale)).toBe(true);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const failed = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Counting',
        expected_revision: 2,
        edits: [{ type: 'block', anchor: 'nope', fingerprint: '00000000', new_content: 'x' }],
      });
      expect(isErrorResponse(failed)).toBe(true);
    }
    const locked = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Counting',
      expected_revision: 2,
      edits: [
        { type: 'block', anchor: 'b2', fingerprint: outline[1]?.fingerprint ?? '', new_content: 'Beta, updated.' },
      ],
    });
    expect(isErrorResponse(locked)).toBe(true);
    expect(resultJson(locked).error).toContain('locked');
  });
});

describe('fingerprints verify what is at the anchor', () => {
  it('an edit whose fingerprint went stale because the block changed refuses and persists nothing', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Fingerprints', body: 'Alpha.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Fingerprints')).blocks ?? [];
    const betaFingerprint = outline[1]?.fingerprint ?? '';

    // The block changes: its fingerprint changes with it.
    const changed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Fingerprints',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b2', fingerprint: betaFingerprint, new_content: 'Beta, updated.' }],
    });
    expect(isErrorResponse(changed)).toBe(false);

    // A second edit against the current revision but the fingerprint from before the
    // change refuses: the content it names is not at that anchor any more.
    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Fingerprints',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'b2', fingerprint: betaFingerprint, new_content: 'Beta, again.' }],
    });
    expect(isErrorResponse(stale)).toBe(true);
    const error = resultJson(stale).error ?? '';
    expect(error).toContain('does not hold the content fingerprint');
    expect(error).toContain('No block in the current revision has that fingerprint');
    expect(await readBody(callTool, 'Fingerprints')).toBe('Alpha.\n\nBeta, updated.');
  });

  it('the relocation hint names the anchor the content moved to, and the hinted retry lands', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Moved', body: 'Alpha.\n\nBeta.\n\nGamma.' });
    const outline = (await listBlocks(callTool, 'Moved')).blocks ?? [];
    const alphaFingerprint = outline[0]?.fingerprint ?? '';
    const betaFingerprint = outline[1]?.fingerprint ?? '';

    // Alpha goes away: Beta moves from b2 to b1.
    const deleted = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Moved',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: alphaFingerprint, new_content: '' }],
    });
    expect(isErrorResponse(deleted)).toBe(false);
    expect(await readBody(callTool, 'Moved')).toBe('Beta.\n\nGamma.');

    // The model still aims at Beta's old anchor with Beta's fingerprint: at b2 sits
    // Gamma now, so the edit refuses, and the refusal says where Beta is.
    const misaimed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Moved',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'b2', fingerprint: betaFingerprint, new_content: 'Beta, updated.' }],
    });
    expect(isErrorResponse(misaimed)).toBe(true);
    const error = resultJson(misaimed).error ?? '';
    expect(error).toContain('That fingerprint matches block "b1" in the current revision');
    expect(error).toContain('the content you meant is there now');
    expect(await readBody(callTool, 'Moved')).toBe('Beta.\n\nGamma.');

    // The hinted retry: same fingerprint, the named anchor, and the edit lands.
    const retried = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Moved',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: betaFingerprint, new_content: 'Beta, updated.' }],
    });
    expect(isErrorResponse(retried)).toBe(false);
    expect(await readBody(callTool, 'Moved')).toBe('Beta, updated.\n\nGamma.');
  });

  it('a fingerprint matching several blocks is reported plainly, with no guessed anchor', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Copies', body: 'Alpha.\n\nBeta.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Copies')).blocks ?? [];
    const alphaFingerprint = outline[0]?.fingerprint ?? '';
    const betaFingerprint = outline[1]?.fingerprint ?? '';
    // The two Beta copies share their fingerprint.
    expect(outline[2]?.fingerprint).toBe(betaFingerprint);

    const changed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Copies',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: alphaFingerprint, new_content: 'Alpha, updated.' }],
    });
    expect(isErrorResponse(changed)).toBe(false);

    // Aiming Beta's fingerprint at b1: it matches two blocks, so the refusal says so
    // instead of picking one.
    const misaimed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Copies',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: betaFingerprint, new_content: 'Beta, updated.' }],
    });
    expect(isErrorResponse(misaimed)).toBe(true);
    const error = resultJson(misaimed).error ?? '';
    expect(error).toContain('That fingerprint matches 2 blocks in the current revision');
    expect(error).toContain('identical copies share a fingerprint');
    expect(await readBody(callTool, 'Copies')).toBe('Alpha, updated.\n\nBeta.\n\nBeta.');
  });
});

describe('marked bodies keep their named anchors', () => {
  it('an insert after a marked block lands on its own line, before the next marker', async () => {
    const { callTool } = makeHarness();
    const body = '<!-- @block:pricing -->\n<p>Price</p>\n<!-- @block:other -->\n<p>Other</p>';
    await createSpace(callTool, { name: 'Marked insert', body });

    const listed = await listBlocks(callTool, 'Marked insert');
    expect((listed.blocks ?? []).map(b => b.anchor)).toEqual(['pricing', 'other']);

    const updated = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Marked insert',
      expected_revision: 1,
      edits: [
        {
          type: 'insert',
          after: 'pricing',
          fingerprint: listed.blocks?.[0]?.fingerprint ?? '',
          new_content: '<p>Extra</p>',
        },
      ],
    });
    expect(isErrorResponse(updated)).toBe(false);
    expect(await readBody(callTool, 'Marked insert')).toBe(
      '<!-- @block:pricing -->\n<p>Price</p>\n<p>Extra</p>\n<!-- @block:other -->\n<p>Other</p>',
    );
  });
});

describe('append entries add content at the end with no anchor or fingerprint', () => {
  const TABLE = ['# Breeds', '', '| Breed | Size |', '| --- | --- |', '| Poodle | Medium |'].join('\n');

  it('an append after a table joins the table with one line break', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    const response = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '| Papillon | Small |\n| Beagle | Small |' }],
    });
    expect(isErrorResponse(response)).toBe(false);
    expect(await readBody(callTool, 'Breeds')).toBe(`${TABLE}\n| Papillon | Small |\n| Beagle | Small |`);
    const parsed = resultJson(response);
    expect(parsed.revision_was_stale).toBeUndefined();
    expect(parsed.block_results).toEqual([{ anchor: 'b2', new_length: 39, deleted: false }]);
    expect((parsed.blocks ?? []).map(block => block.anchor)).toEqual(['b1', 'b2']);
  });

  it('an append after a paragraph starts a new block after a blank line', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Notes', body: 'First paragraph.\n' });
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Notes',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: 'Second paragraph.' }],
    });
    expect(await readBody(callTool, 'Notes')).toBe('First paragraph.\n\nSecond paragraph.');
  });

  it('an append after a marked block starts on the next line', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Marked append', body: '<!-- @block:pricing -->\n<p>Price</p>' });
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Marked append',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '<!-- @block:other -->\n<p>Other</p>' }],
    });
    expect(await readBody(callTool, 'Marked append')).toBe(
      '<!-- @block:pricing -->\n<p>Price</p>\n<!-- @block:other -->\n<p>Other</p>',
    );
  });

  it('an append with a stale revision is applied to the current end and says so', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '| Papillon | Small |' }],
    });
    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '| Beagle | Small |' }],
    });
    expect(isErrorResponse(stale)).toBe(false);
    const parsed = resultJson(stale);
    expect(parsed.revision_was_stale).toBe(true);
    expect(parsed.summary).toContain('The space had moved to revision 2; the content was appended to the current end.');
    expect(await readBody(callTool, 'Breeds')).toBe(`${TABLE}\n| Papillon | Small |\n| Beagle | Small |`);
  });

  it('two appends in one call are refused with a plain message and nothing is saved', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    const response = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [
        { type: 'append', new_content: '| Papillon | Small |' },
        { type: 'append', new_content: '| Beagle | Small |' },
      ],
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(resultJson(response).error).toContain('send at most one append entry, and put it last');
    expect(await readBody(callTool, 'Breeds')).toBe(TABLE);
  });

  it('an append that is not the last entry is refused', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    const outline = (await listBlocks(callTool, 'Breeds')).blocks ?? [];
    const response = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [
        { type: 'append', new_content: '| Papillon | Small |' },
        { type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: '# Dogs' },
      ],
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(resultJson(response).error).toContain('put it last');
  });

  it('an append plus a block entry keeps the normal revision rule and refuses a stale revision', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    const outline = (await listBlocks(callTool, 'Breeds')).blocks ?? [];
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '| Papillon | Small |' }],
    });
    const bodyBefore = await readBody(callTool, 'Breeds');
    const mixed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: '# Dogs' },
        { type: 'append', new_content: '| Beagle | Small |' },
      ],
    });
    expect(isErrorResponse(mixed)).toBe(true);
    expect(resultJson(mixed).revision).toBe(2);
    expect(await readBody(callTool, 'Breeds')).toBe(bodyBefore);
  });

  it('a stale call that also changes purpose or status is refused, not applied as an append', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '| Papillon | Small |' }],
    });
    const bodyBefore = await readBody(callTool, 'Breeds');
    const response = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      purpose: 'Changed from a stale copy.',
      status: 'archived',
      edits: [{ type: 'append', new_content: '| Beagle | Small |' }],
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(resultJson(response).revision).toBe(2);
    expect(await readBody(callTool, 'Breeds')).toBe(bodyBefore);
    const read = resultJson(await callTool(GET_SPACE_TOOL_NAME, { space_name: 'Breeds' }));
    expect(read.space?.purpose).toBe('Breeds purpose.');
    expect(read.space?.status).toBe('active');
  });

  it('the same append sent twice at an old revision is saved once', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    const send = () =>
      callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Breeds',
        expected_revision: 1,
        edits: [{ type: 'append', new_content: '| Papillon | Small |' }],
      });
    expect(isErrorResponse(await send())).toBe(false);
    const again = await send();
    expect(isErrorResponse(again)).toBe(false);
    expect(resultJson(again).summary).toContain(
      'That content is already at the end of the space, so nothing was added.',
    );
    expect(await readBody(callTool, 'Breeds')).toBe(`${TABLE}\n| Papillon | Small |`);
    expect(resultJson(await callTool(GET_SPACE_TOOL_NAME, { space_name: 'Breeds' })).space?.revision).toBe(2);
  });

  it('plain text appended after a table row of a marked body starts after a blank line', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, {
      name: 'Marked table',
      body: '<!-- @block:t -->\n| A | B |\n| --- | --- |\n| 1 | 2 |',
    });
    await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Marked table',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: 'Source: field notes.' }],
    });
    expect(await readBody(callTool, 'Marked table')).toBe(
      '<!-- @block:t -->\n| A | B |\n| --- | --- |\n| 1 | 2 |\n\nSource: field notes.',
    );
  });

  it('table rows appended after plain text are flagged as a table with no header', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Notes', body: 'Some intro text.' });
    const response = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Notes',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '| Poodle | Medium |' }],
    });
    expect(resultJson(response).summary).toContain(
      'The appended rows start a new table without a header row; add a header if they belong to a new table.',
    );
    const withHeader = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Notes',
      expected_revision: 2,
      edits: [{ type: 'append', new_content: 'Closing words.\n\n| A | B |\n| --- | --- |\n| 1 | 2 |' }],
    });
    expect(resultJson(withHeader).summary).not.toContain('without a header row');
  });

  it('an append of only blank space is refused with a plain message', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: TABLE });
    const response = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'append', new_content: '\n  \n' }],
    });
    expect(isErrorResponse(response)).toBe(true);
    expect(resultJson(response).error).toContain('must have some text');
    expect(await readBody(callTool, 'Breeds')).toBe(TABLE);
  });
});
