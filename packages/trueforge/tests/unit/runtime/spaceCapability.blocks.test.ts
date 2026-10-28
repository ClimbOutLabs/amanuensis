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
  summary?: string;
  revision_was_stale?: boolean;
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
  it('a stale expected_revision over a changed block above refuses, names the current revision, and persists nothing', async () => {
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
    expect(parsed.error).toContain('The space is at revision 2, not 1');
    expect(parsed.blocks?.map(block => block.anchor)).toEqual(['b1', 'b2']);
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

  it('a stale revision refusal hands back the outline and does not count toward the breaker', async () => {
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

    // The stale refusal hands back the outline and does not count: three unknown anchors lock.
    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Counting',
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b2', fingerprint: outline[1]?.fingerprint ?? '', new_content: 'Beta, updated.' },
      ],
    });
    expect(isErrorResponse(stale)).toBe(true);
    for (let attempt = 0; attempt < 3; attempt += 1) {
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

describe('a stale revision or a bad fingerprint does not cost a step', () => {
  async function moveFirstBlock(callTool: ReturnType<typeof makeHarness>['callTool'], name: string) {
    const outline = (await listBlocks(callTool, name)).blocks ?? [];
    const moved = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: name,
      expected_revision: 1,
      edits: [
        { type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'Alpha, moved.' },
      ],
    });
    expect(isErrorResponse(moved)).toBe(false);
    return outline;
  }

  it('applies a stale call when the change was below the block it names', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Proven', body: 'Alpha.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Proven')).blocks ?? [];
    const moved = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Proven',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b2', fingerprint: outline[1]?.fingerprint ?? '', new_content: 'Beta, moved.' }],
    });
    expect(isErrorResponse(moved)).toBe(false);

    const applied = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Proven',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'Alpha, done.' }],
    });
    expect(isErrorResponse(applied)).toBe(false);
    const parsed = resultJson(applied);
    expect(parsed.revision_was_stale).toBe(true);
    expect(parsed.space?.revision).toBe(3);
    expect(parsed.summary).toContain(
      'Your expected_revision was 1 but the space was at 2; every block you named still held what you read, so the change was applied to revision 2.',
    );
    expect(await readBody(callTool, 'Proven')).toBe('Alpha, done.\n\nBeta, moved.');
  });

  it('refuses a repeated insert sent at the same stale revision', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Repeat', body: 'Alpha.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Repeat')).blocks ?? [];
    const insert = { type: 'insert', after: 'b2', fingerprint: outline[1]?.fingerprint ?? '', new_content: 'Gamma.' };
    const first = await callTool(EDIT_SPACE_TOOL_NAME, { space_name: 'Repeat', expected_revision: 1, edits: [insert] });
    expect(isErrorResponse(first)).toBe(false);
    const again = await callTool(EDIT_SPACE_TOOL_NAME, { space_name: 'Repeat', expected_revision: 1, edits: [insert] });
    expect(isErrorResponse(again)).toBe(true);
    expect(resultJson(again).blocks).toHaveLength(3);
    expect(await readBody(callTool, 'Repeat')).toBe('Alpha.\n\nBeta.\n\nGamma.');
  });

  it('refuses a second insert after the same block, so the two cannot land in reverse order', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Order', body: 'Alpha.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Order')).blocks ?? [];
    const after = (content: string) => ({
      space_name: 'Order',
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b2', fingerprint: outline[1]?.fingerprint ?? '', new_content: content }],
    });
    expect(isErrorResponse(await callTool(EDIT_SPACE_TOOL_NAME, after('First.')))).toBe(false);
    expect(isErrorResponse(await callTool(EDIT_SPACE_TOOL_NAME, after('Second.')))).toBe(true);
    expect(await readBody(callTool, 'Order')).toBe('Alpha.\n\nBeta.\n\nFirst.');
  });

  it('refuses a stale call that would hit the wrong copy of an identical block', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Copies', body: 'One.\n\nTwo.\n\nSame.\n\nFour.\n\nSame.' });
    const outline = (await listBlocks(callTool, 'Copies')).blocks ?? [];
    const deleted = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Copies',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b5', fingerprint: outline[4]?.fingerprint ?? '', new_content: '' }],
    });
    expect(isErrorResponse(deleted)).toBe(false);
    const added = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Copies',
      expected_revision: 2,
      edits: [{ type: 'insert', after: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'Top.' }],
    });
    expect(isErrorResponse(added)).toBe(false);
    const before = await readBody(callTool, 'Copies');

    const stale = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Copies',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b5', fingerprint: outline[4]?.fingerprint ?? '', new_content: 'Changed.' }],
    });
    expect(isErrorResponse(stale)).toBe(true);
    expect(await readBody(callTool, 'Copies')).toBe(before);
  });

  it('refuses with the current outline and leaves the breaker alone when the fingerprint is shared', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Twins', body: 'Alpha.\n\nSame.\n\nSame.' });
    const outline = (await listBlocks(callTool, 'Twins')).blocks ?? [];
    await moveFirstBlock(callTool, 'Twins');
    const before = await readBody(callTool, 'Twins');

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Twins',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: 'b3', fingerprint: outline[2]?.fingerprint ?? '', new_content: 'Last.' }],
      });
      expect(isErrorResponse(refused)).toBe(true);
      const parsed = resultJson(refused);
      expect(parsed.revision).toBe(2);
      expect(parsed.error).toContain('The space is at revision 2, not 1.');
      expect(parsed.blocks?.map(block => block.anchor)).toEqual(['b1', 'b2', 'b3']);
      expect(parsed.blocks?.[0]?.preview).toBe('Alpha, moved.');
    }
    expect(await readBody(callTool, 'Twins')).toBe(before);

    // Four refusals did not lock the space: the retry from the outline lands.
    const current = (await listBlocks(callTool, 'Twins')).blocks ?? [];
    const retried = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Twins',
      expected_revision: 2,
      edits: [{ type: 'block', anchor: 'b3', fingerprint: current[2]?.fingerprint ?? '', new_content: 'Last.' }],
    });
    expect(isErrorResponse(retried)).toBe(false);
  });

  it('a call at the current revision is unchanged and not marked stale', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Current', body: 'Alpha.\n\nBeta.' });
    const outline = (await listBlocks(callTool, 'Current')).blocks ?? [];
    const applied = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Current',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'Alpha, new.' }],
    });
    expect(isErrorResponse(applied)).toBe(false);
    expect(resultJson(applied).revision_was_stale).toBeUndefined();
    expect(resultJson(applied).summary).not.toContain('expected_revision');
  });

  it('an empty fingerprint reaches the handler and the refusal carries the outline', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Empty', body: 'Alpha.\n\nBeta.' });
    const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Empty',
      expected_revision: 1,
      edits: [{ type: 'insert', after: 'b2', fingerprint: '', new_content: 'Gamma.' }],
    });
    expect(isErrorResponse(refused)).toBe(true);
    const parsed = resultJson(refused);
    expect(parsed.error).toContain('Entry #1 names fingerprint ""');
    expect(parsed.error).toContain('use an append entry to add content at the end');
    expect(parsed.revision).toBe(1);
    expect(parsed.blocks?.map(block => block.anchor)).toEqual(['b1', 'b2']);
    expect(await readBody(callTool, 'Empty')).toBe('Alpha.\n\nBeta.');
  });

  it('a malformed fingerprint does not count toward the breaker', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Format', body: 'Alpha.' });
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Format',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: 'b1', fingerprint: 'ABC', new_content: 'x' }],
      });
      expect(resultJson(refused).blocks).toHaveLength(1);
    }
    const outline = (await listBlocks(callTool, 'Format')).blocks ?? [];
    const applied = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Format',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: outline[0]?.fingerprint ?? '', new_content: 'x' }],
    });
    expect(isErrorResponse(applied)).toBe(false);
  });

  it('a well-formed fingerprint over changed content still refuses without handing fingerprints back', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Changed', body: 'Alpha.' });
    const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Changed',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: 'b1', fingerprint: '00000000', new_content: 'x' }],
    });
    expect(isErrorResponse(refused)).toBe(true);
    expect(resultJson(refused).error).toContain('does not hold the content fingerprint');
    expect(resultJson(refused).blocks).toBeUndefined();
  });
});

