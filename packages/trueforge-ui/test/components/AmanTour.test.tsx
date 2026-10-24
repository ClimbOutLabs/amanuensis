import { fireEvent, render, screen, within } from '@testing-library/react';
import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanTour, greetingLine, greetingParts, type AmanTourProps } from '@/components/AmanTour.js';
import { GENERAL_CARDS, HOME_TOPICS } from '@/components/tourPrompts.js';

const noCapabilities = { email: false, calendar: false, sandbox: false, maps: true };
const morning = new Date(2026, 9, 23, 9, 0);

function renderTour(overrides: Partial<AmanTourProps> = {}) {
  const props: AmanTourProps = {
    capabilities: noCapabilities,
    userName: 'Priya Shah',
    assistantName: 'Mannie',
    now: morning,
    hasBrief: false,
    firstRun: false,
    setupTicket: <p>Setup ticket</p>,
    onFill: vi.fn(),
    canSend: true,
    ...overrides,
  };
  return { ...render(<AmanTour {...props} />), props };
}

describe('greetingLine and greetingParts', () => {
  it('greets by the first name only, with no full stop', () => {
    expect(greetingLine({ now: morning, name: 'Priya Shah' })).toBe('Good morning, Priya');
    expect(greetingParts({ now: morning, name: '  Priya  Shah ' })).toEqual({
      hello: 'Good morning',
      firstName: 'Priya',
    });
  });

  it('says the time of day alone when there is no name', () => {
    expect(greetingLine({ now: new Date(2026, 9, 23, 19), name: '' })).toBe('Good evening');
  });
});

describe('AmanTour home', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('shows the greeting with the underline only under the first name', () => {
    const { container } = renderTour();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Good morning, Priya');
    expect(heading.querySelectorAll('.aui-name-underline')).toHaveLength(1);
    expect(container.querySelectorAll('.aui-name-underline')).toHaveLength(1);
  });

  it('puts Productivity first, then the help areas, and shows the gold dot on Productivity once a brief exists', () => {
    const { rerender, props } = renderTour({ hasBrief: false });
    const pills = within(screen.getByRole('list', { name: 'What would help you most?' })).getAllByRole('button');
    expect(pills.map(pill => pill.textContent)).toEqual([
      'Productivity',
      ...HELP_AREA_IDS.map(id => HOME_TOPICS[id].label),
    ]);
    expect(pills.every(pill => pill.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(pills[0]?.querySelector('.bg-gold')).toBeNull();

    rerender(<AmanTour {...props} hasBrief />);
    expect(screen.getByRole('button', { name: 'Productivity' }).querySelector('.bg-gold')).not.toBeNull();
  });

  it('uses the pills as tabs for the cards: choosing one swaps the cards and sends nothing', () => {
    const { props } = renderTour();
    const cardTitles = () =>
      within(screen.getByRole('region', { name: 'Some things Mannie can do' }))
        .getAllByRole('button')
        .map(card => card.querySelector('[data-role="home-card-title"]')?.textContent);
    expect(cardTitles()).toEqual(GENERAL_CARDS.map(card => card.title));

    const family = screen.getByRole('button', { name: 'Family and home' });
    fireEvent.click(family);
    expect(family).toHaveAttribute('aria-pressed', 'true');
    expect(family).toHaveClass('bg-gold-soft');
    expect(cardTitles()).toEqual([
      "Plan this week's meals",
      'Split the chores fairly',
      'Plan a birthday',
      'Plan a weekend outing',
    ]);
    expect(screen.getByText('Mannie asks who lives with you and makes a weekly chart')).toBeInTheDocument();
    expect(props.onFill).not.toHaveBeenCalled();

    // Pressing the chosen pill again goes back to the general set.
    fireEvent.click(family);
    expect(family).toHaveAttribute('aria-pressed', 'false');
    expect(cardTitles()).toEqual(GENERAL_CARDS.map(card => card.title));
  });

  it('keeps the chosen pill after a reload', () => {
    const first = renderTour();
    fireEvent.click(screen.getByRole('button', { name: 'Work and money' }));
    first.unmount();

    renderTour();
    expect(screen.getByRole('button', { name: 'Work and money' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Make a simple budget/ })).toBeInTheDocument();
  });

  it('gives every topic four cards, each naming the assistant by its display name where it names one', () => {
    renderTour({ assistantName: 'Juniper' });
    for (const pill of within(screen.getByRole('list', { name: 'What would help you most?' })).getAllByRole('button')) {
      fireEvent.click(pill);
      const cards = within(screen.getByRole('region', { name: 'Some things Juniper can do' })).getAllByRole('button');
      expect(cards).toHaveLength(4);
      for (const card of cards) {
        expect(card.textContent).not.toMatch(/\b(Aman|Mannie)\b/);
      }
    }
  });

  it('fills the composer, without sending, from a card of the chosen topic', () => {
    const { props } = renderTour();

    expect(screen.getByRole('heading', { name: 'Some things Mannie can do' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Plan your day/ }));
    expect(props.onFill).toHaveBeenLastCalledWith(expect.stringContaining('Help me plan my day'));

    fireEvent.click(screen.getByRole('button', { name: 'Productivity' }));
    fireEvent.click(screen.getByRole('button', { name: /Your morning brief/ }));
    expect(props.onFill).toHaveBeenCalledTimes(2);
  });

  it('shows the prompt line, the setup ticket and Skip only on a first run', () => {
    const onSkip = vi.fn();
    const { rerender, props } = renderTour({ firstRun: true, onSkip });

    expect(screen.getByText('What would help you most? Pick one to see what Mannie can do there.')).toBeInTheDocument();
    expect(screen.getByText('Setup ticket')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    expect(onSkip).toHaveBeenCalledTimes(1);

    rerender(<AmanTour {...props} firstRun={false} onSkip={onSkip} />);
    expect(screen.queryByText(/What would help you most\? Pick one/)).not.toBeInTheDocument();
    expect(screen.queryByText('Setup ticket')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip the tour' })).not.toBeInTheDocument();
  });

  it('says what to do when no model is set, and the pills still switch the cards', () => {
    renderTour({ canSend: false });

    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Productivity' })).toBeEnabled();
  });
});
