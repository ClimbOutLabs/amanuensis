import { TrueForgeError, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ChatClient, ChatSummary } from '../src/chatClient.js';
import type { ChatEvent } from '../src/chatEvents.js';
import { App } from '../src/components/App.js';
import { ChatList } from '../src/components/ChatList.js';
import { ChatView } from '../src/components/ChatView.js';
import { saveInstanceStore } from '../src/instances.js';
import { renderApp, type RenderedApp } from './renderHarness.js';

const WEB = 'https://nora.example:8443';
const AT = '2026-11-15T12:00:00.000Z';

const CHATS: ChatSummary[] = [
  { id: 'session-1', title: 'Weekend plans', personaName: 'Mannie', updatedAt: '2026-11-15T11:45:00.000Z' },
  { id: 'session-2', title: 'Invoices', personaName: null, updatedAt: '2026-11-14T09:00:00.000Z' },
];

function turnCreated(id: string, input: TrueForgeApi.TurnInputItem[]): ChatEvent {
  return {
    id,
    type: 'turn.created',
    createdAt: AT,
    threadId: null,
    turnId: 'turn-1',
    previousTurnId: null,
    state: { status: 'running' },
    input,
  };
}

function delta(id: string, content: string): ChatEvent {
  return { id, type: 'model.message.delta', threadId: 'thread-1', content };
}

function modelMessage(id: string, content: string, toolCalls?: TrueForgeApi.ToolCall[]): ChatEvent {
  return {
    id,
    type: 'model.message',
    createdAt: AT,
    threadId: 'thread-1',
    content,
    ...(toolCalls === undefined ? {} : { toolCalls }),
  };
}

function turnDone(id: string): ChatEvent {
  return {
    id,
    type: 'turn.done',
    createdAt: AT,
    threadId: null,
    state: { status: 'done', completedAt: AT, output: null, requiredActions: [] },
  };
}

function fakeClient(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    listChats: async () => CHATS,
    createChat: async () => ({ id: 'session-new', title: 'New chat', personaName: null, updatedAt: AT }),
    loadHistory: async () => [],
    streamMessage: async function* () {
      yield* [];
    },
    answerApproval: async function* () {
      yield* [];
      return 'unclear';
    },
    stopTurn: async () => undefined,
    pendingApprovals: async () => [],
    peekTip: async () => null,
    retryConnectionNow: () => undefined,
    ...overrides,
  };
}

async function untilText(app: RenderedApp, text: string): Promise<void> {
  await vi.waitFor(
    () => {
      expect(app.text()).toContain(text);
    },
    { timeout: 10000, interval: 20 },
  );
}

/** Types a message and sends it, waiting for the typing to land before Enter, as separate key events. */
async function typeAndSend(app: RenderedApp, text: string): Promise<void> {
  app.write(text);
  await untilText(app, `› ${text}`);
  app.write('\r');
}

