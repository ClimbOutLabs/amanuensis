// @vitest-environment jsdom
import { ThreadPrimitive, type ThreadMessageLike } from '@assistant-ui/react';
import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { AssistantMessageContainer } from '@/containers/AssistantMessageContainer.js';
import { DeliveriesProvider } from '@/deliveries/DeliveriesContext.js';
import { fakeServer } from '../deliveries/fakeDeliveriesApi.js';
import { AgentDetailsHarness, settleAgentDetails } from './agentDetailsHarness.js';
import { RuntimeHarness } from './RuntimeHarness.js';

// The orb draws on a 2d canvas context, which jsdom does not implement; stub it like the
// AssistantMessageContainer suite does.
// This device could take notices but has not turned them on, so the offer is due.
vi.mock('@/deliveries/pushDevice.js', () => ({
  pushSupport: () => ({ blocker: null, permission: 'default' }),
  currentPushSubscription: () => Promise.resolve(null),
  enablePush: () => Promise.resolve(),
}));

vi.mock('thinking-orbs', () => ({
  ThinkingOrb: ({ state }: { state: string }) => <div data-testid="thinking-orb" data-state={state} />,
}));

function envelope(result: unknown, disposition = 'executed_ok'): unknown {
  return { schema_version: 'tool.response.v2', outcome: { disposition }, result };
}

