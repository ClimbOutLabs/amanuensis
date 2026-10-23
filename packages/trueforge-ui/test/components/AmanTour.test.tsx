import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AmanTour, greetingFor, greetingLine, pickHelpArea } from '@/components/AmanTour.js';
import {
  HELP_AREAS,
  KEEP_PAGES_IN_SPACES,
  firstFrameCardPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';
import { HELP_AREA_IDS } from '@truefoundry/trueforge-core/schemas/personalizationHelpAreas';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

function renderTour(overrides: Partial<ComponentProps<typeof AmanTour>> = {}) {
  const props: ComponentProps<typeof AmanTour> = {
    capabilities: NONE,
    helpAreas: [],
    onHelpAreasChange: vi.fn(),
    assistantName: 'Maya',
    canSend: true,
    onSend: vi.fn(),
    onHide: vi.fn(),
    ...overrides,
  };
  const { container } = render(<AmanTour {...props} />);
  return { props, container };
}

describe('AmanTour panel', () => {
  it('shows the chooser and the capability cards, and nothing from the old hero or status cards', () => {
    const { container } = renderTour();

    expect(screen.getByRole('radiogroup', { name: 'What would help you most?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Some things Maya can do' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide the tour' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Quietly watching|Nothing needs you|Your brief is ready|chief of staff/);
    expect(screen.queryByRole('button', { name: /Open the brief/ })).not.toBeInTheDocument();
  });

  it('shows four capability cards, the last one always Keep pages in Spaces', () => {
    renderTour();

    const cards = within(
      screen.getByRole('heading', { name: 'Some things Maya can do' }).parentElement as HTMLElement,
    ).getAllByRole('listitem');
    expect(cards).toHaveLength(4);
    expect(
      within(cards[3] as HTMLElement).getByRole('button', { name: KEEP_PAGES_IN_SPACES.label }),
    ).toBeInTheDocument();
  });

  it('shows the five areas as a radio group, with the picked one checked', () => {
    renderTour({ helpAreas: ['focus'] });

    const group = screen.getByRole('radiogroup', { name: 'What would help you most?' });
    expect(within(group).getAllByRole('radio')).toHaveLength(HELP_AREA_IDS.length);
    expect(within(group).getByRole('radio', { name: 'Focus and getting started' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(group).getByRole('radio', { name: 'Family and home' })).toHaveAttribute('aria-checked', 'false');
  });

  it('picks one area at a time: a new pick replaces the old one', () => {
    const { props } = renderTour({ helpAreas: ['focus'] });

    fireEvent.click(screen.getByRole('radio', { name: 'Family and home' }));

    expect(props.onHelpAreasChange).toHaveBeenCalledWith(['family']);
  });

  it('moves between pills with the arrow keys, choosing each, and wraps round', () => {
    const { props } = renderTour({ helpAreas: ['focus'] });

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Focus and getting started' }), { key: 'ArrowRight' });
    expect(props.onHelpAreasChange).toHaveBeenLastCalledWith([HELP_AREA_IDS[1]]);

    fireEvent.keyDown(screen.getByRole('radio', { name: 'Focus and getting started' }), { key: 'ArrowLeft' });
    expect(props.onHelpAreasChange).toHaveBeenLastCalledWith([HELP_AREA_IDS[HELP_AREA_IDS.length - 1]]);
  });

  it('keeps one pill in the tab order: the chosen one, or the first when none is chosen', () => {
    renderTour({ helpAreas: ['family'] });

    expect(screen.getByRole('radio', { name: 'Family and home' })).toHaveAttribute('tabindex', '0');
    expect(screen.getByRole('radio', { name: HELP_AREAS.focus.label })).toHaveAttribute('tabindex', '-1');
  });

  it('sends the exact prompt of a card through the composer', () => {
    const { props } = renderTour({ capabilities: ALL });
    const cards = within(
      screen.getByRole('heading', { name: 'Some things Maya can do' }).parentElement as HTMLElement,
    ).getAllByRole('button');

    fireEvent.click(cards[0] as HTMLElement);

    const [first] = firstFrameCardPrompts({ helpAreas: [], capabilities: ALL, assistantName: 'Maya' });
    expect(props.onSend).toHaveBeenCalledWith(first?.prompt);
  });

  it('hands the hide control to the host', () => {
    const { props } = renderTour();

    fireEvent.click(screen.getByRole('button', { name: 'Hide the tour' }));

    expect(props.onHide).toHaveBeenCalledTimes(1);
  });

  it('turns every card off and says why when no model is set', () => {
    renderTour({ canSend: false });

    expect(screen.getByRole('button', { name: KEEP_PAGES_IN_SPACES.label })).toBeDisabled();
  });

  it('uses the chosen name on the capability heading and never says Aman', () => {
    const { container } = renderTour({ assistantName: 'Maya' });

    expect(container.textContent).toContain('Some things Maya can do');
    expect(container.textContent).not.toMatch(/Aman/);
  });

  it('falls back to Aman only when the person has not chosen a name', () => {
    renderTour({ assistantName: null });

    expect(screen.getByRole('heading', { name: 'Some things Aman can do' })).toBeInTheDocument();
  });
});

describe('greetings', () => {
  it('greets by the local hour', () => {
    expect(greetingFor(new Date(2026, 9, 21, 9))).toBe('Good morning');
    expect(greetingFor(new Date(2026, 9, 21, 14))).toBe('Good afternoon');
    expect(greetingFor(new Date(2026, 9, 21, 20))).toBe('Good evening');
  });

  it('adds the name when there is one and stops at the greeting when there is none', () => {
    expect(greetingLine({ now: new Date(2026, 9, 21, 9), name: 'Maya' })).toBe('Good morning, Maya.');
    expect(greetingLine({ now: new Date(2026, 9, 21, 9), name: '  ' })).toBe('Good morning.');
  });
});

describe('pickHelpArea', () => {
  it('replaces the chosen area with the new one, and clears it when picked again', () => {
    expect(pickHelpArea({ current: ['focus'], id: 'family' })).toEqual(['family']);
    expect(pickHelpArea({ current: ['family'], id: 'family' })).toEqual([]);
  });
});
