import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AmanHomeStatus, AmanStarters, type AmanHomeStatusProps } from '@/components/AmanHome.js';
import {
  HELP_AREAS,
  MORNING_BRIEF,
  WAITING_PROMPT,
  WATCHING_PROMPT,
  starterPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };

function renderStatus(overrides: Partial<AmanHomeStatusProps> = {}) {
  const props: AmanHomeStatusProps = {
    assistantName: 'Maya',
    waitingCount: 0,
    scheduleCount: 0,
    canSend: true,
    onSend: vi.fn(),
    ...overrides,
  };
  const { container } = render(<AmanHomeStatus {...props} />);
  return { props, container };
}

describe('AmanHomeStatus', () => {
  it('reads as one quiet line with the brief, the waiting count and the schedules', () => {
    const { container } = renderStatus();

    expect(container.textContent).toBe(
      'Your brief is ready (Open the brief)·Nothing needs you (Check what is waiting)·Nothing runs on a schedule yet·Ask what Maya has noticed',
    );
  });

  it('says how many things need the person, and links to the waiting check', () => {
    renderStatus({ waitingCount: 1 });
    expect(screen.getByText(/^1 thing needs you/)).toBeInTheDocument();

    renderStatus({ waitingCount: 3 });
    expect(screen.getByText(/^3 things need you/)).toBeInTheDocument();
  });

  it('says how many things run on a schedule, with no link on that part', () => {
    const { container } = renderStatus({ scheduleCount: 2 });

    expect(container.textContent).toContain('2 things run on a schedule');
    expect(screen.queryByRole('button', { name: /2 things run/ })).not.toBeInTheDocument();
  });

  it('sends the brief, waiting and watching prompts through the composer', () => {
    const { props } = renderStatus();

    fireEvent.click(screen.getByRole('button', { name: 'Open the brief' }));
    fireEvent.click(screen.getByRole('button', { name: 'Check what is waiting' }));
    fireEvent.click(screen.getByRole('button', { name: 'Ask what Maya has noticed' }));

    expect(props.onSend).toHaveBeenNthCalledWith(1, MORNING_BRIEF.prompt);
    expect(props.onSend).toHaveBeenNthCalledWith(2, WAITING_PROMPT.prompt);
    expect(props.onSend).toHaveBeenNthCalledWith(3, WATCHING_PROMPT.prompt);
  });

  it('turns every link off when no model is set', () => {
    renderStatus({ canSend: false });

    expect(screen.getByRole('button', { name: 'Open the brief' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Check what is waiting' })).toBeDisabled();
  });
});

describe('AmanStarters', () => {
  it('shows nothing until the person picks a help area', () => {
    const { container } = render(<AmanStarters helpAreas={[]} capabilities={ALL} canSend onSend={vi.fn()} />);

    expect(container).toBeEmptyDOMElement();
  });

  it('offers three starters at most, from the picked area, as text buttons', () => {
    render(<AmanStarters helpAreas={['focus']} capabilities={ALL} canSend onSend={vi.fn()} />);

    const starters = screen.getByRole('list', { name: 'Starter suggestions' });
    const buttons = screen.getAllByRole('button');
    expect(starters).toBeInTheDocument();
    expect(buttons.map(button => button.textContent)).toEqual(
      HELP_AREAS.focus.cards.slice(0, 3).map(item => item.label),
    );
  });

  it('takes starters from several picked areas in turn, still at most three', () => {
    render(<AmanStarters helpAreas={['focus', 'family']} capabilities={ALL} canSend onSend={vi.fn()} />);

    const [familyFirst] = HELP_AREAS.family.cards;
    const [focusFirst, focusSecond] = HELP_AREAS.focus.cards;
    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      focusFirst?.label,
      familyFirst?.label,
      focusSecond?.label,
    ]);
  });

  it('sends the starter it was given through the composer', () => {
    const onSend = vi.fn();
    render(<AmanStarters helpAreas={['focus']} capabilities={ALL} canSend onSend={onSend} />);
    const [firstFocus] = HELP_AREAS.focus.cards;

    fireEvent.click(screen.getByRole('button', { name: firstFocus?.label }));

    expect(onSend).toHaveBeenCalledWith(starterPrompts({ helpAreas: ['focus'], capabilities: ALL })[0]?.prompt);
  });

  it('disables the starters when no model is set', () => {
    render(<AmanStarters helpAreas={['focus']} capabilities={ALL} canSend={false} onSend={vi.fn()} />);

    for (const button of screen.getAllByRole('button')) {
      expect(button).toBeDisabled();
    }
  });
});