describe('a block replacement may not drop saved table rows', () => {
  const header = ['# Breeds', '', '| Rank | Breed |', '| --- | --- |'];
  const breeds = ['Papillon', 'Rottweiler', 'Beagle', 'Poodle'];
  const rows = breeds.map((breed, index) => `| ${String(index + 1)} | ${breed} |`);

  async function seed() {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: [...header, ...rows].join('\n') });
    const blocks = (await listBlocks(callTool, 'Breeds')).blocks ?? [];
    const table = blocks[1];
    if (table === undefined) {
      throw new Error('expected a table block');
    }
    return { callTool, table, before: await readBody(callTool, 'Breeds') };
  }

  const replace = (
    callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
    table: SpaceWireBlock,
    new_content: string,
    extra: Record<string, unknown> = {},
  ) =>
    callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Breeds',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: table.anchor, fingerprint: table.fingerprint, new_content }],
      ...extra,
    });

  it('refuses rows without a header and leaves the body unchanged', async () => {
    const { callTool, table, before } = await seed();
    const refused = await replace(callTool, table, '| 5 | Collie |');
    expect(isErrorResponse(refused)).toBe(true);
    expect(resultJson(refused).error).toContain('no header');
    expect(resultJson(refused).error).toContain('append entry');
    expect(await readBody(callTool, 'Breeds')).toBe(before);
  });

  it('refuses a subset of the saved rows, naming the missing ones', async () => {
    const { callTool, table, before } = await seed();
    const refused = await replace(callTool, table, [...header.slice(2), rows[0]].join('\n'));
    expect(isErrorResponse(refused)).toBe(true);
    expect(resultJson(refused).error).toContain('would remove 3 rows');
    expect(resultJson(refused).error).toContain('| 2 | Rottweiler |');
    expect(await readBody(callTool, 'Breeds')).toBe(before);
  });

  it('applies the same subset with confirm_shrink', async () => {
    const { callTool, table } = await seed();
    const applied = await replace(callTool, table, [...header.slice(2), rows[0]].join('\n'), { confirm_shrink: true });
    expect(isErrorResponse(applied)).toBe(false);
    expect(await readBody(callTool, 'Breeds')).not.toContain('Rottweiler');
  });

  it('applies a replacement that keeps every row and changes cells', async () => {
    const { callTool, table } = await seed();
    const changed = [...header.slice(2), ...rows.map(row => `${row} good |`)].join('\n');
    const applied = await replace(callTool, table, changed);
    expect(isErrorResponse(applied)).toBe(false);
    expect(await readBody(callTool, 'Breeds')).toContain('| 2 | Rottweiler | good |');
  });

  it('leaves a paragraph replacement alone', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Breeds', body: ['# Breeds', '', 'Old note.'].join('\n') });
    const blocks = (await listBlocks(callTool, 'Breeds')).blocks ?? [];
    const note = blocks[1];
    if (note === undefined) {
      throw new Error('expected a paragraph block');
    }
    const applied = await replace(callTool, note, 'New note.');
    expect(isErrorResponse(applied)).toBe(false);
    expect(await readBody(callTool, 'Breeds')).toContain('New note.');
  });
});

