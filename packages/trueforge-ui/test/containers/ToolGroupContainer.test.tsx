// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { AgentDetailsPreferenceProvider } from '@/server/AgentDetailsPreferenceContext.js';
import { ServerProvider } from '@/server/ServerContext.js';
import type { Session } from '@/server/types.js';
import { createMockAgentUIServer } from '../server/mockServer.js';
import { RuntimeHarness } from './RuntimeHarness.js';

const SESSION_ID = 'session-tool-group';

/** A server whose one session already carries the chat-level "Show agent details" preference on. */
const expandedServer = createMockAgentUIServer({
  getSession: async ({ sessionId }) => {
    const session: Session & { metadata: Record<string, string> } = {
      id: sessionId,
      isMutable: true,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
      metadata: { agent_details: 'expanded' },
    };
    return session;
  },
});

/**
 * Renders one assistant message. `expanded` simulates the chat-level "Show agent details" switch
 * being on for this session; omit it to render with the switch off (the collapsed default).
 */
function renderMultiToolMessage(
  content: ThreadMessageLike['content'],
  options: { isRunning?: boolean; expanded?: boolean } = {},
) {
  const message: ThreadMessageLike = { role: 'assistant', content };
  const tree =
    options.expanded === true ? (
      <ServerProvider server={expandedServer}>
        <AgentDetailsPreferenceProvider>
          <RuntimeHarness messages={[message]} isRunning={options.isRunning} threadId="thread-1" remoteId={SESSION_ID}>
            <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
          </RuntimeHarness>
        </AgentDetailsPreferenceProvider>
      </ServerProvider>
    ) : (
      <RuntimeHarness messages={[message]} isRunning={options.isRunning}>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </RuntimeHarness>
    );
  return render(tree);
}

describe('AgentSteps grouping', () => {
  it('groups consecutive tool calls under the agent internals disclosure', async () => {
    renderMultiToolMessage([
      { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {}, result: 'a' },
      { type: 'tool-call', toolCallId: '2', toolName: 'second_tool', args: {}, result: 'b' },
    ]);
    // With the chat-level switch off, the turn collapses into the faint one-line summary.
    expect(screen.getByRole('region', { name: '2 steps · 2 tools' })).toBeInTheDocument();
    expect(screen.getByText('First Tool')).not.toBeVisible();
  });

  it('renders both nested tool calls once expanded (defaultOpen)', () => {
    renderMultiToolMessage([
      { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {} },
      { type: 'tool-call', toolCallId: '2', toolName: 'second_tool', args: {} },
    ]);
    expect(screen.getByText('First Tool')).toBeInTheDocument();
    expect(screen.getByText('Second Tool')).toBeInTheDocument();
  });

  it('reveals the grouped tool calls when the chat-level switch is on', async () => {
    renderMultiToolMessage(
      [
        { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {} },
        { type: 'tool-call', toolCallId: '2', toolName: 'second_tool', args: {} },
      ],
      { expanded: true },
    );
    expect(await screen.findByText('First Tool')).toBeVisible();
    expect(screen.getByText('Second Tool')).toBeVisible();
  });

  it('uses singular label for exactly one tool call in the group', () => {
    renderMultiToolMessage([{ type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {} }]);
    expect(screen.getByRole('region', { name: '1 step · 1 tool' })).toBeInTheDocument();
  });

  it('renders text written before a tool call as ordinary answer text outside the internals', async () => {
    renderMultiToolMessage(
      [
        { type: 'text', text: "I'll delegate this to a sub-agent." },
        { type: 'tool-call', toolCallId: '1', toolName: 'first_tool', args: {}, result: 'a' },
        { type: 'text', text: 'Here is the final answer.' },
      ],
      { expanded: true },
    );
    const intermediate = await screen.findByText("I'll delegate this to a sub-agent.");
    expect(intermediate.closest('.text-text-secondary')).toBeNull();
    expect(intermediate.closest('[data-testid="assistant-message-agent-internals"]')).toBeNull();
    const finalAnswer = screen.getByText('Here is the final answer.');
    expect(finalAnswer.closest('[data-testid="assistant-message-agent-internals"]')).toBeNull();
  });
});
