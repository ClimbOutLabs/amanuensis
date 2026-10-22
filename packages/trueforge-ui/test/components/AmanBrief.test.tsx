import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { briefItemKey, type MorningBrief } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { AmanBrief } from '@/components/AmanBrief.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import type { SentinelApi } from '@/sentinel/types.js';

const { composer } = vi.hoisted(() => ({ composer: { setText: vi.fn(), send: vi.fn() } }));

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useAui: () => ({ composer: () => composer }),
}));

const BRIEF: MorningBrief = {
  digest: 'One thing to check, and two decisions.',
  items: [
    {
      section: 'check_first',
      title: "Mateo's invite says 4:00am",
      subtitle: ['Likely meant 4:00pm'],
      action: { label: 'Ask Mateo', target: { kind: 'prompt', text: 'Ask Mateo about the time' } },
    },
    {
      section: 'decision',
      title: 'Reply to Ines',
      subtitle: ['Lease', 'Thursday'],
      action: { label: 'Draft a reply', target: { kind: 'prompt', text: 'Draft a reply to Ines' } },
    },
    {
      section: 'decision',
      title: 'Pick a dentist slot',
      subtitle: [],
      action: { label: 'Compare', target: { kind: 'link', url: 'https://calendar.example.com/slots' } },
    },
    {
      section: 'coming_up',
      title: 'Sunday party',
      subtitle: ['683 Florida St', 'with Priya'],
      when: new Date(2026, 9, 25, 15, 30).toISOString(),
      action: { label: 'Plan route', target: { kind: 'prompt', text: 'Plan the route to the party' } },
    },
  ],
};

function bigBrief(count: number): MorningBrief {
  return {
    digest: 'Many decisions.',
    items: Array.from({ length: count }, (_, index) => ({
      section: 'decision' as const,
      title: `Decision ${String(index + 1)}`,
      subtitle: [],
      action: { label: 'Open', target: { kind: 'prompt' as const, text: `Open ${String(index + 1)}` } },
    })),
  };
}

const UNUSED = async (): Promise<never> => {
  throw new Error('not used by the brief');
};

/** A Sentinel API whose brief methods are spies; the rest of the surface is never called here. */
function fakeApi(
  brief: Partial<Pick<SentinelApi, 'listBriefItemCompletions' | 'markBriefItemDone' | 'unmarkBriefItemDone'>> = {},
): SentinelApi & { markBriefItemDone: Mock; unmarkBriefItemDone: Mock } {
  const markBriefItemDone = vi.fn(brief.markBriefItemDone ?? (async () => undefined));
  const unmarkBriefItemDone = vi.fn(brief.unmarkBriefItemDone ?? (async () => undefined));
  return {
    listAuditEntries: async () => [],
    listUserAuditEntries: async () => ({ entries: [] }),
    getUserSettings: UNUSED,
    updateUserSettings: UNUSED,
    listSentinelSessionContext: UNUSED,
    listBriefItemCompletions: brief.listBriefItemCompletions ?? (async () => []),
    markBriefItemDone,
    unmarkBriefItemDone,
  };
}

function renderBrief(brief: MorningBrief, api: SentinelApi = fakeApi()) {
  return render(
    <SentinelApiProvider api={api}>
      <AmanBrief brief={brief} briefId="brief-1" sessionId="chat-1" />
    </SentinelApiProvider>,
  );
}

describe('AmanBrief', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      configurable: true,
      value: vi.fn((query: string) => ({
        matches: false,
        media: query,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
      })),
    });
    composer.setText.mockClear();
    composer.send.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the digest and sections with the decision count, and no all-caps labels', () => {
    renderBrief(BRIEF);
    expect(screen.getByText('One thing to check, and two decisions.')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Check first' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Needs a decision · 2' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Coming up' })).toBeInTheDocument();
  });

  it('gives the Check first label the accent and the dot the bright gold', () => {
    renderBrief(BRIEF);
    expect(screen.getByRole('heading', { name: 'Check first' })).toHaveClass('text-gold-ink');
    const row = screen.getAllByTestId('brief-row')[0];
    expect(row?.querySelector('.bg-gold')).not.toBeNull();
  });

  it('draws no highlight behind the first Check first title', () => {
    renderBrief(BRIEF);
    const title = screen.getAllByTestId('brief-row')[0]?.querySelector('.line-clamp-2');
    expect(title?.textContent).toBe("Mateo's invite says 4:00am");
    expect(document.querySelector('.aui-reward-highlight')).toBeNull();
  });

  it('shows one verb-first action link per row, and sends a prompt through the composer', () => {
    renderBrief(BRIEF);
    fireEvent.click(screen.getByRole('button', { name: 'Draft a reply' }));
    expect(composer.setText).toHaveBeenCalledWith('Draft a reply to Ines');
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('opens a link target in a new window without a referrer', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    renderBrief(BRIEF);
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }));
    expect(open).toHaveBeenCalledWith('https://calendar.example.com/slots', '_blank', 'noopener,noreferrer');
    open.mockRestore();
  });

  it('shows at most six items, then "+ N more items" that expands inline', () => {
    renderBrief(bigBrief(8));
    expect(screen.getAllByTestId('brief-row')).toHaveLength(6);
    fireEvent.click(screen.getByRole('button', { name: '+ 2 more items' }));
    expect(screen.getAllByTestId('brief-row')).toHaveLength(8);
  });

  it('marks a row done with Space, shows Undo, and saves the mark', () => {
    vi.useFakeTimers();
    const api = fakeApi();
    renderBrief(BRIEF, api);
    const row = screen.getByRole('listitem', { name: 'Reply to Ines' });
    fireEvent.keyDown(row, { key: ' ' });
    expect(api.markBriefItemDone).toHaveBeenCalledWith(
      expect.objectContaining({ section: 'decision', title: 'Reply to Ines', sessionId: 'chat-1' }),
    );
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(within(row).getByRole('button', { name: 'Undo' })).toBeInTheDocument();
  });

  it('removes a done row after the five second Undo window', () => {
    vi.useFakeTimers();
    renderBrief(BRIEF);
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Reply to Ines' }), { key: ' ' });
    act(() => {
      vi.advanceTimersByTime(250 + 5000);
    });
    expect(screen.queryByRole('listitem', { name: 'Reply to Ines' })).toBeNull();
  });

  it('Undo brings the row back and removes the saved mark', () => {
    vi.useFakeTimers();
    const api = fakeApi();
    renderBrief(BRIEF, api);
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Reply to Ines' }), { key: ' ' });
    act(() => {
      vi.advanceTimersByTime(250);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(api.unmarkBriefItemDone).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Draft a reply' })).toBeInTheDocument();
  });

  it('runs the row action with Enter', () => {
    renderBrief(BRIEF);
    fireEvent.keyDown(screen.getByRole('listitem', { name: 'Reply to Ines' }), { key: 'Enter' });
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('hides items the server already has as done', async () => {
    const doneKey = briefItemKey({ section: 'decision', title: 'Reply to Ines' });
    const api = fakeApi({ listBriefItemCompletions: async () => [doneKey] });
    renderBrief(BRIEF, api);
    await waitFor(() => expect(screen.getAllByTestId('brief-row')).toHaveLength(3));
    expect(screen.queryByRole('listitem', { name: 'Reply to Ines' })).toBeNull();
  });
});
