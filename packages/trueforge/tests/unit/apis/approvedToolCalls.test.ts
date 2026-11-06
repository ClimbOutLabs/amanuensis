import { EventType, type PersistedTurnEvent, type TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import winston from 'winston';
import { approvedToolCalls, toolCallKey } from '../../../src/apis/approvedToolCalls';

const NOW = '2026-10-31T12:00:00.000Z';

function modelMessage({
  id,
  threadId,
  callIds,
}: {
  id: string;
  threadId: string;
  callIds: string[];
}): PersistedTurnEvent {
  return {
    type: EventType.MODEL_MESSAGE,
    id,
    thread_id: threadId,
    created_at: NOW,
    content: null,
    tool_calls: callIds.map(callId => ({
      id: callId,
      type: 'function',
      function: { name: 'Email__send_email', arguments: '{}' },
      tool_info: { type: 'truefoundry-system', name: 'Email__send_email' },
    })),
  };
}

function allow({ threadId, callId }: { threadId: string; callId: string }): TurnInputItem {
  return {
    type: EventType.USER_TOOL_APPROVAL,
    thread_id: threadId,
    tool_call_id: callId,
    approval: { status: 'allow' },
  };
}

function turnWith(pages: PersistedTurnEvent[][]) {
  const listEvents = jest.fn(({ page_token }: { page_token?: string | undefined }) => {
    const index = page_token === undefined ? 0 : Number(page_token);
    return Promise.resolve({
      data: pages[index] ?? [],
      pagination: index + 1 < pages.length ? { limit: 100, next_page_token: String(index + 1) } : { limit: 100 },
    });
  });
  return { turn: { listEvents }, listEvents };
}

const logger = winston.createLogger({ silent: true });

describe('approvedToolCalls', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('names a call by its thread as well as its id', async () => {
    const { turn } = turnWith([
      [
        modelMessage({ id: 'e2', threadId: 'sub', callIds: ['c1'] }),
        modelMessage({ id: 'e1', threadId: 'main', callIds: ['c1'] }),
      ],
    ]);
    const calls = await approvedToolCalls({
      pausedTurn: turn,
      input: [allow({ threadId: 'sub', callId: 'c1' })],
      logger,
    });
    expect([...calls.keys()]).toEqual([toolCallKey({ threadId: 'sub', callId: 'c1' })]);
  });

  it('stops reading once every allowed call is found', async () => {
    const { turn, listEvents } = turnWith([
      [modelMessage({ id: 'e9', threadId: 'main', callIds: ['c1'] })],
      [modelMessage({ id: 'e1', threadId: 'main', callIds: ['c0'] })],
    ]);
    await approvedToolCalls({ pausedTurn: turn, input: [allow({ threadId: 'main', callId: 'c1' })], logger });
    expect(listEvents).toHaveBeenCalledTimes(1);
  });

  it('finds a call far back in a long paused turn, with no page limit but the turn itself', async () => {
    const filler = (page: number) =>
      Array.from({ length: 100 }, (_unused, index) =>
        modelMessage({ id: `f${String(page)}-${String(index)}`, threadId: 'main', callIds: [] }),
      );
    const { turn, listEvents } = turnWith([
      filler(0),
      filler(1),
      filler(2),
      filler(3),
      [modelMessage({ id: 'first', threadId: 'main', callIds: ['c1'] })],
    ]);
    const calls = await approvedToolCalls({
      pausedTurn: turn,
      input: [allow({ threadId: 'main', callId: 'c1' })],
      logger,
    });
    expect(calls.size).toBe(1);
    expect(listEvents).toHaveBeenCalledTimes(5);
  });

  it('warns plainly when an allowed call is not in the paused turn at all', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const { turn } = turnWith([[modelMessage({ id: 'e1', threadId: 'main', callIds: ['other'] })]]);
    const calls = await approvedToolCalls({
      pausedTurn: turn,
      input: [allow({ threadId: 'main', callId: 'c1' })],
      logger,
    });
    expect(calls.size).toBe(0);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('not found in the paused turn'), { missing: 1 });
  });

  it('reads nothing when the person allowed nothing', async () => {
    const { turn, listEvents } = turnWith([[]]);
    const deny: TurnInputItem = {
      type: EventType.USER_TOOL_APPROVAL,
      thread_id: 'main',
      tool_call_id: 'c1',
      approval: { status: 'deny', reason: 'No.' },
    };
    expect((await approvedToolCalls({ pausedTurn: turn, input: [deny], logger })).size).toBe(0);
    expect(listEvents).not.toHaveBeenCalled();
  });

  it('gives no calls, and logs, when the paused turn cannot be read', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const turn = { listEvents: jest.fn().mockRejectedValue(new Error('store down')) };
    const calls = await approvedToolCalls({
      pausedTurn: turn,
      input: [allow({ threadId: 'main', callId: 'c1' })],
      logger,
    });
    expect(calls.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