describe('ChatList', () => {
  it('renders the chats with persona and last activity, and opens the picked one', async () => {
    const onOpen = vi.fn();
    const app = renderApp(
      <ChatList
        client={fakeClient()}
        address={WEB}
        instanceCount={1}
        onOpen={onOpen}
        onSwitchInstance={() => undefined}
        onExit={() => undefined}
      />,
    );
    await untilText(app, 'Weekend plans');
    const frame = app.text();
    expect(frame).toContain('Mannie');
    expect(frame).toContain('Invoices');
    // The keypress is retried until it lands: the input listener attaches a
    // beat after the list first paints.
    await vi.waitFor(
      () => {
        app.write('\r');
        expect(onOpen).toHaveBeenCalledWith(CHATS[0]);
      },
      { timeout: 10000, interval: 50 },
    );
    app.unmount();
  });

  it('starts a new chat on N', async () => {
    const onOpen = vi.fn();
    const client = fakeClient();
    const app = renderApp(
      <ChatList
        client={client}
        address={WEB}
        instanceCount={1}
        onOpen={onOpen}
        onSwitchInstance={() => undefined}
        onExit={() => undefined}
      />,
    );
    await untilText(app, 'Weekend plans');
    await vi.waitFor(
      () => {
        app.write('n');
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-new' }));
      },
      { timeout: 10000, interval: 50 },
    );
    app.unmount();
  });

  it('starts a new chat on a capital N, and leaves on a capital Q', async () => {
    const onOpen = vi.fn();
    const onExit = vi.fn();
    const app = renderApp(
      <ChatList
        client={fakeClient()}
        address={WEB}
        instanceCount={1}
        onOpen={onOpen}
        onSwitchInstance={() => undefined}
        onExit={onExit}
      />,
    );
    await untilText(app, 'Weekend plans');
    // A terminal sends the capital when Shift is held, and the footer names
    // the keys in capitals, so the capital has to work too.
    await vi.waitFor(
      () => {
        app.write('N');
        expect(onOpen).toHaveBeenCalledWith(expect.objectContaining({ id: 'session-new' }));
      },
      { timeout: 10000, interval: 50 },
    );
    await vi.waitFor(
      () => {
        app.write('Q');
        expect(onExit).toHaveBeenCalled();
      },
      { timeout: 10000, interval: 50 },
    );
    app.unmount();
  });
});

describe('ChatList errors', () => {
  it('shows the re-pair line and no raw error body when the key was refused', async () => {
    const refused = new TrueForgeError({
      statusCode: 401,
      body: { error: { message: 'Authentication required.' } },
    });
    const app = renderApp(
      <ChatList
        client={fakeClient({
          listChats: async (): Promise<ChatSummary[]> => {
            throw refused;
          },
        })}
        address={WEB}
        instanceCount={1}
        onOpen={() => undefined}
        onSwitchInstance={() => undefined}
        onExit={() => undefined}
      />,
    );
    await untilText(app, `Pair again with: aman-tui login ${WEB}`);
    const frame = app.text();
    expect(frame).toContain('Aman no longer accepts this terminal');
    expect(frame).not.toContain('Status code');
    expect(frame).not.toContain('"error"');
    expect(frame).not.toContain('Press R to try again');
    app.unmount();
  });

  it("shows the server's own line for a plain server error, with trying again on offer", async () => {
    const failed = new TrueForgeError({
      statusCode: 500,
      body: { error: { message: 'The chats are taking a break.' } },
    });
    const app = renderApp(
      <ChatList
        client={fakeClient({
          listChats: async (): Promise<ChatSummary[]> => {
            throw failed;
          },
        })}
        address={WEB}
        instanceCount={1}
        onOpen={() => undefined}
        onSwitchInstance={() => undefined}
        onExit={() => undefined}
      />,
    );
    await untilText(app, 'The chats are taking a break.');
    const frame = app.text();
    expect(frame).not.toContain('Status code');
    expect(frame).not.toContain('"error"');
    expect(frame).toContain('Press R to try again');
    app.unmount();
  });

  it('reloads on a capital R after a plain server error', async () => {
    const failed = new TrueForgeError({
      statusCode: 500,
      body: { error: { message: 'The chats are taking a break.' } },
    });
    let calls = 0;
    const app = renderApp(
      <ChatList
        client={fakeClient({
          listChats: async (): Promise<ChatSummary[]> => {
            calls += 1;
            if (calls === 1) {
              throw failed;
            }
            return CHATS;
          },
        })}
        address={WEB}
        instanceCount={1}
        onOpen={() => undefined}
        onSwitchInstance={() => undefined}
        onExit={() => undefined}
      />,
    );
    await untilText(app, 'Press R to try again');
    await vi.waitFor(
      () => {
        app.write('R');
        expect(app.text()).toContain('Weekend plans');
      },
      { timeout: 10000, interval: 50 },
    );
    expect(calls).toBe(2);
    app.unmount();
  });
});

