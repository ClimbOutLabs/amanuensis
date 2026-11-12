import { OpenAPIHono } from '@hono/zod-openapi';
import type { TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import {
  EventType,
  MAIN_THREAD_ID,
  PreviousTurnRunningError,
  SessionHandle,
  StaleApprovalContinuationError,
  TurnAlreadyExistsError,
} from '@truefoundry/trueforge-core/agent-session';
import { AgentHarnessError, HeldActionRefusedError } from '@truefoundry/trueforge-core/core';
import { STANDALONE_REQUEST_CONTEXT, type RequestContext } from '../../../src/auth/identity';
import {
  CHILD_CALL_ID,
  CHILD_CARD,
  CHILD_THREAD_ID,
  FIRST_TURN_ID,
  SESSION_ID,
  TIP_TURN_ID,
  TOOL_CALL_ID,
  approvalInput,
  buildApp,
  postTurn,
  rejectCreateTurnWith,
} from '../../fixtures/turnApprovalApp';

describe('POST /{session_id}/turns approval conflicts', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it.each([
    [
      new PreviousTurnRunningError(TIP_TURN_ID),
      'previous_turn_running',
      // A person reads this one, so it never carries the store's turn ids.
      'This chat is still working on your last message. Wait for it to finish, or press Cancel, then send again.',
    ],
    [new TurnAlreadyExistsError(TIP_TURN_ID), 'turn_already_exists', new TurnAlreadyExistsError(TIP_TURN_ID).message],
  ])('maps a store conflict to 409 with code %#', async (error, code, message) => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(error);

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: { message, type: 'conflict', code },
    });
  });

  describe('when the session tip moved after the request read it', () => {
    const stale = () => new StaleApprovalContinuationError('turn-old', TIP_TURN_ID);

    it('replays a decision the tip already recorded, as a double submit would send it', async () => {
      const app = await buildApp({ status: 'allow' });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'allow' }));

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ data: { id: TIP_TURN_ID, session_id: SESSION_ID } });
    });

    it('replays the answer for a resend anchored on the turn that asked, after the answer created the next turn', async () => {
      const app = await buildApp({ status: 'allow' }, { pausedFirstTurn: true });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'allow' }), FIRST_TURN_ID);

      expect(response.status).toBe(200);
      const body: unknown = await response.json();
      expect(body).toMatchObject({ data: { id: TIP_TURN_ID, session_id: SESSION_ID } });
    });

    it('refuses a different answer anchored on the turn that asked once the first answer is recorded', async () => {
      const app = await buildApp({ status: 'allow' }, { pausedFirstTurn: true });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'too late' }), FIRST_TURN_ID);

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'approval_conflict' } });
    });

    it('refuses a decision that contradicts the recorded one instead of replaying it', async () => {
      const app = await buildApp({ status: 'allow' });
      rejectCreateTurnWith(stale());

      const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ error: { code: 'approval_conflict' } });
    });

    it('keeps the stale 409 for a decision the session never recorded', async () => {
      const app = await buildApp({ status: 'allow' });
      const error = stale();
      rejectCreateTurnWith(error);

      const response = await postTurn(app, [
        {
          type: EventType.USER_TOOL_APPROVAL,
          thread_id: MAIN_THREAD_ID,
          tool_call_id: 'tc-from-an-older-turn',
          approval: { status: 'allow' },
        },
      ]);

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: { message: error.message, type: 'conflict', code: 'stale_approval_continuation' },
      });
    });
  });

  it('replays the tip turn for a decision it already recorded', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(
      new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
    );

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(200);
    const body: unknown = await response.json();
    expect(body).toMatchObject({ data: { id: TIP_TURN_ID, session_id: SESSION_ID } });
  });

  it('rejects a resubmission that contradicts the recorded decision', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(
      new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
    );

    const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        message: `Tool call ${TOOL_CALL_ID} already has a different decision on record`,
        type: 'conflict',
        code: 'approval_conflict',
      },
    });
  });

  it('replays a recorded denial regardless of the reason text resent with it', async () => {
    const app = await buildApp({ status: 'deny', reason: 'not this repo' });
    rejectCreateTurnWith(
      new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
    );

    const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'still no' }));

    expect(response.status).toBe(200);
  });

  it('keeps 422 for a decision the session never recorded', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(new AgentHarnessError('invalid_send_input', 'thread main: no pending approval'));

    const response = await postTurn(app, [
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: MAIN_THREAD_ID,
        tool_call_id: 'tc-never-seen',
        approval: { status: 'allow' },
      },
    ]);

    expect(response.status).toBe(422);
  });

  it('keeps 422 for a rejected user message, which is no resubmission', async () => {
    const app = await buildApp({ status: 'allow' });
    rejectCreateTurnWith(
      new AgentHarnessError(
        'invalid_send_input',
        'user message cannot be sent while approvals or questions are pending',
      ),
    );

    const response = await postTurn(app, [{ type: EventType.USER_MESSAGE, content: 'hello' }]);

    expect(response.status).toBe(422);
  });
});

