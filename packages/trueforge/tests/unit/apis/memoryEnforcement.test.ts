/**
 * Proves the host-enforced memory wiring end to end: the real HTTP API, the real session store,
 * and note files in a folder of the test's own.
 *
 * One sequential describe block shares a single app boot:
 *   1. First turn: recall runs before the model call, the block is injected for that call only
 *      (never persisted), and the outcome lands on the turn's own event stream.
 *   2. The completed turn is saved to the notes after the response, without blocking it.
 *   3. Second turn: recall runs again, and turn 1 is not saved a second time.
 *   4. The person-level memory switch turns recall off and hands the choice back when cleared.
 */
import { z } from '@hono/zod-openapi';
import type { Turn, TurnInputItem } from '@truefoundry/trueforge-core/agent-session';
import configuration from '../../../src/config';
import { MarkdownMemoryClient } from '../../../src/runtime/memory/markdownMemoryClient';
import { MEMORY_FRAMING_SENTENCE } from '../../../src/runtime/memory/memoryCapability';
import { TurnStreamingEventSchema } from '../../../src/schemas/events';
import { GetTurnResponseSchema, ListTurnEventsResponseSchema } from '../../../src/schemas/turn';
import { MODEL_FQN, startApprovalTestServer, type ApprovalTestServer } from '../../fixtures/approvalTestServer';
import { FINAL_TEXT } from '../../fixtures/scriptedModelServer';

const TURN_TIMEOUT_MS = 60_000;
const RETAIN_POLL_TIMEOUT_MS = 5_000;
const MEMORY_TIMEOUT_MS = 5_000;

const SEEDED_NOTE = 'Allergic to shellfish, and prefers oat milk.';

const USER_MESSAGE_1 = 'Is shellfish okay for me, given what I am allergic to?';
const USER_MESSAGE_2 = 'Remind me which milk I prefer, oat or something else?';

function jsonInit(method: 'POST' | 'PUT', body: unknown): RequestInit {
  return { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) };
}

function agentSpec() {
  return {
    model: { name: MODEL_FQN },
    instructions: 'Answer plainly; no tools are needed for these tests.',
    config: {
      sandbox: { enabled: false },
      generative_ui: { enabled: false },
      ask_user_questions: { enabled: false },
      dynamic_sub_agents: { enabled: false },
      context_management: { compaction: { enabled: false }, large_tool_response: { enabled: false } },
    },
  };
}

function plainMessage(text: string): TurnInputItem[] {
  return [{ type: 'user.message', content: text }];
}

