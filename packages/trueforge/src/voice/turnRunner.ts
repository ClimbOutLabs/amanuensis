/**
 * Runs voice turns through the chat's own turn route, as the chat's send does: same agent, same
 * tools, same approvals, and the same saved text in the chat. The route is reached through
 * `request`, which the server points at its own app with the person's own credentials, so every
 * check a typed message goes through applies here too.
 */
import { EventType, TurnCreatedEventSchema, TurnDoneEventSchema } from '@truefoundry/trueforge-core/agent-session';
import { ModelMessageDeltaEventSchema } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';

import { ListSessionEventsResponseSchema } from '../schemas/events';
import { GetTurnResponseSchema } from '../schemas/turn';
import type { PendingApproval, TurnOutcome, TurnRefusal, VoiceTurnRunner } from './transport';

export type SessionRequest = (path: string, init: RequestInit) => Promise<Response>;

const REFUSALS: Record<string, TurnRefusal> = {
  held_action_expired: 'expired',
  held_action_changed: 'changed',
  held_action_not_allowed: 'not_allowed',
  held_action_tool_gone: 'tool_gone',
  held_action_sign_in: 'sign_in',
};

/** How long an abandoned turn is listened to for its name, so it can still be cancelled. */
const UNNAMED_TURN_WAIT_MS = 15_000;

const ErrorBodySchema = z.object({ error: z.object({ code: z.string().nullable().optional() }).loose() }).loose();

type TurnInput =
  | { type: 'user.message'; content: string }
  | {
      type: 'user.tool_approval';
      thread_id: string;
      tool_call_id: string;
      approval: { status: 'allow'; scope: 'once' } | { status: 'deny' };
    };

/** The newest event of the chat, which names the chat's newest turn. */
const NewestEventSchema = z.object({
  data: z.array(ListSessionEventsResponseSchema.shape.data.element.pick({ turn_id: true })),
});

export class HttpVoiceTurnRunner implements VoiceTurnRunner {
  readonly #request: SessionRequest;
  readonly #sessionId: string;
  readonly #timezone: string | undefined;
  /** The turn this runner started, from the moment the server accepted it until it ended. */
  #runningTurnId: string | undefined;

  constructor({
    request,
    sessionId,
    clientTimezone,
  }: {
    request: SessionRequest;
    sessionId: string;
    clientTimezone?: string | undefined;
  }) {
    this.#request = request;
    this.#sessionId = sessionId;
    this.#timezone = clientTimezone;
  }

  sendMessage({
    text,
    signal,
    onText,
  }: {
    text: string;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    return this.#run({ input: { type: 'user.message', content: text }, spoken: true, signal, onText });
  }

  answerApproval({
    approval,
    decision,
    signal,
    onText,
  }: {
    approval: PendingApproval;
    decision: 'allow' | 'deny';
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    return this.#run({
      input: {
        type: 'user.tool_approval',
        thread_id: approval.threadId,
        tool_call_id: approval.toolCallId,
        approval: decision === 'allow' ? { status: 'allow', scope: 'once' } : { status: 'deny' },
      },
      spoken: true,
      signal,
      onText,
    });
  }

