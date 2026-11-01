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
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import type { SpaceRecord } from '../../../src/db/spaceStore';
import { spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';
import { isRecord } from '../../fixtures/jsonGuards';

/**
 * The owner's Oct 21 request, run as a scripted model: the calls a well-behaved model makes,
 * with each later call built from what the earlier results said. The point is the name: it comes
 * from the create result, which gives the name and link and never an id, and the exact name
 * addresses every block edit, with no list or guess.
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

/** Top ten breeds in Stanley Coren's intelligence ranking (The Intelligence of Dogs, 1994). */
const BREEDS = [
  'Border Collie',
  'Poodle',
  'German Shepherd',
  'Golden Retriever',
  'Doberman Pinscher',
  'Shetland Sheepdog',
  'Labrador Retriever',
  'Papillon',
  'Rottweiler',
  'Australian Cattle Dog',
];

const SKELETON_BODY = [
  '# Dog breeds',
  '',
  'Top ten by working and obedience intelligence.',
  '',
  ...BREEDS.flatMap((_breed, index) => [`<!-- @block:breed-${String(index + 1)} -->`, '(to fill)', '']),
];

/** Raw markup that must never reach the person: a stray tool-call tag or a reasoning close tag. */
const RAW_MARKERS = ['<tool_call>', '</tool_call>', '<think>', '</think>'];

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

/** Guards for tool-result JSON, so the test never leans on an assertion escape. */
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
      throw new Error('not used in this run');
    },
    getSpace: async input => rows.get(input.space_id),
    getSpaceRevision: async () => undefined,
    listSpacesWithAggregate: async () => ({
      records: [...rows.values()],
      aggregate_revision: aggregate,
      has_more: false,
      next_offset: null,
    }),
  };
}

/** The fingerprints the get_space outline shows, by anchor: what a model's edits name back. */
async function outlineFingerprints(
  call: (name: string, args: Record<string, unknown>) => Promise<CallToolResponse>,
  spaceName: string,
): Promise<Map<string, string>> {
  const read = parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: spaceName })));
  const blocks = read['blocks'];
  if (!Array.isArray(blocks)) {
    throw new Error('expected a blocks list in the get_space result');
  }
  const fingerprints = new Map<string, string>();
  for (const block of blocks) {
    if (isRecord(block)) {
      fingerprints.set(stringField(block, 'anchor'), stringField(block, 'fingerprint'));
    }
  }
  return fingerprints;
}