async function createSession(server: ApprovalTestServer, spec: ReturnType<typeof agentSpec>): Promise<string> {
  const response = await server.request('/api/v1/sessions', jsonInit('POST', { agent: { spec } }));
  const body: unknown = await response.json();
  if (response.status !== 201) {
    throw new Error(`session create failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return z.object({ data: z.object({ id: z.string() }).loose() }).parse(body).data.id;
}

function turnIdFromStream(streamBody: string): string {
  for (const line of streamBody.split('\n')) {
    if (!line.startsWith('data: ')) {
      continue;
    }
    const event = TurnStreamingEventSchema.parse(JSON.parse(line.slice('data: '.length)));
    if (event.type === 'turn.created') {
      return event.turn_id;
    }
  }
  throw new Error(`turn stream carried no turn.created event: ${streamBody.slice(0, 400)}`);
}

async function getTurn({
  server,
  sessionId,
  turnId,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  turnId: string;
}): Promise<Turn> {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`get turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return GetTurnResponseSchema.parse(body).data;
}

/** Runs one turn to completion by draining its SSE stream, then returns the persisted turn. */
async function runTurn({
  server,
  sessionId,
  input,
}: {
  server: ApprovalTestServer;
  sessionId: string;
  input: TurnInputItem[];
}): Promise<Turn> {
  const response = await server.request(
    `/api/v1/sessions/${sessionId}/turns`,
    jsonInit('POST', { input, stream: true }),
  );
  if (response.status !== 200) {
    const body: unknown = await response.json();
    throw new Error(`create turn failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  const turnId = turnIdFromStream(await response.text());
  return getTurn({ server, sessionId, turnId });
}

async function listTurnEvents(server: ApprovalTestServer, sessionId: string, turnId: string) {
  const response = await server.request(`/api/v1/sessions/${sessionId}/turns/${turnId}/events`);
  const body: unknown = await response.json();
  if (response.status !== 200) {
    throw new Error(`list turn events failed (${String(response.status)}): ${JSON.stringify(body)}`);
  }
  return ListTurnEventsResponseSchema.parse(body).data;
}

/** The text of one content part, or '' for a part that carries none. */
function partText(part: unknown): string {
  if (typeof part !== 'object' || part === null) {
    return '';
  }
  const text: unknown = Reflect.get(part, 'text');
  return typeof text === 'string' ? text : '';
}

function requiredActions(turn: Turn): unknown[] {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  return turn.state.required_actions;
}

/** Flattened text of the final `model.message` output, or '' when the turn paused without one. */
function outputText(turn: Turn): string {
  if (turn.state.status !== 'done') {
    throw new Error(`turn is not done: ${JSON.stringify(turn.state)}`);
  }
  const content = turn.state.output?.content;
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(partText).join('\n');
  }
  return '';
}

/** Flattens a scripted-model chat message's `content` (string or content-part array) to text. */
function contentText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content.map(partText).join(' ');
  }
  return '';
}

/** The line that opens a recalled-memory block; the static instruction only names the tag. */
const MEMORY_BLOCK_OPENING = '<aman-memory>\n';

function memoryBlockMessages(messages: readonly { role: string; content?: unknown }[]) {
  return messages.filter(message => contentText(message.content).includes(MEMORY_BLOCK_OPENING));
}

describe('Host-enforced memory: wiring through the real HTTP API and session store', () => {
  let server: ApprovalTestServer;
  let notes: MarkdownMemoryClient;
  let sessionId: string;
  let turn1: Turn;
  // With summaries off a turn is saved as it was said, so the test needs no scripted summary.
  const originalSummarize = configuration.MEMORY_SUMMARIZE;

  async function noteTexts(): Promise<string[]> {
    const listed = await notes.listEntries({ namespace: '', timeoutMs: MEMORY_TIMEOUT_MS });
    if (!listed.ok) {
      throw new Error(`the notes could not be listed: ${listed.reason}`);
    }
    return listed.entries.map(entry => entry.text);
  }

  async function recallEventOf(session: string, turnId: string) {
    const events = await listTurnEvents(server, session, turnId);
    const recallEvent = events.find(event => event.type === 'aman.memory.recall');
    if (!recallEvent) {
      throw new Error('expected an aman.memory.recall event on the turn');
    }
    return recallEvent;
  }

  beforeAll(async () => {
    configuration.MEMORY_SUMMARIZE = false;
    server = await startApprovalTestServer();
    notes = new MarkdownMemoryClient({ baseDir: configuration.MEMORY_MARKDOWN_DIR, namespace: 'default' });
    const seeded = await notes.retain({
      items: [
        {
          metadata: { origin: 'user_stated' },
          content: SEEDED_NOTE,
          timestamp: '2026-01-05T00:00:00.000Z',
          document_id: 'seeded-note-1',
        },
      ],
      operationId: 'seeded-op-1',
      timeoutMs: MEMORY_TIMEOUT_MS,
    });
    if (!seeded.ok) {
      throw new Error(`the seeded note could not be saved: ${seeded.reason}`);
    }
  }, TURN_TIMEOUT_MS);

  afterAll(async () => {
    configuration.MEMORY_SUMMARIZE = originalSummarize;
    await server.close();
  });

  it(
    'first turn: recalls before the model call, injects the block for that call only, and records the outcome',
    async () => {
      sessionId = await createSession(server, agentSpec());
      turn1 = await runTurn({ server, sessionId, input: plainMessage(USER_MESSAGE_1) });

      expect(requiredActions(turn1)).toEqual([]);
      expect(outputText(turn1)).toContain(FINAL_TEXT);

      // The scripted model saw the `<aman-memory>` block, carrying the saved note, in a host-context
      // message of its own. The person's words are the last message, alone and unchanged.
      const modelRequests = server.model.requests();
      const turn1ModelRequest = modelRequests[modelRequests.length - 1];
      if (!turn1ModelRequest) {
        throw new Error('expected the scripted model server to have received a request for turn 1');
      }
      const lastMessage = turn1ModelRequest.messages[turn1ModelRequest.messages.length - 1];
      expect(lastMessage?.role).toBe('user');
      expect(contentText(lastMessage?.content)).toBe(USER_MESSAGE_1);
      const contextMessage = turn1ModelRequest.messages[turn1ModelRequest.messages.length - 2];
      expect(contextMessage?.role).toBe('user');
      // The block is never in a system message, since recalled text is data, not instructions.
      expect(memoryBlockMessages(turn1ModelRequest.messages)).toEqual([contextMessage]);
      const contextText = contentText(contextMessage?.content);
      expect(contextText.indexOf("Today's date")).toBeGreaterThan(-1);
      expect(contextText.indexOf("Today's date")).toBeLessThan(contextText.indexOf(MEMORY_BLOCK_OPENING));
      expect(contextText).toContain(SEEDED_NOTE);
      expect(contextText).not.toContain(USER_MESSAGE_1);
      // The framing that marks recalled text as data stays inside the block the model reads.
      expect(contextText).toContain(MEMORY_FRAMING_SENTENCE);
      // The label says the notes are not the person's message and to answer the one that follows.
      expect(contextText).toContain("Answer the person's own message");

      // The turn's own persisted events carry the recall outcome, with the injected block as sent.
      const recallEvent = await recallEventOf(sessionId, turn1.id);
      expect(recallEvent.injected_block).toContain(SEEDED_NOTE);
      expect(recallEvent.stats.outcome).toBe('ok');
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'saves the completed turn to the notes after the response',
    async () => {
      let texts: string[] = [];
      const deadline = Date.now() + RETAIN_POLL_TIMEOUT_MS;
      while (!texts.some(text => text.includes(USER_MESSAGE_1)) && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 25));
        texts = await noteTexts();
      }
      const words = texts.filter(text => text.includes(USER_MESSAGE_1));
      expect(words).toHaveLength(1);
      // The person's words and the reply are saved apart, so each keeps its own source mark.
      expect(words[0]).not.toContain(FINAL_TEXT);
      expect(texts.some(text => text.includes(FINAL_TEXT) && !text.includes(USER_MESSAGE_1))).toBe(true);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'second turn: recalls again, and turn 1 is not saved a second time',
    async () => {
      const turn2 = await runTurn({ server, sessionId, input: plainMessage(USER_MESSAGE_2) });

      expect(requiredActions(turn2)).toEqual([]);
      expect((await recallEventOf(sessionId, turn2.id)).injected_block).toContain(SEEDED_NOTE);
      expect((await noteTexts()).filter(text => text.includes(USER_MESSAGE_1))).toHaveLength(1);

      // The stored thread context never carries the block turn 1 got: the history for turn 1's own
      // message stays clean, and exactly one message in this request carries a block, the one
      // added for turn 2.
      const modelRequests = server.model.requests();
      const turn2ModelRequest = modelRequests[modelRequests.length - 1];
      if (!turn2ModelRequest) {
        throw new Error('expected the scripted model server to have received a request for turn 2');
      }
      // The system prompt's own memory instructions mention the `<aman-memory>` tag by name, so
      // this counts only messages that carry the block's opening line.
      expect(memoryBlockMessages(turn2ModelRequest.messages)).toHaveLength(1);

      const turn1HistoryMessages = turn2ModelRequest.messages.filter(
        message => message.role === 'user' && contentText(message.content).includes(USER_MESSAGE_1),
      );
      expect(turn1HistoryMessages).toHaveLength(1);
      expect(contentText(turn1HistoryMessages[0]?.content)).not.toContain('<aman-memory>');

      const turn2Last = turn2ModelRequest.messages[turn2ModelRequest.messages.length - 1];
      expect(turn2Last?.role).toBe('user');
      expect(contentText(turn2Last?.content)).toBe(USER_MESSAGE_2);
    },
    TURN_TIMEOUT_MS,
  );

  it(
    'the person-level memory switch turns recall off for a chat on a saved agent',
    async () => {
      const created = await server.request(
        '/api/v1/agents',
        jsonInit('POST', { name: 'saved-assistant', description: 'Saved test agent.', manifest: agentSpec() }),
      );
      expect(created.status).toBe(201);
      const savedSession = async (): Promise<string> => {
        const response = await server.request(
          '/api/v1/sessions',
          jsonInit('POST', { agent: { name: 'saved-assistant' } }),
        );
        expect(response.status).toBe(201);
        return z.object({ data: z.object({ id: z.string() }).loose() }).parse(await response.json()).data.id;
      };

      // With the switch unset, the saved agent's own setting (on) applies and recall runs.
      const onSession = await savedSession();
      const onTurn = await runTurn({ server, sessionId: onSession, input: plainMessage(USER_MESSAGE_1) });
      expect((await recallEventOf(onSession, onTurn.id)).injected_block).toContain(SEEDED_NOTE);

      const off = await server.request('/api/v1/settings/memory-recalls', jsonInit('PUT', { enabled: false }));
      expect(off.status).toBe(200);
      expect(await off.json()).toEqual({ data: { enabled: false } });

      // A new chat with the same saved agent recalls nothing and sends no block to the model.
      const offSession = await savedSession();
      const offTurn = await runTurn({ server, sessionId: offSession, input: plainMessage(USER_MESSAGE_1) });
      expect(requiredActions(offTurn)).toEqual([]);
      expect((await recallEventOf(offSession, offTurn.id)).injected_block).toBeNull();
      const modelRequests = server.model.requests();
      const lastRequest = modelRequests[modelRequests.length - 1];
      expect(lastRequest ? memoryBlockMessages(lastRequest.messages) : undefined).toEqual([]);

      // Clearing the switch hands the choice back to the agent.
      const cleared = await server.request('/api/v1/settings/memory-recalls', jsonInit('PUT', { enabled: null }));
      expect(await cleared.json()).toEqual({ data: { enabled: null } });
      const backSession = await savedSession();
      const backTurn = await runTurn({ server, sessionId: backSession, input: plainMessage(USER_MESSAGE_1) });
      expect((await recallEventOf(backSession, backTurn.id)).injected_block).toContain(SEEDED_NOTE);
    },
    TURN_TIMEOUT_MS,
  );
});