describe('saved rows are compared across the whole body', () => {
  const pad = 'x'.repeat(40);
  const head = ['# Big', '', '| Breed | Group | Note |', '| --- | --- | --- |'];
  const makeRows = (names: string[]) => names.map(name => `| ${name} | herd | ${pad} |`);

  async function seedBig(names: string[], tableHead: string[] = head) {
    const { store, callTool } = makeHarness();
    await store.createSpace({
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'big',
      name: 'Big',
      purpose: 'Rows probe.',
      status: 'active',
      format: 'markdown',
      body: [...tableHead, ...makeRows(names)].join('\n'),
      expected_aggregate_revision: 0,
    });
    const blocks = (await listBlocks(callTool, 'Big')).blocks ?? [];
    return { callTool, blocks };
  }

  const edit = (
    callTool: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
    edits: Record<string, unknown>[],
    extra: Record<string, unknown> = {},
  ) => callTool(EDIT_SPACE_TOOL_NAME, { space_name: 'Big', expected_revision: 1, edits, ...extra });

  const names = Array.from({ length: 40 }, (_, index) => `Breed${String(index).padStart(2, '0')}`);

  function pick(blocks: SpaceWireBlock[], index: number): SpaceWireBlock {
    const block = blocks[index];
    if (block === undefined) {
      throw new Error('expected block');
    }
    return block;
  }

  it('applies a row moved from the second row block to the first', async () => {
    const { callTool, blocks } = await seedBig(names);
    const first = pick(blocks, 1);
    const second = pick(blocks, 2);
    const body = (await readBody(callTool, 'Big')).split('\n');
    const split = body.findIndex(line => line.startsWith(second.preview.slice(0, 12)));
    const moved = body[split];
    if (moved === undefined) {
      throw new Error('expected a row');
    }
    const firstContent = [...body.slice(2, split), moved].join('\n');
    const secondContent = body.slice(split + 1).join('\n');
    const applied = await edit(callTool, [
      { type: 'block', anchor: first.anchor, fingerprint: first.fingerprint, new_content: firstContent },
      { type: 'block', anchor: second.anchor, fingerprint: second.fingerprint, new_content: secondContent },
    ]);
    // The rows check lets the move through; the body reads the same, so it is the nothing-changed refusal.
    expect(resultJson(applied).error).toContain('This edit changes nothing');
  });

  it('applies a reverse sort across both row blocks', async () => {
    const { callTool, blocks } = await seedBig(names);
    const first = pick(blocks, 1);
    const second = pick(blocks, 2);
    const body = (await readBody(callTool, 'Big')).split('\n');
    const split = body.findIndex(line => line.startsWith(second.preview.slice(0, 12)));
    const reversed = body.slice(4).reverse();
    const half = reversed.length - (body.length - split);
    const applied = await edit(callTool, [
      {
        type: 'block',
        anchor: first.anchor,
        fingerprint: first.fingerprint,
        new_content: [...head.slice(2), ...reversed.slice(0, half)].join('\n'),
      },
      {
        type: 'block',
        anchor: second.anchor,
        fingerprint: second.fingerprint,
        new_content: reversed.slice(half).join('\n'),
      },
    ]);
    expect(resultJson(applied).error).toBeUndefined();
  });

  it('refuses dropping one of two rows that share a key', async () => {
    const { callTool, blocks } = await seedBig(['Same', 'Same', 'Other']);
    const table = pick(blocks, 1);
    const refused = await edit(callTool, [
      {
        type: 'block',
        anchor: table.anchor,
        fingerprint: table.fingerprint,
        new_content: [...head.slice(2), ...makeRows(['Same', 'Other'])].join('\n'),
      },
    ]);
    expect(resultJson(refused).error).toContain('would remove 1 row that is saved now: | Same | herd |');
    expect(resultJson(refused).error).toContain('confirm_shrink: true');
  });

  it('refuses emptying the header block even when rows are inserted elsewhere', async () => {
    const { callTool, blocks } = await seedBig(['A', 'B']);
    const table = pick(blocks, 1);
    const heading = pick(blocks, 0);
    const refused = await edit(callTool, [
      { type: 'block', anchor: table.anchor, fingerprint: table.fingerprint, new_content: '' },
      {
        type: 'insert',
        after: heading.anchor,
        fingerprint: heading.fingerprint,
        new_content: makeRows(['A', 'B']).join('\n'),
      },
    ]);
    expect(resultJson(refused).error).toContain('no header');
    expect(await readBody(callTool, 'Big')).toContain('| --- |');
  });

  it('applies deleting a whole one-block table with confirm_shrink', async () => {
    const { callTool, blocks } = await seedBig(['A', 'B']);
    const table = pick(blocks, 1);
    const applied = await edit(
      callTool,
      [{ type: 'block', anchor: table.anchor, fingerprint: table.fingerprint, new_content: '' }],
      { confirm_shrink: true },
    );
    expect(resultJson(applied).error).toBeUndefined();
  });

  it('applies deleting both blocks of a table with confirm_shrink', async () => {
    const { callTool, blocks } = await seedBig(names);
    const edits = [pick(blocks, 1), pick(blocks, 2)].map(block => ({
      type: 'block',
      anchor: block.anchor,
      fingerprint: block.fingerprint,
      new_content: '',
    }));
    const applied = await edit(callTool, edits, { confirm_shrink: true });
    expect(resultJson(applied).error).toBeUndefined();
    expect(await readBody(callTool, 'Big')).not.toContain('Breed00');
  });

  it('refuses replacing the header block of a two-block table with text, even when confirmed', async () => {
    const { callTool, blocks } = await seedBig(names);
    const first = pick(blocks, 1);
    const refused = await edit(
      callTool,
      [{ type: 'block', anchor: first.anchor, fingerprint: first.fingerprint, new_content: 'Gone.' }],
      { confirm_shrink: true },
    );
    expect(resultJson(refused).error).toContain('no header');
  });

  it('edits a code block that contains a pipe, and a table inside a fence', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, {
      name: 'Big',
      body: [
        '# Notes',
        '',
        '```',
        'cat log | grep error',
        '```',
        '',
        '```',
        '| a | b |',
        '| --- | --- |',
        '| x | y |',
        '```',
      ].join('\n'),
    });
    const blocks = (await listBlocks(callTool, 'Big')).blocks ?? [];
    const code = pick(blocks, 1);
    const fenced = pick(blocks, 2);
    const first = await edit(callTool, [
      {
        type: 'block',
        anchor: code.anchor,
        fingerprint: code.fingerprint,
        new_content: '```\ncat log | grep warn\n```',
      },
      {
        type: 'block',
        anchor: fenced.anchor,
        fingerprint: fenced.fingerprint,
        new_content: '```\n| a | b |\n| --- | --- |\n| z | y |\n```',
      },
    ]);
    expect(resultJson(first).error).toBeUndefined();
    expect(await readBody(callTool, 'Big')).toContain('| z | y |');
  });

  it.each([
    ['dashes without spaces', ['# Big', '', '|Breed|Note|', '|-|-|']],
    ['colon dashes', ['# Big', '', '| Breed | Note |', '|:--|:--|']],
    ['no closing pipes', ['# Big', '', '| Breed | Note', '| --- | ---']],
  ])('refuses rows without a header for a table with %s', async (_label, tableHead) => {
    const { callTool, blocks } = await seedBig(['A', 'B'], tableHead);
    const table = pick(blocks, 1);
    const refused = await edit(callTool, [
      { type: 'block', anchor: table.anchor, fingerprint: table.fingerprint, new_content: makeRows(['C']).join('\n') },
    ]);
    expect(resultJson(refused).error).toContain('no header');
    expect(resultJson(refused).error).not.toContain('confirm_shrink');
  });
});