  /**
   * True while the card is still waiting for an answer in the chat. A card answered on the screen starts
   * a newer turn and the turn it came from keeps listing it, so the chat's newest turn is checked as well.
   * When this cannot be checked the card counts as waiting: the server validates the answer anyway.
   */
  async stillWaiting({ turnId, approval }: { turnId: string; approval: PendingApproval }): Promise<boolean> {
    const chat = `/api/v1/sessions/${encodeURIComponent(this.#sessionId)}`;
    try {
      const newest = NewestEventSchema.safeParse(
        await (await this.#request(`${chat}/events?limit=1`, { method: 'GET' })).json(),
      );
      const newestTurnId = newest.success ? newest.data.data[0]?.turn_id : undefined;
      if (newestTurnId !== undefined && newestTurnId !== turnId) {
        return false;
      }
      const parsed = GetTurnResponseSchema.safeParse(
        await (await this.#request(`${chat}/turns/${encodeURIComponent(turnId)}`, { method: 'GET' })).json(),
      );
      if (!parsed.success || parsed.data.data.state.status !== 'done') {
        return true;
      }
      return parsed.data.data.state.required_actions.some(
        action =>
          action.type === EventType.TOOL_APPROVAL_REQUIRED &&
          action.tool_calls.some(call => call.id === approval.toolCallId),
      );
    } catch {
      return true;
    }
  }

  /** Cancels this runner's own turn. Nothing else running in the chat, such as a typed message, is touched. */
  async cancel(): Promise<void> {
    const turnId = this.#runningTurnId;
    if (turnId !== undefined) {
      await this.#cancelTurn(turnId);
    }
  }

  async #cancelTurn(turnId: string): Promise<void> {
    await this.#request(`/api/v1/sessions/${encodeURIComponent(this.#sessionId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: turnId }),
    });
  }

  /**
   * Starts the turn and returns its outcome. When `signal` aborts before the server has named the turn, the
   * caller is released at once, but the stream is kept just long enough to learn the name and cancel that turn.
   */
  #run({
    input,
    spoken,
    signal,
    onText,
  }: {
    input: TurnInput;
    spoken: boolean;
    signal: AbortSignal;
    onText: (delta: string) => void;
  }): Promise<TurnOutcome> {
    const own = new AbortController();
    let createdId: string | undefined;
    let abandoned = false;
    const gone = new Promise<TurnOutcome>(resolve => {
      const onAbort = (): void => {
        abandoned = true;
        if (createdId !== undefined) {
          own.abort();
        } else {
          setTimeout(() => {
            own.abort();
          }, UNNAMED_TURN_WAIT_MS).unref();
        }
        resolve({ kind: 'failed' });
      };
      if (signal.aborted) {
        onAbort();
      } else {
        signal.addEventListener('abort', onAbort, { once: true });
      }
    });
    const outcome = this.#post({
      input,
      spoken,
      fetchSignal: own.signal,
      onText: delta => {
        if (!abandoned) {
          onText(delta);
        }
      },
      onCreated: turnId => {
        createdId = turnId;
        // An abandoned turn is already being stopped; it must not replace the id of the turn now running.
        if (turnId !== undefined && !abandoned) {
          this.#runningTurnId = turnId;
        }
        if (abandoned && turnId !== undefined) {
          void this.#cancelTurn(turnId).catch(() => undefined);
          own.abort();
        }
      },
    });
    return Promise.race([outcome, gone]);
  }

  async #post({
    input,
    spoken,
    fetchSignal,
    onText,
    onCreated,
  }: {
    input: TurnInput;
    spoken: boolean;
    fetchSignal: AbortSignal;
    onText: (delta: string) => void;
    onCreated: (turnId: string | undefined) => void;
  }): Promise<TurnOutcome> {
    let response: Response;
    try {
      response = await this.#request(`/api/v1/sessions/${encodeURIComponent(this.#sessionId)}/turns`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          input: [input],
          stream: true,
          // Only a message the person spoke is answered aloud.
          ...(spoken && input.type === 'user.message' ? { spoken_reply: true } : {}),
          ...(this.#timezone === undefined ? {} : { client_timezone: this.#timezone }),
        }),
        signal: fetchSignal,
      });
    } catch {
      return { kind: 'failed' };
    }
    if (response.status === 401) {
      return { kind: 'refused', reason: 'sign_in' };
    }
    if (response.status === 409) {
      const parsed = ErrorBodySchema.safeParse(await response.json().catch(() => undefined));
      const code = parsed.success ? parsed.data.error.code : undefined;
      const reason = code === undefined || code === null ? undefined : REFUSALS[code];
      return reason === undefined ? { kind: 'failed' } : { kind: 'refused', reason };
    }
    if (!response.ok || response.body === null) {
      return { kind: 'failed' };
    }
    let createdTurnId: string | undefined;
    try {
      return await readTurnStream({
        body: response.body,
        onText,
        onCreated: turnId => {
          createdTurnId = turnId;
          onCreated(turnId);
        },
      });
    } catch {
      return { kind: 'failed' };
    } finally {
      // Only this run's own turn: a newer turn may have started since it was abandoned.
      if (createdTurnId !== undefined && this.#runningTurnId === createdTurnId) {
        this.#runningTurnId = undefined;
      }
    }
  }
}

async function readTurnStream({
  body,
  onText,
  onCreated,
}: {
  body: ReadableStream<Uint8Array>;
  onText: (delta: string) => void;
  onCreated: (turnId: string | undefined) => void;
}): Promise<TurnOutcome> {
  let turnId: string | undefined;
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffered = '';
  const handle = (data: string): TurnOutcome | undefined => {
    let event: unknown;
    try {
      event = JSON.parse(data);
    } catch {
      return undefined;
    }
    const type = z.object({ type: z.string() }).safeParse(event);
    if (!type.success) {
      return undefined;
    }
    if (type.data.type === EventType.TURN_CREATED) {
      turnId = TurnCreatedEventSchema.safeParse(event).data?.turn_id ?? turnId;
      onCreated(turnId);
    } else if (type.data.type === EventType.MODEL_MESSAGE_DELTA) {
      const delta = ModelMessageDeltaEventSchema.safeParse(event).data?.content;
      if (typeof delta === 'string' && delta !== '') {
        onText(delta);
      }
    } else if (type.data.type === EventType.TURN_DONE) {
      return outcomeOf({ done: TurnDoneEventSchema.safeParse(event).data, turnId });
    }
    return undefined;
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      return { kind: 'failed' };
    }
    buffered += decoder.decode(value, { stream: true });
    const blocks = buffered.split('\n\n');
    buffered = blocks.pop() ?? '';
    for (const block of blocks) {
      const data = block
        .split('\n')
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart())
        .join('\n');
      const outcome = data === '' ? undefined : handle(data);
      if (outcome !== undefined) {
        await reader.cancel().catch(() => undefined);
        return outcome;
      }
    }
  }
}

function outcomeOf({
  done,
  turnId,
}: {
  done: z.infer<typeof TurnDoneEventSchema> | undefined;
  turnId: string | undefined;
}): TurnOutcome {
  if (done?.state.status !== 'done' || turnId === undefined) {
    return { kind: 'failed' };
  }
  const approvals: PendingApproval[] = done.state.required_actions.flatMap(action =>
    action.type === EventType.TOOL_APPROVAL_REQUIRED
      ? action.tool_calls.map(call => ({
          threadId: action.thread_id,
          toolCallId: call.id,
          card: call.tier3_card,
          tier: call.tier,
        }))
      : [],
  );
  return { kind: 'done', turnId, approvals };
}
