import {
  createSessionResyncExtensions,
  createTrueForgeClient,
  type HeldActionDecision,
  type HeldActionOutcome,
  type SessionTipInfo,
} from '@truefoundry/trueforge-chat';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

import { pendingApprovalFromRef, type PendingApproval } from './approvals.js';
import type { ChatEvent } from './chatEvents.js';
import { keyWasRefused, statusCodeOfError } from './serverErrors.js';
import { outcomeOfDisposition } from './words.js';

/** One row of the chat list. */
export interface ChatSummary {
  id: string;
  title: string;
  personaName: string | null;
  updatedAt: string;
}

/** What a streaming call can tell the view while it runs. */
export interface StreamHooks {
  /** Called when the connection drops mid-turn and the rejoin begins. */
  onConnectionLost?: () => void;
}

/** The chat operations the terminal app uses, over the shared chat package and the SDK. */
export interface ChatClient {
  listChats(): Promise<ChatSummary[]>;
  createChat(): Promise<ChatSummary>;
  /** The saved events of a chat, oldest first, ready to fold into the view. */
  loadHistory(sessionId: string): Promise<ChatEvent[]>;
  /**
   * Sends one message and yields the turn's events as they arrive. When the
   * connection drops mid-turn, the turn is rejoined through the same subscribe
   * the web app uses, so the reply resumes instead of failing.
   */
  streamMessage(sessionId: string, text: string, hooks?: StreamHooks): AsyncGenerator<ChatEvent>;
  /**
   * Answers one waiting approval through the same continuation the web app
   * sends, yields the continuation turn's events as they arrive, and returns
   * what became of the action. A refusal by the server throws, with its
   * status and error code intact for the caller to word.
   */
  answerApproval(
    sessionId: string,
    approval: PendingApproval,
    decision: HeldActionDecision,
    hooks?: StreamHooks,
  ): AsyncGenerator<ChatEvent, HeldActionOutcome>;
  /** Stops the turn running in a chat, through the same cancel the web app uses. */
  stopTurn(sessionId: string): Promise<void>;
  /**
   * The approvals still waiting on the chat's newest turn, with their cards.
   * The event fold learns about most of them; this read covers a chat whose
   * saved events end before the tip turn's own record.
   */
  pendingApprovals(sessionId: string): Promise<PendingApproval[]>;
  /** The session's newest turn and any approvals still pending on it, from the shared resync code. */
  peekTip(sessionId: string): Promise<SessionTipInfo | null>;
  /** Wakes a rejoin that is waiting between attempts, so it retries at once. */
  retryConnectionNow(): void;
}

const HISTORY_EVENT_LIMIT = 2000;
const RESUBSCRIBE_ATTEMPTS = 5;
const RESUBSCRIBE_DELAY_MS = 1000;

const CONNECTION_LOST_LINE =
  'The connection to Aman was lost and the reply could not be rejoined. Send your message again.';
const COULD_NOT_REACH_LINE = 'The reply did not finish. Check your connection, then send your message again.';

