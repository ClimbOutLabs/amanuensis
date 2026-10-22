import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AmanTour, greetingFor, greetingLine } from '@/components/AmanTour.js';
import { KEEP_PAGES_IN_SPACES, firstFrameCardPrompts, type TourCapabilities } from '@/components/tourPrompts.js';

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

    expect(screen.getByRole('group', { name: 'What would help you most?' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What Maya can do' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide the tour' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/Quietly watching|Nothing needs you|Your brief is ready|chief of staff/);
    expect(screen.queryByRole('button', { name: /Open the brief/ })).not.toBeInTheDocument();
  });

  it('shows four capability cards, the last one always Keep pages in Spaces', () => {
    renderTour();

    const cards = within(
      screen.getByRole('heading', { name: 'What Maya can do' }).parentElement as HTMLElement,
    ).getAllByRole('listitem');
    expect(cards).toHaveLength(4);
    expect(
      within(cards[3] as HTMLElement).getByRole('button', { name: KEEP_PAGES_IN_SPACES.label }),
    ).toBeInTheDocument();
  });

  it('shows the five areas as chips, pressed when chosen', () => {
    renderTour({ helpAreas: ['focus'] });

    const group = screen.getByRole('group', { name: 'What would help you most?' });
    expect(within(group).getAllByRole('button')).toHaveLength(5);
    expect(within(group).getByRole('button', { name: 'Focus and getting started' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(group).getByRole('button', { name: 'Family and home' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('adds an area when its chip is tapped', () => {
    const { props } = renderTour({ helpAreas: ['focus'] });

    fireEvent.click(screen.getByRole('button', { name: 'Family and home' }));

    expect(props.onHelpAreasChange).toHaveBeenCalledWith(['focus', 'family']);
  });

  it('sends the exact prompt of a card through the composer', () => {
    const { props } = renderTour({ capabilities: ALL });
    const cards = within(
      screen.getByRole('heading', { name: 'What Maya can do' }).parentElement as HTMLElement,
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

    expect(container.textContent).toContain('What Maya can do');
    expect(container.textContent).not.toMatch(/Aman/);
  });

  it('falls back to Aman only when the person has not chosen a name', () => {
    renderTour({ assistantName: null });

    expect(screen.getByRole('heading', { name: 'What Aman can do' })).toBeInTheDocument();
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
