import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import {
  MemoryRecallProvider,
  type MemoryRecallApi,
  type MemoryTurnContext,
} from '@/components/MemoryRecallContext.js';
import { parseRecallFacts, type RailDeskApi, type RailToday } from '@/components/RailDesk.js';

function turnContext(turnId: string, block: string): MemoryTurnContext {
  return {
    turnId,
    recall: {
      type: 'aman.memory.recall',
      id: `evt-${turnId}`,
      createdAt: '2026-11-06T00:00:00.000Z',
      injectedBlock: block,
      stats: {
        items: 1,
        entities: 0,
        droppedOverBudget: 0,
        droppedBelowThreshold: 0,
        estimatedTokens: 10,
        recallMs: 5,
        budgetReason: 'normal',
        outcome: 'ok',
      },
      sweep: { verified: 0, retried: 0, abandoned: 0, pending: 0 },
    },
  };
}

function blockOf(lines: string[]): string {
  return [
    '<aman-memory>',
    'Framing sentence.',
    ...lines,
    '(memory: 1 items, 0 entities; 4 tokens of 2048 budget)',
    '</aman-memory>',
  ].join('\n');
}

describe('parseRecallFacts', () => {
  it('takes the newest turn first, each fact once, from the recall record only', () => {
    const older = turnContext('t1', blockOf(['[2026-08-14] The gate code is 4417', '[2026-08-15] Ana is a friend']));
    const newer = turnContext('t2', blockOf(['[2026-08-15] Ana is a friend', '[2026-08-20] The ferry leaves at 9']));
    const facts = parseRecallFacts([older, newer]);
    expect(facts.map(fact => fact.text)).toEqual(['Ana is a friend', 'The ferry leaves at 9', 'The gate code is 4417']);
  });

  it('marks facts from something read or found as needing a check, and never the person\u2019s own', () => {
    const turn = turnContext(
      't1',
      blockOf([
        '[2026-08-14] The gate code is 4417',
        '[2026-08-20, from something read for the person] The ferry leaves at 9',
        '[2026-08-21, found earlier by the assistant] The office is on 5th',
        "[2026-08-22, the assistant's earlier reply] The train was booked",
        'People: Ana: is a friend',
      ]),
    );
    const facts = parseRecallFacts([turn]);
    expect(facts).toHaveLength(4);
    expect(facts[0]).toMatchObject({ source: 'person', needsCheck: false, origin: 'You said this on 2026-08-14' });
    expect(facts[1]).toMatchObject({ source: 'read', needsCheck: true });
    expect(facts[2]).toMatchObject({ source: 'finding', needsCheck: true });
    expect(facts[3]).toMatchObject({ source: 'assistant', needsCheck: false });
  });

  it('caps the list at six', () => {
    const lines = Array.from({ length: 8 }, (_, index) => `[2026-08-14] Fact number ${String(index)}`);
    expect(parseRecallFacts([turnContext('t1', blockOf(lines))])).toHaveLength(6);
  });
});

const TODAY: RailToday = {
  calendar: [
    {
      day: 'today',
      start_at: '2026-11-06T18:00:00.000Z',
      end_at: '2026-11-06T19:00:00.000Z',
      title: 'Dentist',
      location: 'The clinic on 5th',
      all_day: false,
      source: 'google',
      calendar_account_id: 'ada@example.com',
    },
  ],
  free_after: '2026-11-06T19:00:00.000Z',
  due: [
    {
      reminder_id: 'rem-1',
      title: 'Take the morning pills',
      due_at: '2026-11-06T15:00:00.000Z',
      session_id: 'rem-chat',
    },
  ],
  needs_ok: [
    { held_action_id: 'call-1', title: 'Send the email to Ana', origin: 'Trip planning', session_id: 'chat-9' },
  ],
  needs_ok_more: false,
  as_of: new Date().toISOString(),
};

function deskApi(today: RailToday): RailDeskApi & {
  excludeRecallFact: ReturnType<typeof vi.fn>;
} {
  return {
    getToday: vi.fn(async () => today),
    excludeRecallFact: vi.fn(async () => {}),
    listAttachments: vi.fn(async () => [{ id: 'f1', label: 'tickets.pdf', detail: 'Read' }]),
  };
}

