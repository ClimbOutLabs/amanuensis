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
    peekTip: async () => null,
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
});