describe('duplicate table rows are dropped and reported', () => {
  type CallTool = (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>;
  const rowsOf = (names: string[]): string[] => names.map(name => `| ${name} | note |`);
  const tableBody = ['| Breed | Note |', '| --- | --- |', ...rowsOf(['Beagle', 'Papillon', 'Rottweiler'])].join('\n');

  async function insertAfterLastBlock(input: { callTool: CallTool; name: string; rows: string[] }) {
    const blocks = (await listBlocks(input.callTool, input.name)).blocks ?? [];
    const last = blocks[blocks.length - 1];
    return input.callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: input.name,
      expected_revision: 1,
      edits: [
        {
          type: 'insert',
          after: last?.anchor ?? '',
          fingerprint: last?.fingerprint ?? '',
          new_content: input.rows.join('\n'),
        },
      ],
    });
  }

  /** Creates a space from `body`, then checks the saved body equals `expected`. */
  async function createAndRead(input: { name: string; body: string }) {
    const { callTool } = makeHarness();
    const created = await callTool(CREATE_SPACE_TOOL_NAME, {
      name: input.name,
      purpose: `${input.name} purpose.`,
      status: 'active',
      format: 'markdown',
      body: input.body,
    });
    expect(isErrorResponse(created)).toBe(false);
    return { created, saved: await readBody(callTool, input.name) };
  }

  it('an insert of 5 rows where 2 exist saves 3 and reports the 2', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Dogs', body: tableBody });
    const result = await insertAfterLastBlock({
      callTool,
      name: 'Dogs',
      rows: rowsOf(['Papillon', 'Poodle', 'Rottweiler', 'Collie', 'Pug']),
    });
    expect(isErrorResponse(result)).toBe(false);
    const wire: { summary: string; skipped_rows: { key: string; row: number }[] } = JSON.parse(resultText(result));
    expect(wire.skipped_rows).toEqual([
      { key: 'Papillon', row: 1 },
      { key: 'Rottweiler', row: 3 },
    ]);
    expect(wire.summary).toContain(
      'Skipped 2 rows that were already in the table: "Papillon" (row 1 of this call), "Rottweiler" (row 3 of this call).',
    );
    expect(await readBody(callTool, 'Dogs')).toBe([tableBody, ...rowsOf(['Poodle', 'Collie', 'Pug'])].join('\n'));
  });

  it('an insert where every row is already saved exactly is refused and saves nothing', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Dogs', body: tableBody });
    const result = await insertAfterLastBlock({ callTool, name: 'Dogs', rows: rowsOf(['Beagle', 'Papillon']) });
    expect(isErrorResponse(result)).toBe(true);
    expect(resultJson(result).error).toContain('Every row in this call is already in the table, so nothing was saved.');
    expect(await readBody(callTool, 'Dogs')).toBe(tableBody);
  });

  it('a distinct row that shares its first cell with a saved row is kept on insert', async () => {
    const { callTool } = makeHarness();
    const body = ['| Day | Time | Item |', '| --- | --- | --- |', '| Monday | 9am | Gym |'].join('\n');
    await createSpace(callTool, { name: 'Week', body });
    const result = await insertAfterLastBlock({ callTool, name: 'Week', rows: ['| Monday | 2pm | Dentist |'] });
    expect(isErrorResponse(result)).toBe(false);
    expect(await readBody(callTool, 'Week')).toBe(`${body}\n| Monday | 2pm | Dentist |`);
  });

  it('a create with an identical row sent twice saves it once, and whole-cell emphasis does not hide it', async () => {
    const body = [
      '| Breed | Note |',
      '| --- | --- |',
      '| Beagle | note |',
      '| Pug | note |',
      '| **Beagle** |  note |',
    ].join('\n');
    const { created, saved } = await createAndRead({ name: 'Twice', body });
    expect(resultText(created)).toContain(
      'Skipped 1 row that was already in the table: \\"**Beagle**\\" (row 3 of this call).',
    );
    expect(saved).toBe(['| Breed | Note |', '| --- | --- |', '| Beagle | note |', '| Pug | note |'].join('\n'));
  });

  it('a resent ranked row is dropped, and rows differing only in rank are kept', async () => {
    const body = [
      '| Rank | Breed | Year |',
      '| --- | --- | --- |',
      '| 1 | Beagle | 2020 |',
      '| 2 | Beagle | 2021 |',
      '| 2 | Pug | 2021 |',
      '| 1 | Beagle | 2020 |',
    ].join('\n');
    const { saved } = await createAndRead({ name: 'Ranked', body });
    expect(saved).toBe(body.split('\n').slice(0, 5).join('\n'));
  });

  it.each([
    ['same first cell, other cells differ', ['| Monday | 9am | Gym |', '| Monday | 2pm | Dentist |']],
    ['a category repeated', ['| Fruit | Apple |', '| Fruit | Pear |']],
    ['rank in the second cell', ['| 1 | Beagle | 2020 |', '| 2 | Beagle | 2021 |']],
    ['names that differ only in case', ['| Ab | one |', '| AB | two |']],
    ['emphasis around a word with other cells', ['| run | to move fast |', '| **run** | to operate |']],
    ['underscores inside a word', ['| my_var | a |', '| myvar | b |']],
  ])('distinct rows are all kept: %s', async (_label, rows) => {
    const body = ['| A | B | C |', '| --- | --- | --- |', ...rows].join('\n');
    const { saved } = await createAndRead({ name: 'Distinct', body });
    expect(saved).toBe(body);
  });

  it('a table with no header keeps distinct rows, and rows in a code fence are never compared', async () => {
    const body = ['| a | 1 |', '| a | 2 |', '', '```', '| x | 1 |', '| x | 1 |', '```'].join('\n');
    const { saved } = await createAndRead({ name: 'Headerless', body });
    expect(saved).toBe(body);
  });

  it('the same row in two separate tables is not a duplicate', async () => {
    const body = [
      '| Breed |',
      '| --- |',
      '| Beagle |',
      '',
      'Other list:',
      '',
      '| Breed |',
      '| --- |',
      '| Beagle |',
    ].join('\n');
    const { saved } = await createAndRead({ name: 'Two tables', body });
    expect(saved).toBe(body);
  });

  it('an insert is measured against the write cap after saved rows are dropped', async () => {
    const { callTool } = makeHarness();
    const wide = 'x'.repeat(90);
    const many = Array.from({ length: 50 }, (_, i) => `| Breed number ${String(i)} | ${wide} |`);
    await createSpace(callTool, {
      name: 'Big',
      body: ['| Breed | Note |', '| --- | --- |', ...many.slice(0, 30)].join('\n'),
    });
    const grown = await insertAfterLastBlock({ callTool, name: 'Big', rows: many.slice(30) });
    expect(isErrorResponse(grown)).toBe(false);
    const body = await readBody(callTool, 'Big');
    // Resending all 50 saved rows plus 3 new is over the cap as sent, and 3 rows as new content.
    const fresh = Array.from({ length: 3 }, (_, i) => `| Fresh ${String(i)} | new |`);
    const blocks = (await listBlocks(callTool, 'Big')).blocks ?? [];
    const last = blocks[blocks.length - 1];
    const result = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Big',
      expected_revision: 2,
      edits: [
        {
          type: 'insert',
          after: last?.anchor ?? '',
          fingerprint: last?.fingerprint ?? '',
          new_content: [...many, ...fresh].join('\n'),
        },
      ],
    });
    expect(isErrorResponse(result)).toBe(false);
    expect(await readBody(callTool, 'Big')).toBe(`${body}\n${fresh.join('\n')}`);
  });

  describe('an over-cap insert never counts toward the breaker', () => {
    const bigRows = Array.from({ length: 330 }, (_, i) => `| Row ${String(i)} | ${'y'.repeat(14)} |`).join('\n');

    async function threeBigRefusalsThenValidEdit(input: { anchor: string; expected_revision: number }) {
      const { callTool } = makeHarness();
      await createSpace(callTool, { name: 'Guarded', body: tableBody });
      const blocks = (await listBlocks(callTool, 'Guarded')).blocks ?? [];
      const last = blocks[blocks.length - 1];
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const refused = await callTool(EDIT_SPACE_TOOL_NAME, {
          space_name: 'Guarded',
          expected_revision: input.expected_revision,
          edits: [
            {
              type: 'insert',
              after: input.anchor || (last?.anchor ?? ''),
              fingerprint: last?.fingerprint ?? '',
              new_content: bigRows,
            },
          ],
        });
        expect(isErrorResponse(refused)).toBe(true);
        // A lone over-cap insert could be cut to what fits, so it gets the real refusal, uncounted.
        expect(resultText(refused)).toMatch(/not 99|Unknown block anchor/);
      }
      const landed = await insertAfterLastBlock({ callTool, name: 'Guarded', rows: ['| Fresh | note |'] });
      expect(isErrorResponse(landed)).toBe(false);
      expect(await readBody(callTool, 'Guarded')).toBe(`${tableBody}\n| Fresh | note |`);
    }

    it('three stale over-cap inserts do not lock the space', async () => {
      await threeBigRefusalsThenValidEdit({ anchor: '', expected_revision: 99 });
    });

    it('three over-cap inserts with a bad anchor do not lock the space', async () => {
      await threeBigRefusalsThenValidEdit({ anchor: 'b99', expected_revision: 1 });
    });
  });
});

