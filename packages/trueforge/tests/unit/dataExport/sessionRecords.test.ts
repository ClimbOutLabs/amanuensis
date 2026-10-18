import type { TurnSnapshot } from '@truefoundry/trueforge-core/agent-session';
import { EventType } from '@truefoundry/trueforge-core/core';
import { makeModelMessageEvent } from '../../../../trueforge-core/tests/agent-session/testHelpers';

import {
  exportableEvents,
  exportedThreads,
  sessionPartIndex,
  sessionPartName,
  withoutDeploymentBoundFields,
} from '../../../src/dataExport/sessionRecords';

describe('withoutDeploymentBoundFields', () => {
  it('removes approval token ids, sandbox info and OAuth links at any depth, keeping the rest', () => {
    const out = withoutDeploymentBoundFields({
      session_id: 's1',
      turns: [
        {
          snapshot: { sandbox_info: { sandbox_id: 'box' }, mcp_servers: null },
          context: [
            { role: 'assistant', tool_calls: [{ id: 'c1', approval_token_id: 'tok', function: { name: 'f' } }] },
          ],
        },
      ],
      events: [{ type: 'mcp.auth_required', mcp_servers: [{ id: 'a', name: 'n', auth_url: 'https://x/y?state=z' }] }],
    });
    expect(out).toEqual({
      session_id: 's1',
      turns: [
        {
          snapshot: { mcp_servers: null },
          context: [{ role: 'assistant', tool_calls: [{ id: 'c1', function: { name: 'f' } }] }],
        },
      ],
      events: [{ type: 'mcp.auth_required', mcp_servers: [{ id: 'a', name: 'n' }] }],
    });
  });
});

describe('exportableEvents', () => {
  it('drops sandbox creation events and keeps every other event', () => {
    const message = makeModelMessageEvent();
    const sandbox = {
      type: EventType.SANDBOX_CREATED,
      id: 'evt',
      created_at: '2026-10-16T00:00:00.000Z',
      sandbox_id: 'box',
      thread_id: null,
    };
    expect(exportableEvents([message, sandbox])).toEqual([message]);
  });
});

function snapshot(context: { role: 'user' | 'assistant'; content: string }[]): TurnSnapshot {
  return {
    threads: {
      main: {
        thread_id: 'main',
        context,
        current_context_usage: { prompt_tokens: 1, completion_tokens: 1 },
        parent: null,
        agent_info: null,
        completion: null,
        capability_state: null,
        tool_call_memo: undefined,
        task_state: undefined,
      },
    },
    mcp_servers: null,
    sandbox_info: null,
  };
}

describe('exportedThreads', () => {
  const first = { role: 'user' as const, content: 'first question' };
  const reply = { role: 'assistant' as const, content: 'first answer' };
  const second = { role: 'user' as const, content: 'second question' };

  it('keeps only the messages a turn added, and leaves runtime bookkeeping out', () => {
    const threads = exportedThreads({ snapshot: snapshot([first, reply, second]), previous: snapshot([first, reply]) });
    expect(threads).toEqual({
      main: {
        thread_id: 'main',
        context_base: 2,
        context: [second],
        current_context_usage: { prompt_tokens: 1, completion_tokens: 1 },
        parent: null,
        agent_info: null,
        completion: null,
        task_state: undefined,
      },
    });
  });

  it('writes a rewritten context from the first message that changed', () => {
    const summary = { role: 'user' as const, content: 'summary of the chat' };
    const threads = exportedThreads({ snapshot: snapshot([summary, second]), previous: snapshot([first, reply]) });
    expect(threads['main']).toMatchObject({ context_base: 0, context: [summary, second] });
  });

  it('writes the first turn in full', () => {
    expect(exportedThreads({ snapshot: snapshot([first]), previous: undefined })['main']).toMatchObject({
      context_base: 0,
      context: [first],
    });
  });
});

describe('sessionPartName', () => {
  it('numbers the files so they sort and read back in order', () => {
    expect(sessionPartName(1)).toBe('sessions/0001.json');
    expect(sessionPartName(12345)).toBe('sessions/12345.json');
    expect(sessionPartIndex('sessions/0012.json')).toBe(12);
    expect(sessionPartIndex('sessions.json')).toBeUndefined();
    expect(sessionPartIndex('sessions/notes.json')).toBeUndefined();
  });
});
