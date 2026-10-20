import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import {
  AmanTour,
  CAPABILITY_PROMPTS,
  TRY_A_DAY_PROMPTS,
  visibleTourPrompts,
  type TourCapabilities,
} from '@/components/AmanTour.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false };

function renderTour(overrides: Partial<ComponentProps<typeof AmanTour>> = {}) {
  const props = {
    capabilities: ALL,
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
        name: 'Your own AI. It knows your life and gets things done, never without your OK.',
      }),
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

    for (const item of TRY_A_DAY_PROMPTS) {
      fireEvent.click(screen.getByRole('button', { name: new RegExp(item.label) }));
      expect(onSend).toHaveBeenLastCalledWith(item.prompt);
    }
    expect(onSend).toHaveBeenCalledTimes(TRY_A_DAY_PROMPTS.length);
  });

  it('shows the prompt text on each day card so people see what will be sent', () => {
    renderTour();

    for (const item of TRY_A_DAY_PROMPTS) {
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
    expect(days.queryByRole('button', { name: /Get ready for an appointment/ })).not.toBeInTheDocument();
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
    expect(screen.queryByRole('button', { name: /Get ready for an appointment/ })).not.toBeInTheDocument();
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
    const visible = visibleTourPrompts(TRY_A_DAY_PROMPTS, NONE);

    expect(visible.map(item => item.key)).toEqual(['brief', 'plan-day']);
  });
});
