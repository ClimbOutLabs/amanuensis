import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { AmanTour } from '@/components/AmanTour.js';
import {
  CAPABILITY_PROMPTS,
  GENERAL_DAY_PROMPTS,
  tryADayPrompts,
  visibleTourPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };
const GENERAL_CARDS = tryADayPrompts({ helpAreas: [], capabilities: ALL });

function renderTour(overrides: Partial<ComponentProps<typeof AmanTour>> = {}) {
  const props = {
    capabilities: ALL,
    helpAreas: [],
    canSend: true,
    onSend: vi.fn(),
    onHide: vi.fn(),
    setup: null,
    ...overrides,
  };
  render(<AmanTour {...props} />);
  return props;
}

describe('AmanTour', () => {
  it('leads with the headline, then the day cards and the capability chips', () => {
    renderTour();

    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Aman is your chief of staff.',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        'It keeps track of your life and checks with you before taking important actions. It runs on your own computer.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Try a day with Aman' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'What Aman can do' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide the tour' })).toBeInTheDocument();
  });

  it('shows the setup block above the cards when the host passes one', () => {
    renderTour({ setup: <p>Setup block here</p> });

    expect(screen.getByText('Setup block here')).toBeInTheDocument();
  });

  it('sends each day card its exact prompt', () => {
    const { onSend } = renderTour();

    for (const item of GENERAL_CARDS) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(item.label) }));
      expect(onSend).toHaveBeenLastCalledWith(item.prompt);
    }
    expect(onSend).toHaveBeenCalledTimes(GENERAL_CARDS.length);
  });

  it('shows the morning brief first and the general set when no area is chosen', () => {
    renderTour();

    const labels = screen.getAllByRole('button').map(button => button.textContent ?? '');
    const dayStart = labels.findIndex(label => label.startsWith('Your morning brief'));
    expect(dayStart).toBeGreaterThanOrEqual(0);
    expect(labels[dayStart + 1]).toMatch(/^Check for scams/);
    expect(GENERAL_CARDS).toHaveLength(6);
  });

  it('builds the day cards from the chosen areas, in the order chosen', () => {
    renderTour({ helpAreas: ['focus'] });
    const days = within(screen.getByRole('region', { name: 'Try a day with Aman' }));

    expect(days.getByRole('button', { name: /Help me clear my head/ })).toBeInTheDocument();
    expect(days.getByRole('button', { name: /Help me get started/ })).toBeInTheDocument();
    expect(days.queryByRole('button', { name: /Help me with doctor's appointments/ })).not.toBeInTheDocument();
    expect(days.getAllByRole('button')).toHaveLength(6);
  });

  it('shows the prompt text on each day card so people see what will be sent', () => {
    renderTour();

    for (const item of GENERAL_CARDS) {
      expect(screen.getByRole('button', { name: new RegExp(item.label) })).toHaveTextContent(item.prompt);
    }
  });

  it('sends each capability chip its exact prompt', () => {
    const { onSend } = renderTour();

    for (const item of CAPABILITY_PROMPTS) {
      fireEvent.click(screen.getByRole('button', { name: item.label }));
      expect(onSend).toHaveBeenLastCalledWith(item.prompt);
    }
    expect(onSend).toHaveBeenCalledTimes(CAPABILITY_PROMPTS.length);
  });

  it('offers only the prompts this instance can run', () => {
    renderTour({ capabilities: NONE });
    const days = within(screen.getByRole('region', { name: 'Try a day with Aman' }));

    expect(days.queryByRole('button', { name: /Check for scams/ })).not.toBeInTheDocument();
    expect(days.queryByRole('button', { name: /Reply to an email/ })).not.toBeInTheDocument();
    expect(days.queryByRole('button', { name: /Help me with doctor's appointments/ })).not.toBeInTheDocument();
    expect(days.queryByRole('button', { name: /Find forgotten subscriptions/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Your morning brief/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Handle your email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read files and run code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Learn new skills' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run things on a schedule' })).toBeInTheDocument();
  });

  it('keeps the email prompts for an email grant alone and the calendar prompts for a calendar grant alone', () => {
    renderTour({ capabilities: { ...NONE, email: true } });

    expect(screen.getByRole('button', { name: 'Handle your email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Check for scams/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Help me with doctor's appointments/ })).not.toBeInTheDocument();
  });

  it('turns the buttons off and says why when no model is set', () => {
    const { onSend } = renderTour({ canSend: false });

    const chip = screen.getByRole('button', { name: 'Run things on a schedule' });
    expect(chip).toBeDisabled();
    fireEvent.click(chip);
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByText('Choose a model in Settings before you start a chat.')).toBeInTheDocument();
  });

  it('hands the hide control to the host', () => {
    const { onHide } = renderTour();

    fireEvent.click(screen.getByRole('button', { name: 'Hide the tour' }));
    expect(onHide).toHaveBeenCalledTimes(1);
  });
});

describe('visibleTourPrompts', () => {
  it('keeps the prompts that need nothing, whatever the capabilities', () => {
    const visible = visibleTourPrompts(GENERAL_DAY_PROMPTS, NONE);

    expect(visible.map(item => item.key)).toEqual(['plan-day']);
  });
});
