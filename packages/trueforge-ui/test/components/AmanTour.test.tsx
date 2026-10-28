import { fireEvent, render, screen, within } from '@testing-library/react';
import { MORNING_BRIEF_CARD_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AmanTour, greetingLine, greetingParts, type AmanTourProps } from '@/components/AmanTour.js';
import { CARDS, HOME_TOPICS } from '@/components/tourPrompts.js';

const noCapabilities = { email: false, calendar: false, sandbox: false, maps: true };
const connected = { email: true, calendar: true, sandbox: false, maps: true };
const morning = new Date(2026, 9, 23, 9, 0);

function renderTour(overrides: Partial<AmanTourProps> = {}) {
  const props: AmanTourProps = {
    capabilities: noCapabilities,
    userName: 'Priya Shah',
    assistantName: 'Mannie',
    now: morning,
    firstRun: false,
    setupTicket: <p>Setup ticket</p>,
    onSend: vi.fn(),
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

function cardTitles(): (string | null | undefined)[] {
  return within(screen.getByRole('region', { name: /Some things .* can do/ }))
    .getAllByRole('button')
    .map(card => card.querySelector('[data-role="home-card-title"]')?.textContent);
}

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

  it('shows the seven pills in order, none pressed', () => {
    renderTour();
    const pills = within(screen.getByRole('list', { name: 'What would help you most?' })).getAllByRole('button');
    expect(pills.map(pill => pill.textContent)).toEqual([
      "I'm behind",
      "Something's coming up",
      'I need to write something hard',
      'Help me think',
      'Someone I look after',
      'Money',
      'I just moved here',
    ]);
    expect(pills.every(pill => pill.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('shows the four expected default cards on a fresh install and when email and calendar are connected', () => {
    const fresh = renderTour();
    expect(cardTitles()).toEqual([CARDS.head.title, CARDS.start.title, CARDS.kindly.title, CARDS.dinner.title]);
    fresh.unmount();

    renderTour({ capabilities: connected });
    expect(cardTitles()).toEqual([CARDS.brief.title, CARDS.today.title, CARDS.dropping.title, CARDS.head.title]);
  });

  it('uses the pills as tabs for the cards: choosing one swaps the cards and sends nothing', () => {
    const { props } = renderTour();
    const defaults = cardTitles();

    const family = screen.getByRole('button', { name: 'Someone I look after' });
    fireEvent.click(family);
    expect(family).toHaveAttribute('aria-pressed', 'true');
    expect(family).toHaveClass('bg-gold-soft');
    expect(cardTitles()).toEqual([CARDS.care.title, CARDS.meds.title, CARDS.chores.title, CARDS.hard_talk.title]);
    expect(screen.getByText('Mannie helps you find the words')).toBeInTheDocument();
    expect(props.onSend).not.toHaveBeenCalled();

    // Pressing the chosen pill again goes back to the default set.
    fireEvent.click(family);
    expect(family).toHaveAttribute('aria-pressed', 'false');
    expect(cardTitles()).toEqual(defaults);
  });

  it('keeps the chosen pill after a reload', () => {
    const first = renderTour();
    fireEvent.click(screen.getByRole('button', { name: 'I just moved here' }));
    first.unmount();

    renderTour();
    expect(screen.getByRole('button', { name: 'I just moved here' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /Explain this letter/ })).toBeInTheDocument();
  });

  it('reads a pill stored by an older version as no pill', () => {
    for (const old of ['productivity', 'family', 'new_country']) {
      localStorage.setItem('aman-home-topic', old);
      const view = renderTour();
      const pills = within(screen.getByRole('list', { name: 'What would help you most?' })).getAllByRole('button');
      expect(
        pills.every(pill => pill.getAttribute('aria-pressed') === 'false'),
        old,
      ).toBe(true);
      expect(cardTitles()).toEqual([CARDS.head.title, CARDS.start.title, CARDS.kindly.title, CARDS.dinner.title]);
      view.unmount();
    }
  });

  it('gives every pill four cards, each naming the assistant by its display name where it names one', () => {
    renderTour({ assistantName: 'Juniper', capabilities: connected });
    for (const pill of within(screen.getByRole('list', { name: 'What would help you most?' })).getAllByRole('button')) {
      fireEvent.click(pill);
      const cards = within(screen.getByRole('region', { name: 'Some things Juniper can do' })).getAllByRole('button');
      expect(cards).toHaveLength(4);
      for (const card of cards) {
        expect(card.textContent).not.toMatch(/\b(Aman|Mannie)\b/);
      }
    }
  });

  it('sends the card prompt on its own, and fills nothing', () => {
    const { props } = renderTour();

    expect(screen.getByRole('heading', { name: 'Some things Mannie can do' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /I can't get started/ }));
    expect(props.onSend).toHaveBeenLastCalledWith(CARDS.start.prompt);
    expect(props.onFill).not.toHaveBeenCalled();
  });

  it('sends only the morning brief card prompt from the brief card', () => {
    const { props } = renderTour({ capabilities: connected });

    fireEvent.click(screen.getByRole('button', { name: /Your morning brief/ }));
    expect(props.onSend).toHaveBeenCalledTimes(1);
    expect(props.onSend).toHaveBeenLastCalledWith(MORNING_BRIEF_CARD_PROMPT);
  });

  it('puts the same card under two pills, sent the same way', () => {
    const { props } = renderTour();
    const filled: string[] = [];
    for (const topic of ['behind', 'help_me_think'] as const) {
      fireEvent.click(screen.getByRole('button', { name: HOME_TOPICS[topic].label }));
      fireEvent.click(screen.getByRole('button', { name: /Everything's in my head/ }));
      filled.push(String(vi.mocked(props.onSend).mock.lastCall?.[0]));
    }
    expect(filled[0]).toBe(filled[1]);
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

  it('only fills the composer from a card when no model is set, so nothing is sent', () => {
    const { props } = renderTour({ canSend: false });

    fireEvent.click(screen.getByRole('button', { name: /I can't get started/ }));
    expect(props.onFill).toHaveBeenLastCalledWith(CARDS.start.prompt);
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('says what to do when no model is set, and the pills still switch the cards', () => {
    renderTour({ canSend: false });

    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "I'm behind" })).toBeEnabled();
  });
});