describe('scripted run: top ten dog breeds', () => {
  it('creates a skeleton, fills each block first try, reads it back, then turns it into a full table first try', async () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: AUTHORITY,
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }
    const call = (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });

    // Step 1: check for an existing space before creating one.
    const listed = parsedObject(textOf(await call(LIST_SPACES_TOOL_NAME, {})));
    expect(listed['spaces']).toEqual([]);

    // Step 2: the skeleton. The create result gives the name and link, never an id, and the
    // call succeeds on the first try: no refusal, no retry.
    const createdResponse = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Dog breeds',
      purpose: 'Top ten dog breeds by intelligence, with other traits.',
      status: 'active',
      format: 'markdown',
      body: SKELETON_BODY.join('\n'),
    });
    expect(isErrorResponse(createdResponse)).toBe(false);
    const createdText = textOf(createdResponse);
    const created = parsedObject(createdText);
    const createdSpace = fieldObject(created, 'space');
    expect(stringField(created, 'summary')).toBe('Created space "Dog breeds" (revision 1).');
    expect(stringField(createdSpace, 'name')).toBe('Dog breeds');
    expect(stringField(createdSpace, 'link')).toMatch(/^\/spaces\/[^/]+$/);
    expect(createdText).not.toContain('"id"');
    expect(createdText).not.toContain('(id:');

    // Step 3: one block per edit_space call, all addressed by the exact name, each
    // succeeding first try. The outline from the create revision supplies every
    // block's fingerprint; each call names the revision its read showed.
    const skeletonFingerprints = await outlineFingerprints(call, 'Dog breeds');
    for (const [index, breed] of BREEDS.entries()) {
      const revision = index + 2;
      const anchor = `breed-${String(index + 1)}`;
      const updateResponse = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Dog breeds',
        expected_revision: index + 1,
        edits: [
          {
            type: 'block',
            anchor,
            fingerprint: skeletonFingerprints.get(anchor) ?? '',
            new_content: [`## ${String(index + 1)}. ${breed}`, `- Intelligence rank: ${String(index + 1)} of 10`].join(
              '\n',
            ),
          },
        ],
      });
      expect(isErrorResponse(updateResponse)).toBe(false);
      const update = parsedObject(textOf(updateResponse));
      expect(stringField(update, 'summary')).toBe(`Updated space "Dog breeds" (revision ${String(revision)}).`);
    }

    // Step 4: read it back by name.
    const read = fieldObject(
      parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' }))),
      'space',
    );
    expect(numberField(read, 'revision')).toBe(BREEDS.length + 1);
    BREEDS.forEach((breed, index) => {
      expect(stringField(read, 'body')).toContain(`## ${String(index + 1)}. ${breed}`);
    });
    expect(stringField(read, 'body')).not.toContain('(to fill)');

    // Step 5: turn the filled sections into a summary table in ONE edit_space call at
    // the revision the read showed: the first section's block becomes the table and
    // the other nine are deleted in the same call, first try, no refusal, no retry.
    // There is no whole-body tool and no search entry: blocks are the only way in.
    const tableText = [
      '| Rank | Breed |',
      '| --- | --- |',
      ...BREEDS.map((breed, index) => `| ${String(index + 1)} | ${breed} |`),
    ].join('\n');
    const filledFingerprints = await outlineFingerprints(call, 'Dog breeds');
    const replacedResponse = await call(EDIT_SPACE_TOOL_NAME, {
      space_name: 'Dog breeds',
      purpose: 'Top ten dog breeds by intelligence, with other traits.',
      expected_revision: BREEDS.length + 1,
      edits: BREEDS.map((_breed, index) => {
        const anchor = `breed-${String(index + 1)}`;
        return {
          type: 'block',
          anchor,
          fingerprint: filledFingerprints.get(anchor) ?? '',
          new_content: index === 0 ? tableText : '',
        };
      }),
    });
    expect(isErrorResponse(replacedResponse)).toBe(false);
    const replacedText = textOf(replacedResponse);
    const replaced = parsedObject(replacedText);
    expect(stringField(replaced, 'summary')).toBe('Updated space "Dog breeds" (revision 12).');
    expect(replacedText).not.toContain('"id"');
    expect(replacedText).not.toContain('(id:');

    // Step 6: read it back again: the preamble and the one remaining marker frame the
    // table; every filled section is gone.
    const reread = fieldObject(
      parsedObject(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' }))),
      'space',
    );
    expect(numberField(reread, 'revision')).toBe(BREEDS.length + 2);
    const finalBody = stringField(reread, 'body');
    expect(finalBody.startsWith('# Dog breeds\n\nTop ten by working and obedience intelligence.')).toBe(true);
    BREEDS.forEach((breed, index) => {
      expect(finalBody).toContain(`| ${String(index + 1)} | ${breed} |`);
    });
    expect(finalBody).not.toContain('(to fill)');
    expect(finalBody).not.toContain('Intelligence rank:');
    expect(finalBody).toContain('<!-- @block:breed-1 -->');
    expect(finalBody).not.toContain('@block:breed-2');

    // Step 7: the final reply is plain prose with no markup in it.
    const finalReply = `I made "Dog breeds" with the top ten by intelligence. The Border Collie ranks first.`;
    for (const marker of RAW_MARKERS) {
      expect(finalReply).not.toContain(marker);
      expect(stringField(reread, 'body')).not.toContain(marker);
    }
  });
});

describe('scripted run: a 40-row table built by create plus appends', () => {
  it('completes with no reads, no fingerprints, and no refused call', async () => {
    const capability = spaceCapability({
      store: makeStore(),
      authority: AUTHORITY,
      tracing: NOOP_TRACING,
      webSearch: createWebSearchTurnState(),
    });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }
    const calls: string[] = [];
    const call = (name: string, args: Record<string, unknown>) => {
      calls.push(name);
      return toolSet.callTool({ name, arguments: args });
    };
    const rowFor = (number: number) => `| Breed ${String(number).padStart(2, '0')} | Calm | Moderate | Good |`;
    const rows = Array.from({ length: 40 }, (_unused, index) => rowFor(index + 1));
    const header = ['# Smart dogs', '', '| Breed | Temperament | Exercise | Apartment |', '| --- | --- | --- | --- |'];

    const created = await call(CREATE_SPACE_TOOL_NAME, {
      name: 'Smart dogs',
      purpose: 'Forty smart dog breeds.',
      status: 'active',
      format: 'markdown',
      body: [...header, ...rows.slice(0, 10)].join('\n'),
    });
    expect(isErrorResponse(created)).toBe(false);

    // Each append names only the revision the last result showed and the new rows.
    let revision = numberField(fieldObject(parsedObject(textOf(created)), 'space'), 'revision');
    for (let start = 10; start < 40; start += 10) {
      const appended = await call(EDIT_SPACE_TOOL_NAME, {
        space_name: 'Smart dogs',
        expected_revision: revision,
        edits: [{ type: 'append', new_content: rows.slice(start, start + 10).join('\n') }],
      });
      expect(isErrorResponse(appended)).toBe(false);
      revision = numberField(fieldObject(parsedObject(textOf(appended)), 'space'), 'revision');
    }

    expect(calls).toEqual([CREATE_SPACE_TOOL_NAME, EDIT_SPACE_TOOL_NAME, EDIT_SPACE_TOOL_NAME, EDIT_SPACE_TOOL_NAME]);
    // The check read goes around `call` so it is not counted as part of the model's run.
    const read = fieldObject(
      parsedObject(
        textOf(await toolSet.callTool({ name: GET_SPACE_TOOL_NAME, arguments: { space_name: 'Smart dogs' } })),
      ),
      'space',
    );
    expect(stringField(read, 'body')).toBe([...header, ...rows].join('\n'));
  });
});
