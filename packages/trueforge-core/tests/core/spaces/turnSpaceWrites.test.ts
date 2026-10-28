import type { ContextMessage } from '../../../src/core/runtime/AgentThread.types';
import { spaceClosingLine, spaceWritesThisTurn } from '../../../src/core/spaces/turnSpaceWrites';

const DOGS_LINK = '/spaces/space_dogs';

function call(id: string, name: string, args: Record<string, unknown>): ContextMessage {
  return {
    role: 'assistant',
    content: null,
    tool_calls: [
      {
        id,
        type: 'function',
        function: { name, arguments: JSON.stringify(args) },
        tool_info: {
          type: 'mcp',
          mcp_server_id: 'space',
          mcp_server_name: 'space',
          original_tool_name: name,
          is_approval_required: false,
          is_client_side: false,
        },
      },
    ],
  };
}

function saved(id: string, name = 'Dog breeds', link = DOGS_LINK): ContextMessage {
  return {
    role: 'tool',
    tool_call_id: id,
    content: JSON.stringify({ summary: `Updated space "${name}" (revision 2).`, space: { name, link } }),
  };
}

function refused(id: string): ContextMessage {
  return { role: 'tool', tool_call_id: id, content: JSON.stringify({ error: 'The page changed. Read it again.' }) };
}

const user: ContextMessage = { role: 'user', content: 'Build a dog breeds page.' };

describe('spaceWritesThisTurn', () => {
  it('counts saved writes per space after the last person message', () => {
    const writes = spaceWritesThisTurn([
      call('old', 'edit_space', { space_name: 'Dog breeds' }),
      saved('old'),
      user,
      call('c1', 'create_space', { name: 'Dog breeds' }),
      saved('c1'),
      call('c2', 'edit_space', { space_name: 'Dog breeds' }),
      saved('c2'),
      call('r1', 'get_space', { space_name: 'Dog breeds' }),
      saved('r1'),
    ]);
    expect(writes).toEqual([{ name: 'Dog breeds', link: DOGS_LINK, created: true, changes: 2, last_failed: false }]);
  });

  it('marks a space whose last write was refused, and clears it after a later save', () => {
    const failedLast = spaceWritesThisTurn([
      user,
      call('c1', 'edit_space', { space_name: 'Dog breeds' }),
      saved('c1'),
      call('c2', 'edit_space', { space_name: 'Dog breeds' }),
      refused('c2'),
    ]);
    expect(failedLast[0]).toMatchObject({ changes: 1, last_failed: true });
    const recovered = spaceWritesThisTurn([
      user,
      call('c1', 'edit_space', { space_name: 'Dog breeds' }),
      refused('c1'),
      call('c2', 'edit_space', { space_name: 'Dog breeds' }),
      saved('c2'),
    ]);
    expect(recovered[0]).toMatchObject({ changes: 1, last_failed: false });
  });

  it('finds the result inside the tool response envelope', () => {
    const writes = spaceWritesThisTurn([
      user,
      call('c1', 'edit_space', { space_name: 'Dog breeds' }),
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: JSON.stringify({
          schema_version: 'tool.response.v2',
          result: { space: { name: 'Dog breeds', link: DOGS_LINK } },
        }),
      },
    ]);
    expect(writes).toHaveLength(1);
  });

  it('returns nothing when no space was written', () => {
    expect(spaceWritesThisTurn([user, call('r1', 'get_space', {}), saved('r1')])).toEqual([]);
  });
});

describe('spaceClosingLine', () => {
  const edits = { name: 'Dog breeds', link: DOGS_LINK, created: false, changes: 3, last_failed: false };

  it('says how many changes were saved', () => {
    expect(spaceClosingLine({ writes: [edits], unfinished: undefined })).toBe(
      `I saved 3 changes to the space [Dog breeds](${DOGS_LINK}).`,
    );
  });

  it('says a space was created', () => {
    expect(spaceClosingLine({ writes: [{ ...edits, created: true, changes: 1 }], unfinished: undefined })).toBe(
      `I created the space [Dog breeds](${DOGS_LINK}).`,
    );
  });

  it('adds the refused wording when the last write failed', () => {
    expect(spaceClosingLine({ writes: [{ ...edits, last_failed: true }], unfinished: undefined })).toContain(
      'My last change to it was refused, so the page may be incomplete. Ask me to finish it.',
    );
  });

  it('adds the continue wording when the reply ended by the step budget', () => {
    expect(spaceClosingLine({ writes: [edits], unfinished: 'budget' })).toContain(
      'I stopped before the page was complete. Ask me to continue.',
    );
  });

  it('is empty without writes', () => {
    expect(spaceClosingLine({ writes: [], unfinished: 'budget' })).toBe('');
  });
});