describe('POST /{session_id}/turns answering an action a scheduled run held', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  /** createTurn is stubbed to stop the request after it was handed its options. */
  function captureCreateTurnOptions() {
    return jest
      .spyOn(SessionHandle.prototype, 'createTurn')
      .mockRejectedValue(new PreviousTurnRunningError(TIP_TURN_ID));
  }

  it('ends the turn with no model call when the owner turns the held action down', async () => {
    const app = await buildApp(undefined, { heldAction: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: true }));
  });

  it('lets the model continue after the owner approves, so its answer uses the result', async () => {
    const app = await buildApp(undefined, { heldAction: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'allow' }));

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: false }));
  });

  it('does not end the turn early for an approval that is not about a held action', async () => {
    const app = await buildApp({ status: 'allow' }, { pausedFirstTurn: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'allow' }), FIRST_TURN_ID);

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: false }));
  });

  it('does not end the turn early once the held action was answered, so a repeat is only replayed', async () => {
    const app = await buildApp({ status: 'allow' }, { heldAction: true });
    const createTurn = captureCreateTurnOptions();

    await postTurn(app, approvalInput({ status: 'allow' }));

    expect(createTurn).toHaveBeenCalledWith(expect.objectContaining({ stop_after_tool_response: false }));
  });

  it('replays the recorded turn for a second approval instead of running the call again', async () => {
    const app = await buildApp({ status: 'allow' }, { heldAction: true });
    jest
      .spyOn(SessionHandle.prototype, 'createTurn')
      .mockRejectedValue(
        new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
      );

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: TIP_TURN_ID } });
  });

  it('refuses a deny that contradicts an approval already recorded', async () => {
    const app = await buildApp({ status: 'allow' }, { heldAction: true });
    jest
      .spyOn(SessionHandle.prototype, 'createTurn')
      .mockRejectedValue(
        new AgentHarnessError('invalid_send_input', `thread main: no pending approval for '${TOOL_CALL_ID}'`),
      );

    const response = await postTurn(app, approvalInput({ status: 'deny', reason: 'changed my mind' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ error: { code: 'approval_conflict' } });
  });

  it('refuses anyone but the chat owner, before reading the held call', async () => {
    const someoneElse: RequestContext = {
      ...STANDALONE_REQUEST_CONTEXT,
      subject: { id: 'someone-else', type: 'user', display_name: 'someone-else' },
    };
    const app = await buildApp(undefined, { heldAction: true, requester: someoneElse });
    const createTurn = captureCreateTurnOptions();

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(403);
    expect(createTurn).not.toHaveBeenCalled();
  });

  it('answers an action that cannot run now with a conflict whose code says why', async () => {
    const app = await buildApp(undefined, { heldAction: true });
    jest.spyOn(SessionHandle.prototype, 'createTurn').mockRejectedValue(new HeldActionRefusedError('expired'));

    const response = await postTurn(app, approvalInput({ status: 'allow' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        message: 'Expired, nothing was done. Ask again in chat.',
        type: 'conflict',
        code: 'held_action_expired',
      },
    });
  });
});