function mcpText(value: unknown): unknown {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

const REMINDER_LINE = 'Reminder set for Friday, October 30 at 9:00 AM: nudge me if Imperial & Legal go quiet';

type ToolCallContentPart = {
  type: 'tool-call';
  toolCallId: string;
  toolName: string;
  args: { what: string };
  result: unknown;
};

function reminderPart(toolCallId: string): ToolCallContentPart {
  return {
    type: 'tool-call',
    toolCallId,
    toolName: 'set_reminder',
    args: { what: 'nudge me if Imperial & Legal go quiet' },
    result: envelope(
      mcpText({
        set: {
          id: 'rem-1',
          what: 'nudge me if Imperial & Legal go quiet',
          when: 'Once, on Friday, October 30 at 9:00 AM',
          time_zone: 'America/Los_Angeles',
          repeats: false,
          next: 'Friday, October 30 at 9:00 AM',
        },
      }),
    ),
  };
}

function reminderTurn(toolCallId: string): ThreadMessageLike {
  return {
    role: 'assistant',
    content: [reminderPart(toolCallId), { type: 'text', text: 'Set. I will nudge you Friday if they go quiet.' }],
  };
}

/** Details off is the plain RuntimeHarness: no session, so the chat's switch has never been turned on. */
function renderDetailsOff(messages: ThreadMessageLike[], options: { isRunning?: boolean } = {}) {
  return render(
    <RuntimeHarness messages={messages} isRunning={options.isRunning}>
      <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
    </RuntimeHarness>,
  );
}

describe('AssistantMessageContainer outcome lines', () => {
  it('shows a finished reminder turn’s outcome under the reply while details are off', () => {
    renderDetailsOff([reminderTurn('rem-1')]);
    const line = screen.getByTestId('assistant-message-outcome');
    expect(line).toHaveTextContent(REMINDER_LINE);
    // The line lives in the normal message surface: there is no internals container to hide it in.
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
    expect(line.closest('[data-testid="assistant-message-agent-internals"]')).toBeNull();
  });

  it('shows calendar and email outcomes from the same turn, one line each', () => {
    const turn: ThreadMessageLike = {
      role: 'assistant',
      content: [
        {
          type: 'tool-call',
          toolCallId: 'evt-1',
          toolName: 'create_event',
          args: { title: 'Dentist', start: '2026-10-30T09:00', end: '2026-10-30T10:00' },
          result: envelope(
            mcpText({ status: 'created', title: 'Dentist', when: 'Friday, October 30, 9:00 AM to 10:00 AM' }),
          ),
        },
        {
          type: 'tool-call',
          toolCallId: 'mail-1',
          toolName: 'send_email',
          args: { recipients: ['dana@example.com'], subject: 'Friday', body: 'See you then.' },
          result: envelope(mcpText({ message_id: 'msg-1' })),
        },
        { type: 'text', text: 'Done.' },
      ],
    };
    renderDetailsOff([turn]);
    const lines = screen.getAllByTestId('assistant-message-outcome');
    expect(lines.map(line => line.textContent)).toEqual([
      'Added to your calendar: Dentist, Friday, October 30, 9:00 AM to 10:00 AM',
      'Email sent to dana@example.com',
    ]);
  });

  it('shows no outcome line for a plain answer', () => {
    renderDetailsOff([{ role: 'assistant', content: [{ type: 'text', text: 'Just an answer.' }] }]);
    expect(screen.queryByTestId('assistant-message-outcome')).not.toBeInTheDocument();
  });

  it('keeps an earlier turn’s line on its own message and shows none for the running turn', () => {
    const running: ThreadMessageLike = {
      role: 'assistant',
      status: { type: 'running' },
      content: [reminderPart('rem-2'), { type: 'text', text: 'Setting it now.' }],
    };
    const { container } = renderDetailsOff([reminderTurn('rem-1'), running], { isRunning: true });
    const lines = screen.getAllByTestId('assistant-message-outcome');
    expect(lines).toHaveLength(1);
    expect(lines[0]).toHaveTextContent(REMINDER_LINE);
    const roots = container.querySelectorAll('[data-role="assistant"]');
    expect(roots).toHaveLength(2);
    expect(lines[0] !== undefined && roots[0]?.contains(lines[0])).toBe(true);
    expect(roots[1]?.querySelector('[data-testid="assistant-message-outcome"]')).toBeNull();
  });

  it('shows no outcome line while details are on, where the step rows already carry it', async () => {
    render(
      <AgentDetailsHarness agentDetails="expanded" messages={[reminderTurn('rem-1')]}>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </AgentDetailsHarness>,
    );
    await settleAgentDetails();
    expect(screen.getByTestId('assistant-message-agent-internals')).toBeInTheDocument();
    expect(screen.queryByTestId('assistant-message-outcome')).not.toBeInTheDocument();
  });

  it('shows the outcome line when details are stored collapsed for the chat, and no internals', async () => {
    render(
      <AgentDetailsHarness agentDetails="collapsed" messages={[reminderTurn('rem-1')]}>
        <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
      </AgentDetailsHarness>,
    );
    await settleAgentDetails();
    expect(screen.queryByTestId('assistant-message-agent-internals')).not.toBeInTheDocument();
    expect(screen.getByTestId('assistant-message-outcome')).toHaveTextContent(REMINDER_LINE);
  });
});

describe('AssistantMessageContainer browser notices offer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    window.localStorage.clear();
  });

  /** The offer is decided after this device's push state is read. */
  async function settleOffer() {
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 0));
    });
  }

  const fourReminders: ThreadMessageLike = {
    role: 'assistant',
    content: [
      reminderPart('rem-1'),
      reminderPart('rem-2'),
      reminderPart('rem-3'),
      reminderPart('rem-4'),
      { type: 'text', text: 'Done, four reminders are set.' },
    ],
  };

  function visiblePrompts(container: HTMLElement): Element[] {
    return Array.from(container.querySelectorAll('[data-role="reminder-notification-prompt"]')).filter(
      prompt => prompt.closest('[hidden]') === null,
    );
  }

  it('offers notices once under the reply, not once per reminder, while details are off', async () => {
    const { container } = render(
      <RuntimeHarness messages={[fourReminders]}>
        <DeliveriesProvider api={fakeServer([]).api}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </DeliveriesProvider>
      </RuntimeHarness>,
    );
    await settleOffer();
    expect(container.querySelectorAll('[data-role="reminder-notification-prompt"]')).toHaveLength(1);
    expect(visiblePrompts(container)).toHaveLength(1);
  });

  it('offers notices once outside the step rows while details are on', async () => {
    const { container } = render(
      <AgentDetailsHarness agentDetails="expanded" messages={[fourReminders]}>
        <DeliveriesProvider api={fakeServer([]).api}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </DeliveriesProvider>
      </AgentDetailsHarness>,
    );
    await settleOffer();
    await settleAgentDetails();
    const prompts = container.querySelectorAll('[data-role="reminder-notification-prompt"]');
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.closest('[data-testid="assistant-message-agent-internals"]')).toBeNull();
  });

  it('offers notices only under the latest reply that set a reminder', async () => {
    const { container } = render(
      <RuntimeHarness
        messages={[reminderTurn('rem-1'), { role: 'user', content: 'and another' }, reminderTurn('rem-2')]}
      >
        <DeliveriesProvider api={fakeServer([]).api}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </DeliveriesProvider>
      </RuntimeHarness>,
    );
    await settleOffer();
    const prompts = container.querySelectorAll('[data-role="reminder-notification-prompt"]');
    expect(prompts).toHaveLength(1);
    const roots = container.querySelectorAll('[data-role="assistant"]');
    expect(prompts[0] !== undefined && roots[roots.length - 1]?.contains(prompts[0])).toBe(true);
  });

  it('does not offer notices when the reminder was declined', async () => {
    const declined: ThreadMessageLike = {
      role: 'assistant',
      content: [
        { ...reminderPart('rem-1'), result: envelope(mcpText({ error: 'Not approved.' }), 'denied') },
        { type: 'text', text: 'Okay, I did not set it.' },
      ],
    };
    const { container } = render(
      <RuntimeHarness messages={[declined]}>
        <DeliveriesProvider api={fakeServer([]).api}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </DeliveriesProvider>
      </RuntimeHarness>,
    );
    await settleOffer();
    expect(container.querySelectorAll('[data-role="reminder-notification-prompt"]')).toHaveLength(0);
  });

  it('does not offer notices while the reminder turn is still running', async () => {
    const running: ThreadMessageLike = {
      role: 'assistant',
      status: { type: 'running' },
      content: [reminderPart('rem-1'), { type: 'text', text: 'Setting it now.' }],
    };
    const { container } = render(
      <RuntimeHarness messages={[running]} isRunning>
        <DeliveriesProvider api={fakeServer([]).api}>
          <ThreadPrimitive.Messages>{() => <AssistantMessageContainer />}</ThreadPrimitive.Messages>
        </DeliveriesProvider>
      </RuntimeHarness>,
    );
    await settleOffer();
    expect(container.querySelectorAll('[data-role="reminder-notification-prompt"]')).toHaveLength(0);
  });
});
