import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AmanStarters } from '@/components/AmanHome.js';
import {
  HELP_AREAS,
  MORNING_BRIEF,
  WAITING_PROMPT,
  WATCHING_PROMPT,
  starterPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };

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

  it('offers the brief first when the Productivity pill is picked, then its two starters', () => {
    const onSend = vi.fn();
    render(<AmanStarters helpAreas={['productivity']} capabilities={ALL} canSend onSend={onSend} />);

    expect(screen.getAllByRole('button').map(button => button.textContent)).toEqual([
      'Open the brief',
      WAITING_PROMPT.label,
      WATCHING_PROMPT.label,
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Open the brief' }));
    expect(onSend).toHaveBeenCalledWith(MORNING_BRIEF.prompt);
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