describe('nothing-changed refusal and format notes', () => {
  const TABLE = ['| Breed | Size |', '| --- | --- |', '| Beagle | Small |'].join('\n');

  it('refuses an edit that leaves the space as it is and keeps the revision', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Dogs', body: '# Dogs\n\nHello.' });
    const blocks = (await listBlocks(callTool, 'Dogs')).blocks ?? [];
    const second = blocks[1];
    const edited = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dogs',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: second?.anchor, fingerprint: second?.fingerprint, new_content: 'Hello.' }],
    });
    expect(isErrorResponse(edited)).toBe(true);
    expect(resultJson(edited).error).toContain('This edit changes nothing');
    expect((await listBlocks(callTool, 'Dogs')).revision).toBe(1);
  });

  it('does not count the refusal as a failed delta', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Dogs', body: '# Dogs\n\nHello.' });
    const second = ((await listBlocks(callTool, 'Dogs')).blocks ?? [])[1];
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await callTool(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dogs',
        expected_revision: 1,
        edits: [{ type: 'block', anchor: second?.anchor, fingerprint: second?.fingerprint, new_content: 'Hello.' }],
      });
    }
    const changed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dogs',
      expected_revision: 1,
      edits: [{ type: 'block', anchor: second?.anchor, fingerprint: second?.fingerprint, new_content: 'Bye.' }],
    });
    expect(isErrorResponse(changed)).toBe(false);
  });

  it('accepts an edit that changes only metadata', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Dogs', body: '# Dogs\n\nHello.' });
    const second = ((await listBlocks(callTool, 'Dogs')).blocks ?? [])[1];
    const renamed = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dogs',
      expected_revision: 1,
      new_title: 'Hounds',
      edits: [{ type: 'block', anchor: second?.anchor, fingerprint: second?.fingerprint, new_content: 'Hello.' }],
    });
    expect(isErrorResponse(renamed)).toBe(false);
  });

  it('carries format_notes on read and write results', async () => {
    const { callTool } = makeHarness();
    await createSpace(callTool, { name: 'Dogs', body: TABLE });
    const table = (await listBlocks(callTool, 'Dogs')).blocks?.[0];
    // A block entry is not deduplicated, so it can leave a repeated row for the note to name.
    const edited = await callTool(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dogs',
      expected_revision: 1,
      edits: [
        {
          type: 'block',
          anchor: table?.anchor,
          fingerprint: table?.fingerprint,
          new_content: `${TABLE}\n| Beagle | Small |`,
        },
      ],
    });
    const noteOf = (response: CallToolResponse): unknown => JSON.parse(resultText(response)).format_notes;
    expect(noteOf(edited)).toEqual([expect.stringContaining('Beagle')]);
    expect(noteOf(await callTool(GET_SPACE_TOOL_NAME, { space_name: 'Dogs' }))).toEqual([
      expect.stringContaining('Beagle'),
    ]);
    expect(noteOf(await callTool(LIST_BLOCKS_TOOL_NAME, { space_name: 'Dogs' }))).toEqual([
      expect.stringContaining('Beagle'),
    ]);
    await createSpace(callTool, { name: 'Clean', body: TABLE });
    expect(noteOf(await callTool(GET_SPACE_TOOL_NAME, { space_name: 'Clean' }))).toEqual([]);
  });
});
