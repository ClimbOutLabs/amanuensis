import { EVAL_DECLINE_REASON, gateEvalApprovals, type EvalApprovalTurn } from '../../../src/eval/approvalGate';

/** A paused turn whose model message asked for the given tool calls, read a page at a time. */
function sessionWithCalls(calls: { id: string; name: string }[], pageSize = 100) {
  const events: unknown[] = [
    { type: 'user.message', id: 'evt-0' },
    {
      type: 'model.message',
      id: 'evt-1',
      tool_calls: calls.map(call => ({
        id: call.id,
        type: 'function',
        function: { name: call.name, arguments: '{}' },
      })),
    },
  ];
  const turn: EvalApprovalTurn = {
    async listEvents({ page_token }) {
      const start = page_token === undefined ? 0 : Number(page_token);
      const end = start + pageSize;
      return {
        data: events.slice(start, end),
        pagination: { next_page_token: end < events.length ? String(end) : undefined },
      };
    },
  };
  return { getTurn: async () => turn };
}

function allow(tool_call_id: string) {
  return {
    type: 'user.tool_approval' as const,
    thread_id: 'main',
    tool_call_id,
    approval: { status: 'allow' as const, scope: 'once' as const },
  };
}

describe('gateEvalApprovals', () => {
  it('keeps approvals for fixture-backed tools, maps and search', async () => {
    const session = sessionWithCalls([
      { id: 'call-calendar', name: 'create_event' },
      { id: 'call-draft', name: 'draft_email' },
      { id: 'call-map', name: 'render_route' },
      { id: 'call-search', name: 'tavily_search' },
    ]);

    const gated = await gateEvalApprovals({
      session,
      previous_turn_id: 'turn-1',
      input: ['call-calendar', 'call-draft', 'call-map', 'call-search'].map(allow),
    });

    expect(gated?.every(item => item.type === 'user.tool_approval' && item.approval.status === 'allow')).toBe(true);
  });

  it('declines a send, an extract, an unknown call and a call the paused turn never asked for', async () => {
    const session = sessionWithCalls([
      { id: 'call-send', name: 'send_draft' },
      { id: 'call-extract', name: 'tavily_extract' },
    ]);

    const gated = await gateEvalApprovals({
      session,
      previous_turn_id: 'turn-1',
      input: ['call-send', 'call-extract', 'call-unknown'].map(allow),
    });

    expect(gated?.map(item => (item.type === 'user.tool_approval' ? item.approval : undefined))).toEqual([
      { status: 'deny', reason: EVAL_DECLINE_REASON },
      { status: 'deny', reason: EVAL_DECLINE_REASON },
      { status: 'deny', reason: EVAL_DECLINE_REASON },
    ]);
  });

  it('reads calls from later pages of the paused turn', async () => {
    const session = sessionWithCalls([{ id: 'call-late', name: 'list_events' }], 1);

    const gated = await gateEvalApprovals({
      session,
      previous_turn_id: 'turn-1',
      input: [allow('call-late')],
    });

    expect(gated?.[0]).toMatchObject({ approval: { status: 'allow' } });
  });

  it('denies every approval when the paused turn cannot be read', async () => {
    const gated = await gateEvalApprovals({
      session: { getTurn: async () => undefined },
      previous_turn_id: 'missing',
      input: [allow('call-any')],
    });

    expect(gated?.[0]).toMatchObject({ approval: { status: 'deny', reason: EVAL_DECLINE_REASON } });
  });

  it('leaves input with no allowed approvals exactly as it was', async () => {
    const input = [
      {
        type: 'user.tool_approval' as const,
        thread_id: 'main',
        tool_call_id: 'call-x',
        approval: { status: 'deny' as const, reason: 'Not now.' },
      },
      { type: 'user.message' as const, content: 'hello' },
    ];
    const getTurn = jest.fn();

    const gated = await gateEvalApprovals({ session: { getTurn }, previous_turn_id: 'turn-1', input });

    expect(gated).toBe(input);
    expect(getTurn).not.toHaveBeenCalled();
  });
});
