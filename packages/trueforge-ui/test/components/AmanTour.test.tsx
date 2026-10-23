import { fireEvent, render, screen, within } from '@testing-library/react';
import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';
import { describe, expect, it, vi } from 'vitest';

import { AmanTour, greetingLine, greetingParts, type AmanTourProps } from '@/components/AmanTour.js';
import { HELP_AREAS, MORNING_BRIEF } from '@/components/tourPrompts.js';

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

describe('AmanTour home', () => {
  it('shows the greeting with the underline only under the first name', () => {
    const { container } = renderTour();

    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toHaveTextContent('Good morning, Priya');
    expect(heading.querySelectorAll('.aui-name-underline')).toHaveLength(1);
    expect(container.querySelectorAll('.aui-name-underline')).toHaveLength(1);
  });

  it('puts Productivity first, then the help areas, and fills the gold only when a brief exists', () => {
    const { rerender, props } = renderTour({ hasBrief: false });
    const pills = within(screen.getByRole('list', { name: 'What would help you most?' })).getAllByRole('button');
    expect(pills.map(pill => pill.textContent)).toEqual([
      'Productivity',
      ...HELP_AREA_IDS.map(id => HELP_AREAS[id].label),
    ]);
    expect(pills[0]).not.toHaveClass('bg-gold-soft');

    rerender(<AmanTour {...props} hasBrief />);
    expect(screen.getByRole('button', { name: 'Productivity' })).toHaveClass('bg-gold-soft');
  });

  it('starts a chat with the morning brief from Productivity, and with the first prompt of a help area', () => {
    const { props } = renderTour();

    fireEvent.click(screen.getByRole('button', { name: 'Productivity' }));
    expect(props.onSend).toHaveBeenLastCalledWith(MORNING_BRIEF.prompt);

    const area = HELP_AREA_IDS[0];
    if (area === undefined) throw new Error('no help areas');
    fireEvent.click(screen.getByRole('button', { name: HELP_AREAS[area].label }));
    expect(props.onSend).toHaveBeenLastCalledWith(HELP_AREAS[area].cards[0]?.prompt);
  });

  it('fills the composer, without sending, from one of the four cards', () => {
    const { props } = renderTour();

    expect(screen.getByRole('heading', { name: 'Some things Mannie can do' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Plan your day/ }));

    expect(props.onFill).toHaveBeenCalledWith(expect.stringContaining('Help me plan my day'));
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('shows the prompt line, the setup ticket and Skip only on a first run', () => {
    const onSkip = vi.fn();
    const { rerender, props } = renderTour({ firstRun: true, onSkip });

    expect(screen.getByText('What would help you most? Pick one and Mannie starts there.')).toBeInTheDocument();
    expect(screen.getByText('Setup ticket')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Skip the tour' }));
    expect(onSkip).toHaveBeenCalledTimes(1);

    rerender(<AmanTour {...props} firstRun={false} onSkip={onSkip} />);
    expect(screen.queryByText(/What would help you most\? Pick one/)).not.toBeInTheDocument();
    expect(screen.queryByText('Setup ticket')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Skip the tour' })).not.toBeInTheDocument();
  });

  it('says what to do and turns the pills off when no model is set', () => {
    renderTour({ canSend: false });

    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Productivity' })).toBeDisabled();
  });
});
