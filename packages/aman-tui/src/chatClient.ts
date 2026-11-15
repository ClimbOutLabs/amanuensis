import { createSessionResyncExtensions, createTrueForgeClient, type SessionTipInfo } from '@truefoundry/trueforge-chat';
import type { TrueForge, TrueForgeApi } from '@truefoundry/trueforge-sdk';

import type { ChatEvent } from './chatEvents.js';

/** One row of the chat list. */
export interface ChatSummary {
  id: string;
  title: string;
  personaName: string | null;
  updatedAt: string;
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
  streamMessage(sessionId: string, text: string): AsyncGenerator<ChatEvent>;
  /** The session's newest turn and any approvals still pending on it, from the shared resync code. */
  peekTip(sessionId: string): Promise<SessionTipInfo | null>;
}

const HISTORY_EVENT_LIMIT = 2000;
const RESUBSCRIBE_ATTEMPTS = 5;
const RESUBSCRIBE_DELAY_MS = 1000;

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
        await sleep(RESUBSCRIBE_DELAY_MS);
      }
    }
    throw lastError ?? new Error('The connection to Aman was lost and the reply could not be rejoined.');
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
        const firstAgent = (await client.agents.list({ limit: 1 })).data[0];
        if (firstAgent !== undefined) {
          agent = { name: firstAgent.name };
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

    async *streamMessage(sessionId: string, text: string): AsyncGenerator<ChatEvent> {
      const clientTimezone = resolveClientTimezone();
      const stream = await client.sessions.createTurnStream(sessionId, {
        input: [{ type: 'user.message', content: text }],
        previousTurnId: 'auto',
        ...(clientTimezone === undefined ? {} : { clientTimezone }),
      });
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
          throw error;
        }
        // A drop after the turn was created is rejoined below, like the web app does.
      }
      if (!sawDone && turnId !== undefined) {
        yield* resubscribe(sessionId, turnId, cursor);
      }
    },

    async peekTip(sessionId: string): Promise<SessionTipInfo | null> {
      return resync.peekSessionTip({ sessionId });
    },
  };
}