function sequenceNumber(id: string | undefined, fallback: number): number {
  if (id === undefined) {
    return fallback;
  }
  const parsed = Number(id);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function resolveClientTimezone(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
}

function summaryOf(session: TrueForgeApi.Session, personaName: string | null): ChatSummary {
  return {
    id: session.id,
    title: session.title ?? 'New chat',
    personaName: personaName ?? (session.agent.type === 'reference' ? session.agent.name : null),
    updatedAt: session.updatedAt,
  };
}

type TurnStream = Awaited<ReturnType<TrueForge['sessions']['createTurnStream']>>;

export function createChatClient(options: {
  baseUrl: string;
  token: string;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}): ChatClient {
  const client: TrueForge = createTrueForgeClient({
    baseUrl: options.baseUrl,
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  const resync = createSessionResyncExtensions(client);
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));

  // A rejoin waiting between attempts can be woken at once, when the person asks.
  let wakeRetry: (() => void) | undefined;
  async function waitRetryDelay(): Promise<void> {
    const wake = new Promise<void>(resolve => {
      wakeRetry = resolve;
    });
    try {
      await Promise.race([sleep(RESUBSCRIBE_DELAY_MS), wake]);
    } finally {
      wakeRetry = undefined;
    }
  }

  async function personaNameOf(sessionId: string): Promise<string | null> {
    try {
      const response = await client.sessionPersonas.get(sessionId);
      return response.data?.personaName ?? null;
    } catch {
      // The persona is a label on the list row; a failed read never blocks the list.
      return null;
    }
  }

  async function* resubscribe(
    sessionId: string,
    turnId: string,
    cursor: { sequence: number },
  ): AsyncGenerator<ChatEvent> {
    let lastError: unknown;
    for (let attempt = 0; attempt < RESUBSCRIBE_ATTEMPTS; attempt += 1) {
      try {
        const stream = await client.sessions.subscribeToTurn(sessionId, turnId, {
          afterSequenceNumber: cursor.sequence,
        });
        let fallback = cursor.sequence;
        for await (const item of stream.withMetadata()) {
          const seq = sequenceNumber(item.id, fallback);
          cursor.sequence = seq;
          fallback = seq + 1;
          yield item.data;
          if (item.data.type === 'turn.done') {
            return;
          }
        }
        // A clean end without turn.done is a drop, not a finish: rejoin again.
      } catch (error) {
        lastError = error;
      }
      if (attempt < RESUBSCRIBE_ATTEMPTS - 1) {
        await waitRetryDelay();
      }
    }
    // A refusal with a status (the key was revoked mid-turn, say) reaches the
    // caller as it came, so it can be worded from its status and code. A bare
    // connection failure becomes the plain lost line.
    if (lastError !== undefined && statusCodeOfError(lastError) !== undefined) {
      throw lastError;
    }
    throw new Error(CONNECTION_LOST_LINE, lastError === undefined ? undefined : { cause: lastError });
  }

  /**
   * Yields one turn's events from its stream. When the connection drops after
   * the turn was created, the turn is rejoined through the subscribe route,
   * like the web app does. A failure before the turn exists, or one the server
   * answered with a status, reaches the caller as it came.
   */
  async function* pumpTurn(sessionId: string, stream: TurnStream, hooks?: StreamHooks): AsyncGenerator<ChatEvent> {
    const cursor = { sequence: 0 };
    let fallback = 0;
    let turnId: string | undefined;
    let sawDone = false;
    try {
      for await (const item of stream.withMetadata()) {
        const seq = sequenceNumber(item.id, fallback);
        cursor.sequence = seq;
        fallback = seq + 1;
        if (item.data.type === 'turn.created') {
          turnId = item.data.turnId;
        }
        yield item.data;
        if (item.data.type === 'turn.done') {
          sawDone = true;
          return;
        }
      }
    } catch (error) {
      if (turnId === undefined) {
        if (statusCodeOfError(error) !== undefined) {
          throw error;
        }
        throw new Error(COULD_NOT_REACH_LINE, { cause: error });
      }
      // A drop after the turn was created is rejoined below, like the web app does.
    }
    if (!sawDone && turnId !== undefined) {
      hooks?.onConnectionLost?.();
      yield* resubscribe(sessionId, turnId, cursor);
    }
  }

  return {
    async listChats(): Promise<ChatSummary[]> {
      const page = await client.sessions.list({ limit: 50, order: 'desc' });
      const summaries: ChatSummary[] = [];
      for (const session of page.data) {
        summaries.push(summaryOf(session, await personaNameOf(session.id)));
      }
      return summaries;
    },

    async createChat(): Promise<ChatSummary> {
      // A new chat runs on the same agent as the person's newest chat. With no
      // chats yet, it runs on the first agent in the registry.
      const newest = (await client.sessions.list({ limit: 1, order: 'desc' })).data[0];
      let agent: TrueForgeApi.CreateSessionAgent | undefined;
      if (newest !== undefined && newest.agent.type === 'inline') {
        agent = { spec: newest.agent.spec };
      } else if (newest !== undefined && newest.agent.type === 'reference' && newest.agent.name !== null) {
        agent = { name: newest.agent.name };
      }
      if (agent === undefined) {
        try {
          const firstAgent = (await client.agents.list({ limit: 1 })).data[0];
          if (firstAgent !== undefined) {
            agent = { name: firstAgent.name };
          }
        } catch (error) {
          // The agents list sits outside a paired terminal's chat scope, so
          // the server refuses this call for a terminal key, and the refusal
          // lands on the plain line below like an empty registry does. Any
          // other failure of the call lands on a plain line too, never a raw
          // throw the person cannot act on.
          if (!keyWasRefused(error)) {
            throw new Error('Aman could not be reached to start a new chat. Check your connection, then try again.', {
              cause: error,
            });
          }
        }
      }
      if (agent === undefined) {
        throw new Error('No agent is set up on this Aman yet. Start your first chat in the web app.');
      }
      const created = await client.sessions.create({ agent });
      return summaryOf(created.data, null);
    },

    async loadHistory(sessionId: string): Promise<ChatEvent[]> {
      const page = await client.sessions.listEvents(sessionId, { limit: 100 });
      const newestFirst: ChatEvent[] = [];
      for await (const item of page) {
        newestFirst.push(item.event);
        if (newestFirst.length >= HISTORY_EVENT_LIMIT) {
          break;
        }
      }
      return newestFirst.reverse();
    },

    async *streamMessage(sessionId: string, text: string, hooks?: StreamHooks): AsyncGenerator<ChatEvent> {
      const clientTimezone = resolveClientTimezone();
      const stream = await client.sessions.createTurnStream(sessionId, {
        input: [{ type: 'user.message', content: text }],
        previousTurnId: 'auto',
        ...(clientTimezone === undefined ? {} : { clientTimezone }),
      });
      yield* pumpTurn(sessionId, stream, hooks);
    },

    async *answerApproval(
      sessionId: string,
      approval: PendingApproval,
      decision: HeldActionDecision,
      hooks?: StreamHooks,
    ): AsyncGenerator<ChatEvent, HeldActionOutcome> {
      const decisionBody: TrueForgeApi.ApprovalDecision =
        decision === 'deny'
          ? { status: 'deny' }
          : { status: 'allow', scope: decision === 'always_allow' ? 'always' : 'once' };
      const stream = await client.sessions.createTurnStream(sessionId, {
        input: [
          {
            type: 'user.tool_approval',
            threadId: approval.threadId,
            toolCallId: approval.toolCallId,
            approval: decisionBody,
          },
        ],
        previousTurnId: 'auto',
      });
      let outcome: HeldActionOutcome = 'unclear';
      for await (const event of pumpTurn(sessionId, stream, hooks)) {
        if (event.type === 'tool.response.v2' && event.toolCallId === approval.toolCallId) {
          outcome = outcomeOfDisposition(event.disposition);
        }
        yield event;
      }
      return outcome;
    },

    async stopTurn(sessionId: string): Promise<void> {
      await client.sessions.cancel(sessionId, {});
    },

    async pendingApprovals(sessionId: string): Promise<PendingApproval[]> {
      const tip = await resync.peekSessionTip({ sessionId });
      if (tip === null || tip.pendingApprovals.length === 0) {
        return [];
      }
      const response = await client.sessions.getTurn(sessionId, tip.turnId);
      const state = response.data.state;
      if (state.status !== 'done') {
        return [];
      }
      const wanted = new Set(tip.pendingApprovals.map(pending => pending.toolCallId));
      const approvals: PendingApproval[] = [];
      for (const action of state.requiredActions) {
        if (action.type !== 'tool.approval_required') {
          continue;
        }
        for (const ref of action.toolCalls) {
          if (wanted.has(ref.id)) {
            approvals.push(pendingApprovalFromRef({ ref, threadId: action.threadId, toolName: null }));
          }
        }
      }
      return approvals;
    },

    async peekTip(sessionId: string): Promise<SessionTipInfo | null> {
      return resync.peekSessionTip({ sessionId });
    },

    retryConnectionNow(): void {
      wakeRetry?.();
    },
  };
}