describe('POST /{session_id}/turns for a card whose request ended', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  function childDecision(approval: { status: 'allow' } | { status: 'deny'; reason: string }): TurnInputItem[] {
    return [{ type: EventType.USER_TOOL_APPROVAL, thread_id: CHILD_THREAD_ID, tool_call_id: CHILD_CALL_ID, approval }];
  }

  async function turnCount(app: OpenAPIHono): Promise<number> {
    const response = await app.request(`/${SESSION_ID}/turns`, { method: 'GET' });
    const body: unknown = await response.json();
    if (typeof body !== 'object' || body === null || !('data' in body) || !Array.isArray(body.data)) {
      throw new Error('the turn list did not answer with data');
    }
    return body.data.length;
  }

  it('Dismiss answers 200 with the turn named, creates no turn, and hides the card on reload', async () => {
    const app = await buildApp(undefined, { endedCard: true });
    const before = await turnCount(app);

    const response = await postTurn(app, childDecision({ status: 'deny', reason: 'Dismissed' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ data: { id: TIP_TURN_ID } });
    expect(await turnCount(app)).toBe(before);
    const reloaded = await app.request(`/${SESSION_ID}/turns/${FIRST_TURN_ID}`, { method: 'GET' });
    expect(await reloaded.json()).toMatchObject({ data: { state: { required_actions: [] } } });
  });

  it('Deny is cleared the same way as Dismiss', async () => {
    const app = await buildApp(undefined, { endedCard: true });
    const before = await turnCount(app);

    const response = await postTurn(app, childDecision({ status: 'deny', reason: 'Not now' }));

    expect(response.status).toBe(200);
    expect(await turnCount(app)).toBe(before);
  });

  it('Dismissing the same ended card twice answers 200 both times and still creates no turn', async () => {
    const app = await buildApp(undefined, { endedCard: true });
    const before = await turnCount(app);

    const first = await postTurn(app, childDecision({ status: 'deny', reason: 'Dismissed' }));
    const second = await postTurn(app, childDecision({ status: 'deny', reason: 'Dismissed' }));

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await turnCount(app)).toBe(before);
  });

  it('Approve is refused with the ended-request conflict and no turn is created', async () => {
    const app = await buildApp(undefined, { endedCard: true });
    const before = await turnCount(app);

    const response = await postTurn(app, childDecision({ status: 'allow' }));

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: {
        message: 'This request ended. Ask again if you still need it.',
        type: 'conflict',
        code: 'approval_request_ended',
      },
    });
    expect(await turnCount(app)).toBe(before);
  });

  it('does not clear a decision on an id the session never issued; it keeps the unknown-thread 422', async () => {
    const app = await buildApp(undefined, { endedCard: true });
    const before = await turnCount(app);
    rejectCreateTurnWith(new AgentHarnessError('invalid_send_input', 'unknown thread_id: thread-foreign'));

    const response = await postTurn(app, [
      {
        type: EventType.USER_TOOL_APPROVAL,
        thread_id: 'thread-foreign',
        tool_call_id: CHILD_CALL_ID,
        approval: { status: 'deny', reason: 'Dismissed' },
      },
    ]);

    expect(response.status).toBe(422);
    expect(await turnCount(app)).toBe(before);
  });

  it('does not clear a card the tip still waits on when an older turn is named', async () => {
    const app = await buildApp(undefined, { liveCardOnTip: true });
    rejectCreateTurnWith(new StaleApprovalContinuationError(FIRST_TURN_ID, TIP_TURN_ID));

    const response = await postTurn(app, childDecision({ status: 'deny', reason: 'Dismissed' }), FIRST_TURN_ID);

    expect(response.status).toBe(409);
    const tip = await app.request(`/${SESSION_ID}/turns/${TIP_TURN_ID}`, { method: 'GET' });
    expect(await tip.json()).toMatchObject({ data: { state: { required_actions: CHILD_CARD } } });
  });
});
