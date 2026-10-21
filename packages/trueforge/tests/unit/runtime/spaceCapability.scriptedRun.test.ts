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
  LIST_SPACES_TOOL_NAME,
  UPDATE_SPACE_TOOL_NAME,
} from '@truefoundry/trueforge-core/core/spaces/toolContract';
import type { SpaceRecord } from '../../../src/db/spaceStore';
import { spaceCapability, type SpaceToolStore } from '../../../src/runtime/spaceCapability';

/**
 * The owner's Oct 21 request, run as a scripted model: the calls a well-behaved model makes,
 * with each later call built from what the earlier results said. The point is the id: it comes
 * from the create result's summary and is reused for every block update, with no list or guess.
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

describe('scripted run: top ten dog breeds', () => {
  it('creates a skeleton, keeps the id from the create result, fills each block, and reads it back by name', async () => {
    const capability = spaceCapability({ store: makeStore(), authority: AUTHORITY, tracing: NOOP_TRACING });
    const toolSet = capability.systemToolSets?.[0];
    if (toolSet === undefined) {
      throw new Error('expected space tool set');
    }
    const call = (name: string, args: Record<string, unknown>) => toolSet.callTool({ name, arguments: args });

    // Step 1: check for an existing space before creating one.
    const listed = JSON.parse(textOf(await call(LIST_SPACES_TOOL_NAME, {}))) as { spaces: unknown[] };
    expect(listed.spaces).toEqual([]);

    // Step 2: the skeleton. The id is read from the summary, the first key of the result.
    const created = JSON.parse(
      textOf(
        await call(CREATE_SPACE_TOOL_NAME, {
          name: 'Dog breeds',
          purpose: 'Top ten dog breeds by intelligence, with other traits.',
          status: 'active',
          format: 'markdown',
          body: SKELETON_BODY,
        }),
      ),
    ) as { summary: string };
    const idMatch = /^Created space "Dog breeds" \(id: ([0-9a-z]+), revision 1\)\.$/.exec(created.summary);
    expect(idMatch).not.toBeNull();
    const spaceId = idMatch?.[1] ?? '';

    // Step 3: one block per update_space call, all with the same id.
    for (const [index, breed] of BREEDS.entries()) {
      const revision = index + 2;
      const update = JSON.parse(
        textOf(
          await call(UPDATE_SPACE_TOOL_NAME, {
            space_id: spaceId,
            block_edits: [
              {
                anchor: `breed-${String(index + 1)}`,
                new_content: [
                  `## ${String(index + 1)}. ${breed}`,
                  `- Intelligence rank: ${String(index + 1)} of 10`,
                ].join('\n'),
              },
            ],
          }),
        ),
      ) as { summary: string };
      expect(update.summary).toBe(`Updated space "Dog breeds" (id: ${spaceId}, revision ${String(revision)}).`);
    }

    // Step 4: read it back by name, the way a model does after losing the id.
    const read = JSON.parse(textOf(await call(GET_SPACE_TOOL_NAME, { space_name: 'Dog breeds' }))) as {
      space: { id: string; body: string; revision: number };
    };
    expect(read.space.id).toBe(spaceId);
    expect(read.space.revision).toBe(BREEDS.length + 1);
    BREEDS.forEach((breed, index) => {
      expect(read.space.body).toContain(`## ${String(index + 1)}. ${breed}`);
    });
    expect(read.space.body).not.toContain('(to fill)');

    // Step 5: the final reply is plain prose with no markup in it.
    const finalReply = `I made "Dog breeds" with the top ten by intelligence. The Border Collie ranks first.`;
    for (const marker of RAW_MARKERS) {
      expect(finalReply).not.toContain(marker);
      expect(read.space.body).not.toContain(marker);
    }
  });
});
