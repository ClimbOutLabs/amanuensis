import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AmanRuntimeRail } from '@/components/AmanRuntimeRail.js';
import {
  MemoryRecallProvider,
  type MemoryRecallApi,
  type MemoryTurnContext,
} from '@/components/MemoryRecallContext.js';
import { parseRecallFacts, type RailDeskApi, type RailToday } from '@/components/RailDesk.js';

function turnContext(turnId: string, block: string | null): MemoryTurnContext {
  return {
    turnId,
    recall: {
      type: 'aman.memory.recall',
      id: `evt-${turnId}`,
      createdAt: '2026-11-06T00:00:00.000Z',
      injectedBlock: block,
      stats: {
        items: 1,
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
  it('shows only what the latest turn recalled, each fact once', () => {
    const older = turnContext('t1', blockOf(['[2026-08-14] The gate code is 4417', '[2026-08-15] Ana is a friend']));
    const newer = turnContext('t2', blockOf(['[2026-08-15] Ana is a friend', '[2026-08-20] The ferry leaves at 9']));
    const facts = parseRecallFacts([older, newer]);
    expect(facts.map(fact => fact.text)).toEqual(['Ana is a friend', 'The ferry leaves at 9']);
  });

  it('shows nothing when the latest turn recalled nothing, whatever earlier turns recalled', () => {
    const older = turnContext('t1', blockOf(['[2026-08-14] The gate code is 4417']));
    const newer = turnContext('t2', null);
    expect(parseRecallFacts([older, newer])).toEqual([]);
  });

  it('says where each fact came from', () => {
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
    expect(facts[0]).toMatchObject({ source: 'person', origin: 'You said this · Aug 14, 2026' });
    expect(facts[1]).toMatchObject({ source: 'read' });
    expect(facts[2]).toMatchObject({ source: 'finding' });
    expect(facts[3]).toMatchObject({ source: 'assistant' });
  });

  it('reads lines that also say how long ago the day was, with the same text and source', () => {
    const turn = turnContext(
      't1',
      blockOf([
        '[2024-11-02, 2 years ago, said by the person] The gate code is 4417',
        '[2026-11-12, yesterday, from something read for the person] The ferry leaves at 9',
        '[2026-10-01, 6 weeks ago, found earlier by the assistant] The office is on 5th',
        "[2026-11-13, today, the assistant's earlier reply] The train was booked",
        '[undated, said by the person] The spare key is under the mat',
        '[2026-11-10, 3 days ago, a message the person sent] See you at the ferry',
      ]),
    );
    const facts = parseRecallFacts([turn]);
    expect(facts.map(fact => fact.text)).toEqual([
      'The gate code is 4417',
      'The ferry leaves at 9',
      'The office is on 5th',
      'The train was booked',
      'The spare key is under the mat',
      'See you at the ferry',
    ]);
    expect(facts[0]).toMatchObject({ source: 'person', origin: 'You said this · 2 years ago' });
    expect(facts[1]).toMatchObject({ source: 'read', date: '2026-11-12' });
    expect(facts[2]).toMatchObject({ source: 'finding' });
    expect(facts[3]).toMatchObject({ source: 'assistant' });
    expect(facts[4]).toMatchObject({ source: 'person', origin: 'You said this' });
    expect(facts[5]).toMatchObject({ source: 'person', origin: 'From a message you sent · 3 days ago' });
  });

  it('shows a saved note without its label, and says where it came from in plain words', () => {
    const turn = turnContext(
      't1',
      blockOf([
        '[2026-11-12, yesterday, found earlier by the assistant] From an email, found Nov 12: The CPA said to file early.',
      ]),
    );
    expect(parseRecallFacts([turn])[0]).toMatchObject({
      text: 'From an email, found Nov 12: The CPA said to file early.',
      shown: 'The CPA said to file early.',
      origin: 'From an email · yesterday',
    });
  });

  it('lists the lines of a page the turn used, before the saved memories, and never the writing instructions', () => {
    const turn = turnContext(
      't1',
      blockOf([
        '[page: Sidd — person, name not confirmed by you]',
        'Now:',
        '- Lives in Denver now, after moving from Austin. (read content, not confirmed, since 2025-09-09)',
        '- Drinks coffee black. (you said)',
        '[2024-12-29, 22 months ago, said by the person] I live in Austin, in a rented flat near the river.',
        'How the person writes to these contacts (follow when drafting to them):',
        '- Keep it short. (you said)',
        'End of the writing instructions.',
      ]),
    );
    const facts = parseRecallFacts([turn]);
    expect(facts.map(fact => fact.shown)).toEqual([
      'Lives in Denver now, after moving from Austin.',
      'Drinks coffee black.',
      'I live in Austin, in a rented flat near the river.',
    ]);
    expect(facts[0]).toMatchObject({ page: 'Sidd', source: 'read', origin: 'From something read for you · page Sidd' });
    expect(facts[1]).toMatchObject({ page: 'Sidd', source: 'person', origin: 'You said this · page Sidd' });
    expect(facts[2]?.page).toBeUndefined();
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
  carrying: 3,
  as_of: new Date().toISOString(),
};

function deskApi(today: RailToday): RailDeskApi & {
  excludeRecallFact: ReturnType<typeof vi.fn>;
  deleteShownMemory: ReturnType<typeof vi.fn>;
} {
  return {
    getToday: vi.fn(async () => today),
    excludeRecallFact: vi.fn(async () => {}),
    deleteShownMemory: vi.fn(async () => {}),
    listAttachments: vi.fn(async () => [{ id: 'f1', label: 'tickets.pdf', detail: 'Read' }]),
  };
}

describe('the rail desk on Home', () => {
  it('shows Today, Due and Needs your OK, says what is being carried, and opens chats from rows', async () => {
    const onOpenChat = vi.fn();
    render(<AmanRuntimeRail status="ready" deskApi={deskApi(TODAY)} onOpenChat={onOpenChat} />);

    expect(await screen.findByText('Dentist')).toBeInTheDocument();
    expect(screen.getByText('Ready · Carrying 3')).toBeInTheDocument();
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
    expect(screen.getByText('You said this · Aug 14, 2026')).toBeInTheDocument();
    expect(screen.getByText('The ferry leaves at 9')).toBeInTheDocument();
    expect(screen.getByText('tickets.pdf')).toBeInTheDocument();

    // The list is one fold of the panel, closed until opened, like Activity and Rules.
    const fold = screen.getByText('From memory (2)').closest('details');
    expect(fold).not.toBeNull();
    expect(fold).not.toHaveAttribute('open');

    fireEvent.click(screen.getByRole('button', { name: 'Manage memory' }));
    expect(onOpenMemorySettings).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Take this out of this chat: The gate code is 4417' }));
    expect(api.excludeRecallFact).toHaveBeenCalledWith({ sessionId: 'chat-1', factText: 'The gate code is 4417' });
    await waitFor(() => {
      expect(screen.queryByText('The gate code is 4417')).not.toBeInTheDocument();
    });
    expect(screen.getByText('The ferry leaves at 9')).toBeInTheDocument();
  });

  function renderDesk(api: RailDeskApi): void {
    render(
      <MemoryRecallProvider api={memoryApi}>
        <AmanRuntimeRail status="ready" sessionId="chat-1" deskApi={api} />
      </MemoryRecallProvider>,
    );
  }

  it('gives a line from a page no controls, and says where it is changed', async () => {
    const pageApi: MemoryRecallApi = {
      listMemoryTurnContext: async () => [
        turnContext(
          't1',
          blockOf([
            '[page: Sidd — person]',
            'Now:',
            '- Lives in Denver now. (you said)',
            '[2026-08-14] The gate code is 4417',
          ]),
        ),
      ],
    };
    render(
      <MemoryRecallProvider api={pageApi}>
        <AmanRuntimeRail status="ready" sessionId="chat-1" deskApi={deskApi(TODAY)} />
      </MemoryRecallProvider>,
    );
    expect(await screen.findByText('Lives in Denver now.')).toBeInTheDocument();
    expect(screen.getByText('From memory (2)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete this memory: Lives in Denver now.' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Delete this memory: The gate code is 4417' })).toBeInTheDocument();
    expect(screen.getByText(/A line from a page is changed on its page\./)).toBeInTheDocument();
  });

  it('deletes a memory only after a yes, and keeps it when the person says keep', async () => {
    const api = deskApi(TODAY);
    renderDesk(api);
    await screen.findByText('The ferry leaves at 9');

    fireEvent.click(screen.getByRole('button', { name: 'Delete this memory: The ferry leaves at 9' }));
    expect(screen.getByText('Delete this memory everywhere? It cannot be brought back.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Keep it' }));
    expect(api.deleteShownMemory).not.toHaveBeenCalled();
    expect(screen.getByText('The ferry leaves at 9')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Delete this memory: The ferry leaves at 9' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
    expect(api.deleteShownMemory).toHaveBeenCalledWith({ factText: 'The ferry leaves at 9' });
    await waitFor(() => {
      expect(screen.queryByText('The ferry leaves at 9')).not.toBeInTheDocument();
    });
    expect(screen.getByText('The gate code is 4417')).toBeInTheDocument();
  });

  it('keeps the memory on the list and says what to do when the delete fails', async () => {
    const api = deskApi(TODAY);
    api.deleteShownMemory.mockRejectedValue(
      new Error('Nothing was deleted. Open Settings, then Memory, and delete it there.'),
    );
    renderDesk(api);
    await screen.findByText('The ferry leaves at 9');

    fireEvent.click(screen.getByRole('button', { name: 'Delete this memory: The ferry leaves at 9' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Open Settings, then Memory');
    expect(screen.getByText('The ferry leaves at 9')).toBeInTheDocument();
  });
});
