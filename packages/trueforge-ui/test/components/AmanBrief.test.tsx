import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanBrief, briefFooterLine } from '@/components/AmanBrief.js';
import { parseBrief } from '@/components/briefSections.js';

const { composer } = vi.hoisted(() => ({ composer: { setText: vi.fn(), send: vi.fn() } }));

vi.mock('@assistant-ui/react', async importOriginal => ({
  ...(await importOriginal<typeof import('@assistant-ui/react')>()),
  useAui: () => ({ composer: () => composer }),
}));

const ANSWER = `## Coming up
- Dentist, Tuesday 10:00 [Add it to my calendar]
- Team lunch, Friday 12:30

## Deadlines
- Permit form due 31 Oct [Start the form]

## Needs doing
- Reply to Sofia [Draft a reply]

## Watch out
- Email asks for your password [Show the warning signs]
- Parcel text with a link [Explain]
- Caller asked for a code
- Fourth warning
`;

function sections() {
  const parsed = parseBrief(ANSWER);
  if (parsed === null) throw new Error('fixture must parse');
  return parsed;
}

describe('AmanBrief', () => {
  beforeEach(() => {
    localStorage.clear();
    composer.setText.mockClear();
    composer.send.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows four stops and gives the gold fill to exactly one of them', () => {
    render(<AmanBrief sections={sections()} briefId="brief-1" sessionId="chat-1" />);
    const stops = within(screen.getByTestId('brief-stops')).getAllByRole('button');
    expect(stops).toHaveLength(4);
    const selected = stops.filter(stop => stop.classList.contains('aui-ticket--selected'));
    expect(selected).toHaveLength(1);
    expect(selected[0]).toBe(screen.getByTestId('brief-stop-coming_up'));
  });

  it('shows a count that is true of each chapter, and a gold dot on Watch out', () => {
    render(<AmanBrief sections={sections()} briefId="brief-1" sessionId={undefined} />);
    expect(screen.getByTestId('brief-stop-coming_up')).toHaveTextContent('2 coming up');
    expect(screen.getByTestId('brief-stop-watch_out')).toHaveTextContent('4 to check');
    expect(screen.getByTestId('brief-stop-watch_out').querySelector('.bg-gold')).not.toBeNull();
    expect(screen.getByTestId('brief-stop-deadlines').querySelector('.bg-gold')).toBeNull();
  });

  it('sends the line with its one next step when the link is tapped', () => {
    render(<AmanBrief sections={sections()} briefId="brief-1" sessionId={undefined} />);
    fireEvent.click(screen.getByRole('button', { name: 'Draft a reply' }));
    expect(composer.setText).toHaveBeenCalledWith('Draft a reply for this: Reply to Sofia');
    expect(composer.send).toHaveBeenCalledTimes(1);
  });

  it('renders each line as a row with its text and never shows the bracketed step inside the text', () => {
    render(<AmanBrief sections={sections()} briefId="brief-1" sessionId={undefined} />);
    const rows = screen.getAllByTestId('brief-row');
    expect(rows).toHaveLength(8);
    expect(rows[0]).toHaveTextContent('Dentist, Tuesday 10:00');
    expect(rows[0]).not.toHaveTextContent('[Add it to my calendar]');
    expect(rows[0]?.querySelector('.text')).not.toBeNull();
  });

  it('highlights at most three Watch out lines, and only after their turn', () => {
    vi.useFakeTimers();
    const { container } = render(<AmanBrief sections={sections()} briefId="brief-cap" sessionId={undefined} />);
    expect(container.querySelectorAll('.aui-reward-highlight[data-play="true"]')).toHaveLength(0);
    act(() => {
      vi.runAllTimers();
    });
    expect(container.querySelectorAll('.aui-reward-highlight[data-play="true"]')).toHaveLength(3);
    expect(container.querySelectorAll('.aui-reward-highlight')).toHaveLength(3);
  });

  it("does not play a brief's highlights again once its three are used", () => {
    vi.useFakeTimers();
    const first = render(<AmanBrief sections={sections()} briefId="brief-again" sessionId={undefined} />);
    act(() => {
      vi.runAllTimers();
    });
    first.unmount();
    const second = render(<AmanBrief sections={sections()} briefId="brief-again" sessionId={undefined} />);
    act(() => {
      vi.runAllTimers();
    });
    // Highlights stay in place for the answer; the ledger only stops them playing again.
    expect(second.container.querySelectorAll('.aui-reward-highlight')).toHaveLength(3);
    expect(second.container.querySelectorAll('.aui-reward-highlight[data-play="true"]')).toHaveLength(0);
  });
});

describe('briefFooterLine', () => {
  it('says what was read and that nothing was sent when no action ran', () => {
    expect(briefFooterLine({ readQuietly: 12, actionsRan: 0 })).toBe('12 things read quietly. Nothing was sent.');
  });

  it('counts the actions that ran instead of claiming nothing was sent', () => {
    expect(briefFooterLine({ readQuietly: 1, actionsRan: 2 })).toBe('1 thing read quietly. 2 actions ran.');
  });
});