describe('App startup', () => {
  it('lands on the pair-again screen when the key store cannot be read', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-app-'));
    saveInstanceStore(configDir, {
      instances: [{ address: WEB, deviceName: 'Pippa', keyStore: 'keychain' }],
      activeAddress: WEB,
    });
    const app = renderApp(<App configDir={configDir} />);
    await untilText(app, 'is not on this computer any more');
    expect(app.text()).toContain(`aman-tui login ${WEB}`);
    app.unmount();
  });
});

describe('ChatView', () => {
  it('renders saved history, then a streamed reply as it arrives', async () => {
    const client = fakeClient({
      loadHistory: async () => [
        turnCreated('e1', [{ type: 'user.message', content: 'Old question' }]),
        modelMessage('e2', 'Old answer'),
        turnDone('e3'),
      ],
      streamMessage: async function* () {
        yield turnCreated('e4', [{ type: 'user.message', content: 'Hello' }]);
        yield delta('e5', 'Hi ');
        yield delta('e6', 'Nora');
        yield modelMessage('e7', 'Hi Nora');
        yield turnDone('e8');
      },
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Weekend plans"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, 'Old answer');
    await typeAndSend(app, 'Hello');
    await untilText(app, 'Hi Nora');
    app.unmount();
  });

  it('renders a tool card with its outcome', async () => {
    const client = fakeClient({
      streamMessage: async function* () {
        yield turnCreated('e1', [{ type: 'user.message', content: 'Find my invoices' }]);
        yield modelMessage('e2', '', [
          {
            id: 'call-1',
            type: 'function',
            function: { name: 'mcp__gmail__search_email', arguments: '{"query":"invoices"}' },
            toolInfo: { type: 'mcp', name: 'search_email', serverId: 'gmail', serverName: 'Gmail' },
          },
        ]);
        yield {
          id: 'e3',
          type: 'tool.execution_started',
          createdAt: AT,
          threadId: 'thread-1',
          toolCallId: 'call-1',
          toolName: 'mcp__gmail__search_email',
        };
        yield {
          id: 'e4',
          type: 'tool.response.v2',
          createdAt: AT,
          threadId: 'thread-1',
          toolCallId: 'call-1',
          content: '',
          disposition: 'executed_ok',
          admissionProvenance: { source: 'automatic' },
        };
        yield turnDone('e5');
      },
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Invoices"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, '›');
    await typeAndSend(app, 'Find my invoices');
    await untilText(app, 'Search email');
    await untilText(app, 'Done');
    app.unmount();
  });

  it('shows the cannot-show line for a picture in the chat', async () => {
    const client = fakeClient({
      loadHistory: async () => [
        turnCreated('e1', [
          {
            type: 'user.message',
            content: [
              { type: 'text', text: 'What is in this picture?' },
              { type: 'file', name: 'garden.png', data: 'aGVsbG8=' },
            ],
          },
        ]),
        turnDone('e2'),
      ],
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Garden"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, 'cannot show');
    expect(app.text()).toContain(WEB);
    app.unmount();
  });

  it('shows the re-pair line and no raw error body when the key was refused', async () => {
    const refused = new TrueForgeError({
      statusCode: 401,
      body: { error: { message: 'Authentication required.' } },
    });
    const client = fakeClient({
      loadHistory: async (): Promise<ChatEvent[]> => {
        throw refused;
      },
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Weekend plans"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, "no longer accepts this terminal's key");
    // The line wraps on a narrow terminal, so the words are matched with the
    // wrapping folded away, as a person reading it would see them.
    const frame = app.text().replace(/\s+/g, ' ');
    expect(frame).toContain(`Pair again with: aman-tui login ${WEB}`);
    expect(frame).not.toContain('Status code');
    expect(frame).not.toContain('"error"');
    app.unmount();
  });

  it('shows the re-pair line when the key is refused mid-chat on send', async () => {
    const refused = new TrueForgeError({
      statusCode: 401,
      body: { error: { message: 'Authentication required.' } },
    });
    const client = fakeClient({
      streamMessage: async function* () {
        yield* [];
        throw refused;
      },
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Weekend plans"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, '›');
    await typeAndSend(app, 'Hello');
    await untilText(app, "no longer accepts this terminal's key");
    const frame = app.text().replace(/\s+/g, ' ');
    expect(frame).toContain(`Pair again with: aman-tui login ${WEB}`);
    expect(frame).not.toContain('Check your connection, then send your message again');
    app.unmount();
  });

  it('shows the lost line while a dropped reply rejoins, then the reply', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const client = fakeClient({
      streamMessage: async function* (_sessionId, _text, hooks) {
        yield turnCreated('e1', [{ type: 'user.message', content: 'Hello' }]);
        yield delta('e2', 'Hel');
        hooks?.onConnectionLost?.();
        await gate;
        yield modelMessage('e3', 'Hello Nora');
        yield turnDone('e4');
      },
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Weekend plans"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, '›');
    await typeAndSend(app, 'Hello');
    await untilText(app, 'The connection was lost.');
    expect(app.text()).toContain('Press R to retry now');
    release();
    await untilText(app, 'Hello Nora');
    app.unmount();
  });

  it('retries the rejoin at once on a capital R while the connection is lost', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>(resolve => {
      release = resolve;
    });
    const retryConnectionNow = vi.fn();
    const client = fakeClient({
      streamMessage: async function* (_sessionId, _text, hooks) {
        yield turnCreated('e1', [{ type: 'user.message', content: 'Hello' }]);
        hooks?.onConnectionLost?.();
        await gate;
        yield modelMessage('e3', 'Hello Nora');
        yield turnDone('e4');
      },
      retryConnectionNow,
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Weekend plans"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, '›');
    await typeAndSend(app, 'Hello');
    await untilText(app, 'The connection was lost.');
    await vi.waitFor(
      () => {
        app.write('R');
        expect(retryConnectionNow).toHaveBeenCalled();
      },
      { timeout: 10000, interval: 50 },
    );
    release();
    await untilText(app, 'Hello Nora');
    app.unmount();
  });

  it('stops a streaming reply on Esc, keeping what had arrived', async () => {
    let releaseStop: () => void = () => undefined;
    const stopGate = new Promise<void>(resolve => {
      releaseStop = resolve;
    });
    const stopTurn = vi.fn(async () => {
      releaseStop();
    });
    const client = fakeClient({
      streamMessage: async function* () {
        yield turnCreated('e1', [{ type: 'user.message', content: 'Tell me a story' }]);
        yield delta('e2', 'Once upon a');
        await stopGate;
        yield {
          id: 'e3',
          type: 'turn.done',
          createdAt: AT,
          threadId: null,
          state: { status: 'cancelled', completedAt: AT, reason: 'client-cancelled' },
        } satisfies ChatEvent;
      },
      stopTurn,
    });
    const app = renderApp(
      <ChatView
        client={client}
        sessionId="session-1"
        title="Stories"
        speakerName="Mannie"
        webAddress={WEB}
        onBack={() => undefined}
      />,
    );
    await untilText(app, '›');
    await typeAndSend(app, 'Tell me a story');
    await untilText(app, 'Once upon a');
    await vi.waitFor(
      () => {
        app.write('\u001b');
        expect(stopTurn).toHaveBeenCalledWith('session-1');
      },
      { timeout: 10000, interval: 50 },
    );
    await untilText(app, 'This reply was stopped.');
    expect(app.text()).toContain('Once upon a');
    app.unmount();
  });
});

const BODY_LINES = Array.from({ length: 30 }, (_, index) => `Body line ${String(index + 1)} of the message.`);
const LONG_BODY = [...BODY_LINES, 'The last line mentions the 8:15 train.'].join('\n');

const EMAIL_CARD: TrueForgeApi.Tier3Card = {
  amount: null,
  cannotBeUndone: null,
  copy: { headline: 'Send this email to Pippa?', consequence: 'Once it is sent, it cannot be unsent.', reason: null },
  destination: null,
  destinationHost: null,
  mailFrom: 'nora@example.com',
  outboundText: null,
  outboundTruncated: false,
  parsedCommand: null,
  plainWhat: 'Send an email to Pippa.',
  plainWhy: 'You asked for the train summary to go to Pippa.',
  recipient: null,
  whyAskedAgain: null,
  safeChoice: true,
  email: {
    action: 'send',
    to: [{ address: 'pippa@example.com', name: 'Pippa' }],
    cc: [{ address: 'sam@example.com', name: '' }],
    bcc: [],
    subject: 'Train times',
    body: LONG_BODY,
    checkCode: 'K7Q2',
    replaces: null,
    replyInThread: null,
  },
};

function sendEmailToolCall(): TrueForgeApi.ToolCall {
  return {
    id: 'call-1',
    type: 'function',
    function: { name: 'send_email', arguments: '{"subject":"Train times"}' },
    toolInfo: { type: 'truefoundry-system', name: 'send_email' },
  };
}

function approvalRequiredEvent(
  id: string,
  card: TrueForgeApi.Tier3Card | null,
): TrueForgeApi.ToolApprovalRequiredEvent {
  return {
    id,
    type: 'tool.approval_required',
    createdAt: AT,
    threadId: 'thread-1',
    toolCalls: [{ id: 'call-1', sourceEventId: 'e2', tier3Card: card, canAlwaysAllow: true }],
  };
}

function heldTurn(overrides: Partial<ChatClient>, card: TrueForgeApi.Tier3Card | null = EMAIL_CARD): ChatClient {
  return fakeClient({
    streamMessage: async function* () {
      yield turnCreated('e1', [{ type: 'user.message', content: 'Send the summary to Pippa' }]);
      yield modelMessage('e2', '', [sendEmailToolCall()]);
      yield approvalRequiredEvent('e3', card);
      yield {
        id: 'e4',
        type: 'turn.done',
        createdAt: AT,
        threadId: null,
        state: {
          status: 'done',
          completedAt: AT,
          output: null,
          requiredActions: [approvalRequiredEvent('e3', card)],
        },
      } satisfies ChatEvent;
    },
    ...overrides,
  });
}

function renderChat(client: ChatClient): RenderedApp {
  return renderApp(
    <ChatView
      client={client}
      sessionId="session-1"
      title="Weekend plans"
      speakerName="Mannie"
      webAddress={WEB}
      onBack={() => undefined}
    />,
  );
}

describe('ChatView approvals', () => {
  it('shows the whole email draft, never approves on Enter, scrolls to every word, and approves on A', async () => {
    const answerApproval = vi.fn();
    const client = heldTurn({
      answerApproval: async function* (sessionId, approval, decision) {
        answerApproval(sessionId, approval, decision);
        yield {
          id: 'e5',
          type: 'tool.response.v2',
          createdAt: AT,
          threadId: 'thread-1',
          toolCallId: 'call-1',
          content: '',
          disposition: 'executed_ok',
          admissionProvenance: { source: 'automatic' },
        } satisfies ChatEvent;
        yield modelMessage('e6', 'Sent.');
        yield turnDone('e7');
        return 'done';
      },
    });
    const app = renderChat(client);
    await untilText(app, '›');
    await typeAndSend(app, 'Send the summary to Pippa');
    await untilText(app, 'Waiting for your OK');
    const frame = app.text();
    expect(frame).toContain('Send this email to Pippa?');
    expect(frame).toContain('From: nora@example.com');
    expect(frame).toContain('To: Pippa (pippa@example.com)');
    expect(frame).toContain('Subject: Train times');
    expect(frame).toContain('Body line 1 of the message.');
    // The end of the draft is not on screen yet, and nothing of it was cut.
    expect(frame).not.toContain('The last line mentions the 8:15 train.');
    // Enter sends chat messages. It never approves.
    app.write('\r');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(answerApproval).not.toHaveBeenCalled();
    // Scrolling reaches the last word of the draft.
    await vi.waitFor(
      () => {
        app.write('\u001b[B');
        expect(app.text()).toContain('The last line mentions the 8:15 train.');
      },
      { timeout: 10000, interval: 30 },
    );
    // The deliberate key answers through the continuation, and the turn resumes.
    await vi.waitFor(
      () => {
        app.write('a');
        expect(answerApproval).toHaveBeenCalled();
      },
      { timeout: 10000, interval: 50 },
    );
    expect(answerApproval.mock.calls[0]?.[1]).toMatchObject({ toolCallId: 'call-1', threadId: 'thread-1' });
    expect(answerApproval.mock.calls[0]?.[2]).toBe('approve');
    await untilText(app, 'Approved and done.');
    app.unmount();
  });

  it('denies on D and shows the denied line', async () => {
    const answerApproval = vi.fn();
    const client = heldTurn({
      answerApproval: async function* (sessionId, approval, decision) {
        answerApproval(sessionId, approval, decision);
        yield {
          id: 'e5',
          type: 'tool.response.v2',
          createdAt: AT,
          threadId: 'thread-1',
          toolCallId: 'call-1',
          content: '',
          disposition: 'denied',
          admissionProvenance: { source: 'automatic' },
        } satisfies ChatEvent;
        yield turnDone('e6');
        return 'not_run';
      },
    });
    const app = renderChat(client);
    await untilText(app, '›');
    await typeAndSend(app, 'Send the summary to Pippa');
    await untilText(app, 'Waiting for your OK');
    expect(app.text()).toContain("D: Don't send");
    await vi.waitFor(
      () => {
        app.write('d');
        expect(answerApproval).toHaveBeenCalled();
      },
      { timeout: 10000, interval: 50 },
    );
    expect(answerApproval.mock.calls[0]?.[2]).toBe('deny');
    await untilText(app, 'Denied. Nothing was done.');
    app.unmount();
  });

  it('shows the moved-on line when the answer comes back stale', async () => {
    const stale = new TrueForgeError({
      statusCode: 409,
      body: { error: { message: 'Stale.', code: 'stale_approval_continuation' } },
    });
    const client = heldTurn({
      answerApproval: async function* () {
        yield* [];
        throw stale;
      },
    });
    const app = renderChat(client);
    await untilText(app, '›');
    await typeAndSend(app, 'Send the summary to Pippa');
    await untilText(app, 'Waiting for your OK');
    app.write('a');
    await untilText(app, 'The chat moved on before this was answered.');
    expect(app.text()).toContain('Nothing was approved or run.');
    app.unmount();
  });

  it('shows the already-answered line on a conflict, and the ended line when the request is over', async () => {
    const conflict = new TrueForgeError({
      statusCode: 409,
      body: { error: { message: 'Conflict.', code: 'approval_conflict' } },
    });
    const conflictApp = renderChat(
      heldTurn({
        answerApproval: async function* () {
          yield* [];
          throw conflict;
        },
      }),
    );
    await untilText(conflictApp, '›');
    await typeAndSend(conflictApp, 'Send the summary to Pippa');
    await untilText(conflictApp, 'Waiting for your OK');
    conflictApp.write('a');
    await untilText(conflictApp, 'This was already answered, or the chat has moved on.');
    conflictApp.unmount();

    const ended = new TrueForgeError({
      statusCode: 409,
      body: { error: { message: 'Ended.', code: 'approval_request_ended' } },
    });
    const endedApp = renderChat(
      heldTurn({
        answerApproval: async function* () {
          yield* [];
          throw ended;
        },
      }),
    );
    await untilText(endedApp, '›');
    await typeAndSend(endedApp, 'Send the summary to Pippa');
    await untilText(endedApp, 'Waiting for your OK');
    endedApp.write('a');
    await untilText(endedApp, 'This request ended. Ask again if you still need it.');
    endedApp.unmount();
  });

  it('keeps the approval and shows the still-working line when the answer is refused as too early', async () => {
    const running = new TrueForgeError({
      statusCode: 409,
      body: { error: { message: 'Running.', code: 'previous_turn_running' } },
    });
    let attempts = 0;
    const client = heldTurn({
      answerApproval: async function* () {
        attempts += 1;
        if (attempts === 1) {
          throw running;
        }
        yield {
          id: 'e5',
          type: 'tool.response.v2',
          createdAt: AT,
          threadId: 'thread-1',
          toolCallId: 'call-1',
          content: '',
          disposition: 'executed_ok',
          admissionProvenance: { source: 'automatic' },
        } satisfies ChatEvent;
        yield turnDone('e6');
        return 'done';
      },
    });
    const app = renderChat(client);
    await untilText(app, '›');
    await typeAndSend(app, 'Send the summary to Pippa');
    await untilText(app, 'Waiting for your OK');
    await vi.waitFor(
      () => {
        app.write('a');
        expect(attempts).toBe(1);
      },
      { timeout: 10000, interval: 50 },
    );
    await untilText(app, 'is still working on your last message');
    // The approval stayed: answering again works.
    await vi.waitFor(
      () => {
        app.write('a');
        expect(attempts).toBe(2);
      },
      { timeout: 10000, interval: 50 },
    );
    await untilText(app, 'Approved and done.');
    app.unmount();
  });

  it('never offers always allow on a new-recipient card, even when the server flag would allow it', async () => {
    const answerApproval = vi.fn();
    const card: TrueForgeApi.Tier3Card = {
      ...EMAIL_CARD,
      mailNewRecipients: ['pippa@example.com'],
      plainWhat: 'Pippa is not on your send list. Approving adds pippa@example.com to it, then sends.',
    };
    const client = heldTurn(
      {
        answerApproval: async function* (sessionId, approval, decision) {
          answerApproval(sessionId, approval, decision);
          yield {
            id: 'e5',
            type: 'tool.response.v2',
            createdAt: AT,
            threadId: 'thread-1',
            toolCallId: 'call-1',
            content: '',
            disposition: 'executed_ok',
            admissionProvenance: { source: 'automatic' },
          } satisfies ChatEvent;
          yield turnDone('e6');
          return 'done';
        },
      },
      card,
    );
    const app = renderChat(client);
    await untilText(app, '›');
    await typeAndSend(app, 'Send the summary to Pippa');
    await untilText(app, 'Waiting for your OK');
    const frame = app.text();
    expect(frame).toContain('A: Add and send');
    expect(frame).not.toContain('Always allow everywhere');
    // Shift+A is not an answer on this card, whatever the server flag said.
    app.write('A');
    await new Promise(resolve => setTimeout(resolve, 200));
    expect(answerApproval).not.toHaveBeenCalled();
    // The plain approve answer still works.
    await vi.waitFor(
      () => {
        app.write('a');
        expect(answerApproval).toHaveBeenCalled();
      },
      { timeout: 10000, interval: 50 },
    );
    expect(answerApproval.mock.calls[0]?.[2]).toBe('approve');
    await untilText(app, 'Approved and done.');
    app.unmount();
  });

  it('answers a plan grant the same way, from its tool name alone', async () => {
    const answerApproval = vi.fn();
    const client = heldTurn(
      {
        answerApproval: async function* (sessionId, approval, decision) {
          answerApproval(sessionId, approval, decision);
          yield {
            id: 'e5',
            type: 'tool.response.v2',
            createdAt: AT,
            threadId: 'thread-1',
            toolCallId: 'call-1',
            content: '',
            disposition: 'executed_ok',
            admissionProvenance: { source: 'automatic' },
          } satisfies ChatEvent;
          yield turnDone('e6');
          return 'done';
        },
      },
      null,
    );
    const app = renderChat(client);
    await untilText(app, '›');
    await typeAndSend(app, 'Send the summary to Pippa');
    await untilText(app, 'Waiting for your OK');
    expect(app.text()).toContain('Needs your OK');
    await vi.waitFor(
      () => {
        app.write('a');
        expect(answerApproval).toHaveBeenCalled();
      },
      { timeout: 10000, interval: 50 },
    );
    expect(answerApproval.mock.calls[0]?.[2]).toBe('approve');
    await untilText(app, 'Approved and done.');
    app.unmount();
  });
});
