/**
 * Runs voice turns through the chat's own turn route, as the chat's send does: same agent, same
 * tools, same approvals, and the same saved text in the chat. The route is reached through
 * `request`, which the server points at its own app with the person's own credentials, so every
 * check a typed message goes through applies here too.
 */
import { EventType, TurnCreatedEventSchema, TurnDoneEventSchema } from '@truefoundry/trueforge-core/agent-session';
import { ModelMessageDeltaEventSchema } from '@truefoundry/trueforge-core/core';
import { z } from 'zod';

import type { PendingApproval, TurnOutcome, TurnRefusal, VoiceTurnRunner } from './transport';

export type SessionRequest = (path: string, init: RequestInit) => Promise<Response>;

const REFUSALS: Record<string, TurnRefusal> = {
  held_action_expired: 'expired',
  held_action_changed: 'changed',
  held_action_not_allowed: 'not_allowed',
  held_action_tool_gone: 'tool_gone',
  held_action_sign_in: 'sign_in',
};

const ErrorBodySchema = z.object({ error: z.object({ code: z.string().nullable().optional() }).loose() }).loose();

type TurnInput =
  | { type: 'user.message'; content: string }
  | {
      type: 'user.tool_approval';
      thread_id: string;
      tool_call_id: string;
      approval: { status: 'allow'; scope: 'once' } | { status: 'deny' };
    };

/** The part of a finished turn that says which cards are still waiting; answered ones are left out by the route. */
const WaitingTurnSchema = z.object({
  data: z.object({
    state: z.object({
      required_actions: z
        .array(z.object({ tool_calls: z.array(z.object({ id: z.string() })).default([]) }).loose())
        .default([]),
    }),
  }),
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

  async stillWaiting({ turnId, approval }: { turnId: string; approval: PendingApproval }): Promise<boolean> {
    try {
      const response = await this.#request(
        `/api/v1/sessions/${encodeURIComponent(this.#sessionId)}/turns/${encodeURIComponent(turnId)}`,
        { method: 'GET' },
      );
      const parsed = WaitingTurnSchema.safeParse(await response.json());
      if (!parsed.success) {
        return true;
      }
      const { state } = parsed.data.data;
      return state.required_actions.some(action => action.tool_calls.some(call => call.id === approval.toolCallId));
    } catch {
      return true;
    }
  }

  /** Cancels this runner's own turn. Nothing else running in the chat, such as a typed message, is touched. */
  async cancel(): Promise<void> {
    const turnId = this.#runningTurnId;
    if (turnId === undefined) {
      return;
    }
    await this.#request(`/api/v1/sessions/${encodeURIComponent(this.#sessionId)}/cancel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn_id: turnId }),
    });
  }

  async #run({
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
        signal,
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
    try {
      return await readTurnStream({
        body: response.body,
        onText,
        onCreated: turnId => {
          this.#runningTurnId = turnId;
        },
      });
    } catch {
      return { kind: 'failed' };
    } finally {
      this.#runningTurnId = undefined;
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
