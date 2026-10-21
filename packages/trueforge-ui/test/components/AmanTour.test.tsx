import { fireEvent, render, screen, within } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { MORNING_BRIEF_PROMPT } from '@truefoundry/trueforge-core/core/schedules/morningBrief';

import { AmanTour } from '@/components/AmanTour.js';
import {
  CAPABILITY_PROMPTS,
  GENERAL_DAY_PROMPTS,
  MORNING_BRIEF,
  visibleTourPrompts,
  type TourCapabilities,
} from '@/components/tourPrompts.js';

const ALL: TourCapabilities = { email: true, calendar: true, sandbox: true, maps: true };
const NONE: TourCapabilities = { email: false, calendar: false, sandbox: false, maps: false };

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
  it('leads with the headline, then the morning brief, the day cards and the capability chips', () => {
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

  it('uses the canonical morning brief prompt for the featured card', () => {
    expect(MORNING_BRIEF.prompt).toBe(MORNING_BRIEF_PROMPT);
  });

  it('offers the specialist card prompt that uses a travel specialist', () => {
    const specialists = CAPABILITY_PROMPTS.find(item => item.key === 'specialists');
    expect(specialists).toMatchObject({
      label: 'Bring in specialists',
      prompt: "Get a travel specialist to plan a long weekend somewhere I've never been.",
    });
  });

  it('features the morning brief above the six day cards', () => {
    renderTour();
    const days = within(screen.getByRole('region', { name: 'Try a day with Aman' }));
    const brief = within(screen.getByRole('region', { name: 'Your morning brief' }));

    expect(brief.getByRole('button', { name: MORNING_BRIEF.label })).toBeInTheDocument();
    expect(days.getAllByRole('button')).toHaveLength(GENERAL_DAY_PROMPTS.length + 1);
  });

  it('sends each day card and the brief their exact prompt', () => {
    const { onSend } = renderTour();

    for (const item of [MORNING_BRIEF, ...GENERAL_DAY_PROMPTS]) {
      fireEvent.click(screen.getByRole('button', { name: item.label }));
      expect(onSend).toHaveBeenLastCalledWith(item.prompt);
    }
    expect(onSend).toHaveBeenCalledTimes(GENERAL_DAY_PROMPTS.length + 1);
  });

  it('shows only the label on each card and gives the full prompt as its accessible description', () => {
    renderTour();

    for (const item of [MORNING_BRIEF, ...GENERAL_DAY_PROMPTS, ...CAPABILITY_PROMPTS]) {
      const button = screen.getByRole('button', { name: item.label });
      expect(button).toHaveAccessibleDescription(item.prompt);
      expect(screen.queryByText(item.prompt)).not.toBeVisible();
    }
  });

  it('builds the day cards from the chosen areas, in the order chosen', () => {
    renderTour({ helpAreas: ['focus'] });
    const days = within(screen.getByRole('region', { name: 'Try a day with Aman' }));

    expect(days.getByRole('button', { name: 'Help me clear my head' })).toBeInTheDocument();
    expect(days.getByRole('button', { name: 'Help me get started' })).toBeInTheDocument();
    expect(days.getByRole('button', { name: 'What did I forget?' })).toBeInTheDocument();
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

    expect(days.queryByRole('button', { name: /Help me with doctor's appointments/ })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Your morning brief/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Find forgotten subscriptions' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reply to an email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Handle your email' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Read files and run code' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Learn new skills' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Run things on a schedule' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Keep pages in Spaces' })).toBeInTheDocument();
  });

  it('keeps the email prompts for an email grant alone and the calendar prompts for a calendar grant alone', () => {
    renderTour({ capabilities: { ...NONE, email: true } });

    expect(screen.getByRole('button', { name: 'Handle your email' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Find forgotten subscriptions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reply to an email' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Keep your calendar' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Help me with doctor's appointments/ })).toBeInTheDocument();
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
  it('keeps the general prompts that need nothing, whatever the capabilities', () => {
    const visible = visibleTourPrompts(GENERAL_DAY_PROMPTS, NONE);

    expect(visible.map(item => item.key)).toEqual(['clear-head', 'break-task', 'plan-day', 'meals', 'self-care']);
  });
});