describe('the rail desk on Home', () => {
  it('shows Today, Due and Needs your OK under a plain status word, and opens chats from rows', async () => {
    const onOpenChat = vi.fn();
    render(<AmanRuntimeRail status="ready" deskApi={deskApi(TODAY)} onOpenChat={onOpenChat} />);

    expect(await screen.findByText('Dentist')).toBeInTheDocument();
    // The caption under the name is the status word alone, with no count beside it.
    expect(screen.getByText('Ready', { selector: '.aman-runtime-rail__status span' })).toBeInTheDocument();
    expect(screen.queryByText(/Carrying/)).not.toBeInTheDocument();
    expect(screen.getByText('Take the morning pills')).toBeInTheDocument();
    expect(screen.getByText('Send the email to Ana')).toBeInTheDocument();

    fireEvent.click(screen.getByText('Take the morning pills'));
    expect(onOpenChat).toHaveBeenCalledWith('rem-chat');
    fireEvent.click(screen.getByText('Send the email to Ana'));
    expect(onOpenChat).toHaveBeenCalledWith('chat-9');
  });

  it('shows no Today section when no calendar is connected', async () => {
    render(<AmanRuntimeRail status="ready" deskApi={deskApi({ ...TODAY, calendar: null, free_after: null })} />);
    expect(await screen.findByText('Take the morning pills')).toBeInTheDocument();
    expect(screen.queryByText('Today')).not.toBeInTheDocument();
  });

  it('says the day is empty when a connected calendar has nothing on it', async () => {
    render(<AmanRuntimeRail status="ready" deskApi={deskApi({ ...TODAY, calendar: [], due: [], needs_ok: [] })} />);
    expect(await screen.findByText('Nothing on the calendar.')).toBeInTheDocument();
    expect(screen.queryByText('Due')).not.toBeInTheDocument();
    expect(screen.queryByText('Needs your OK')).not.toBeInTheDocument();
  });

  it("names tomorrow on tomorrow's event, so it never reads as one of today's", async () => {
    const tomorrow: RailToday = {
      ...TODAY,
      calendar: [
        {
          day: 'tomorrow',
          start_at: '2026-11-07T17:00:00.000Z',
          end_at: '2026-11-07T18:00:00.000Z',
          title: 'Dentist',
          location: null,
          all_day: false,
          source: 'google',
          calendar_account_id: 'ada@example.com',
        },
      ],
    };
    render(<AmanRuntimeRail status="ready" deskApi={deskApi(tomorrow)} />);
    expect(await screen.findByText('Dentist')).toBeInTheDocument();
    expect(screen.getByText(/^Tomorrow, /)).toBeInTheDocument();
  });

  it('writes the free time in the same small type as the rows around it', async () => {
    render(<AmanRuntimeRail status="ready" deskApi={deskApi(TODAY)} />);
    const free = await screen.findByText(/^Free /);
    expect(free).toHaveClass('aman-runtime-rail__desk-note');
  });

  it('says when more actions are waiting than the list shows', async () => {
    render(<AmanRuntimeRail status="ready" deskApi={deskApi({ ...TODAY, needs_ok_more: true })} />);
    expect(await screen.findByText('More are waiting in your chats.')).toBeInTheDocument();
  });
});

describe('the rail desk in a chat', () => {
  const block = blockOf([
    '[2026-08-14] The gate code is 4417',
    '[2026-08-20, from something read for the person] The ferry leaves at 9',
  ]);
  const memoryApi: MemoryRecallApi = {
    listMemoryTurnContext: async () => [turnContext('t1', block)],
  };

  it('shows the facts in use with their sources, tags the read one, and pulls a fact out of this chat only', async () => {
    const api = deskApi(TODAY);
    const onOpenMemorySettings = vi.fn();
    render(
      <MemoryRecallProvider api={memoryApi}>
        <AmanRuntimeRail status="ready" sessionId="chat-1" deskApi={api} onOpenMemorySettings={onOpenMemorySettings} />
      </MemoryRecallProvider>,
    );

    expect(await screen.findByText('The gate code is 4417')).toBeInTheDocument();
    expect(screen.getByText('You said this on 2026-08-14')).toBeInTheDocument();
    expect(screen.getByText('The ferry leaves at 9')).toBeInTheDocument();
    expect(screen.getByText('Check')).toBeInTheDocument();
    expect(screen.getByText('tickets.pdf')).toBeInTheDocument();

    const forgetButtons = screen.getAllByRole('button', { name: 'Forget everywhere' });
    expect(forgetButtons).toHaveLength(2);
    fireEvent.click(forgetButtons[0] ?? document.body);
    expect(onOpenMemorySettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Take this out of this chat: The gate code is 4417' }));
    expect(api.excludeRecallFact).toHaveBeenCalledWith({ sessionId: 'chat-1', factText: 'The gate code is 4417' });
    await waitFor(() => {
      expect(screen.queryByText('The gate code is 4417')).not.toBeInTheDocument();
    });
    expect(screen.getByText('The ferry leaves at 9')).toBeInTheDocument();
  });
});
