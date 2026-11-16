import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { ChatClient, ChatSummary } from '../src/chatClient.js';
import { saveInstanceStore } from '../src/instances.js';
import { FileKeyStore } from '../src/keyStore.js';
import { runOneShot } from '../src/oneShot.js';

const WEB = 'https://nora.example:8443';
const AT = '2026-11-15T12:00:00.000Z';

function fakeClient(overrides: Partial<ChatClient> = {}): ChatClient {
  return {
    listChats: async () => [],
    createChat: async (): Promise<ChatSummary> => ({
      id: 'session-1',
      title: 'New chat',
      personaName: 'Mannie',
      updatedAt: AT,
    }),
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

async function pairedConfigDir(): Promise<string> {
  const configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-oneshot-'));
  saveInstanceStore(configDir, {
    instances: [{ address: WEB, deviceName: 'Pippa', keyStore: 'file' }],
    activeAddress: WEB,
  });
  await new FileKeyStore(configDir).set({ address: WEB, key: 'aman_tk_test' });
  return configDir;
}

function capture(): {
  printed: string[];
  errors: string[];
  deps: { print: (line: string) => void; printError: (line: string) => void };
} {
  const printed: string[] = [];
  const errors: string[] = [];
  return {
    printed,
    errors,
    deps: {
      print: (line: string) => {
        printed.push(line);
      },
      printError: (line: string) => {
        errors.push(line);
      },
    },
  };
}

describe('one-shot mode', () => {
  it('prints the answer and exits at zero', async () => {
    const configDir = await pairedConfigDir();
    const { printed, errors, deps } = capture();
    const client = fakeClient({
      streamMessage: async function* () {
        yield {
          id: 'e1',
          type: 'turn.created',
          createdAt: AT,
          threadId: null,
          turnId: 'turn-1',
          previousTurnId: null,
          state: { status: 'running' },
          input: [{ type: 'user.message', content: 'When is the next train?' }],
        };
        yield {
          id: 'e2',
          type: 'model.message',
          createdAt: AT,
          threadId: 'thread-1',
          content: 'The next train is at 8:15.',
        };
        yield {
          id: 'e3',
          type: 'turn.done',
          createdAt: AT,
          threadId: null,
          state: { status: 'done', completedAt: AT, output: null, requiredActions: [] },
        };
      },
    });
    const code = await runOneShot({
      configDir,
      question: 'When is the next train?',
      deps: { ...deps, createChatClient: () => client },
    });
    expect(code).toBe(0);
    expect(printed).toEqual(['The next train is at 8:15.']);
    expect(errors).toEqual([]);
  });

  it('prints the waiting line and exits without approving when the turn holds an action', async () => {
    const configDir = await pairedConfigDir();
    const { printed, deps } = capture();
    const answerApproval = vi.fn();
    const client = fakeClient({
      streamMessage: async function* () {
        yield {
          id: 'e1',
          type: 'turn.created',
          createdAt: AT,
          threadId: null,
          turnId: 'turn-1',
          previousTurnId: null,
          state: { status: 'running' },
          input: [{ type: 'user.message', content: 'Send the summary to Pippa' }],
        };
        yield {
          id: 'e2',
          type: 'model.message',
          createdAt: AT,
          threadId: 'thread-1',
          content: '',
          toolCalls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'send_email', arguments: '{"subject":"Summary"}' },
              toolInfo: { type: 'truefoundry-system', name: 'send_email' },
            },
          ],
        };
        yield {
          id: 'e3',
          type: 'tool.approval_required',
          createdAt: AT,
          threadId: 'thread-1',
          toolCalls: [{ id: 'call-1', sourceEventId: 'e2' }],
        };
        yield {
          id: 'e4',
          type: 'turn.done',
          createdAt: AT,
          threadId: null,
          state: {
            status: 'done',
            completedAt: AT,
            output: null,
            requiredActions: [
              {
                id: 'e3',
                type: 'tool.approval_required',
                createdAt: AT,
                threadId: 'thread-1',
                toolCalls: [{ id: 'call-1', sourceEventId: 'e2' }],
              },
            ],
          },
        };
      },
      answerApproval: async function* (sessionId, approval, decision, hooks) {
        answerApproval(sessionId, approval, decision, hooks);
        yield* [];
        return 'done';
      },
    });
    const code = await runOneShot({
      configDir,
      question: 'Send the summary to Pippa',
      deps: { ...deps, createChatClient: () => client },
    });
    expect(code).toBe(1);
    expect(printed).toHaveLength(1);
    expect(printed[0]).toContain('waiting for an approval');
    expect(printed[0]).toContain(WEB);
    // No continuation call was made: the approval was never answered here.
    expect(answerApproval).not.toHaveBeenCalled();
  });

  it('names the pairing step and exits at one when nothing is paired', async () => {
    const configDir = mkdtempSync(path.join(tmpdir(), 'aman-tui-oneshot-'));
    const { printed, errors, deps } = capture();
    const code = await runOneShot({ configDir, question: 'Hello?', deps });
    expect(code).toBe(1);
    expect(printed).toEqual([]);
    expect(errors).toEqual(['No Aman is paired with this terminal yet. Pair one with: aman-tui login <address>']);
  });

  it('shows the plain failure line and exits at one when the answer never arrives', async () => {
    const configDir = await pairedConfigDir();
    const { printed, errors, deps } = capture();
    const client = fakeClient({
      streamMessage: async function* () {
        yield* [];
        throw new Error(
          'The connection to Aman was lost and the reply could not be rejoined. Send your message again.',
        );
      },
    });
    const code = await runOneShot({
      configDir,
      question: 'Hello?',
      deps: { ...deps, createChatClient: () => client },
    });
    expect(code).toBe(1);
    expect(printed).toEqual([]);
    expect(errors).toEqual([
      'The connection to Aman was lost and the reply could not be rejoined. Send your message again.',
    ]);
  });
});
