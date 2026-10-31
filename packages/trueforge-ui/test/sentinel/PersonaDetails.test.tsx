// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { extractSentinelFromEvent, type SentinelApprovalCard } from '@/sentinel/types.js';

const INSTRUCTIONS = 'Plans trips in detail, with a day-by-day route.\n\nFocus on routes, timing and local food.';

/** The card the server sends when the chat asks to add a travel planner persona. */
const TRAVEL_PLANNER_CARD = {
  plain_what: 'Add a persona: Travel planner? Plans trips in detail, with a day-by-day route.',
  plain_why: null,
  cannot_be_undone: null,
  why_asked_again: null,
  destination: null,
  recipient: null,
  amount: null,
  parsed_command: null,
  outbound_text: null,
  destination_host: null,
  outbound_truncated: false,
  email: null,
  calendar_event: null,
  schedule: null,
  persona: {
    name: 'Travel planner',
    description: 'Plans trips in detail, with a day-by-day route.',
    instructions: INSTRUCTIONS,
    model_name: 'openai/gpt-5.2',
  },
} satisfies SentinelApprovalCard;

function renderCard(card: SentinelApprovalCard) {
  render(
    <PermissionApprovalCard
      approvalId="approval-1"
      othersWaiting={0}
      card={card}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
    />,
  );
}

describe('the persona approval card', () => {
  it('asks the question in plain words, and the stub says it is a new persona', () => {
    renderCard(TRAVEL_PLANNER_CARD);
    expect(screen.getByRole('heading', { name: 'Add the persona "Travel planner"?' })).toBeInTheDocument();
    expect(screen.getByText('New persona')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/specialist|\bagents?\b/i);
  });

  it('shows the name and what it is for, and keeps the instructions under Details', () => {
    renderCard(TRAVEL_PLANNER_CARD);
    const region = document.querySelector('[data-role="persona"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('Name: Travel planner');
    expect(region).toHaveTextContent('For: Plans trips in detail, with a day-by-day route.');
    expect(region).toHaveTextContent('Answers with: openai/gpt-5.2');

    const details = screen.getByRole('region', { name: 'Persona instructions' }).closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByRole('region', { name: 'Persona instructions' })).toHaveTextContent(
      'Focus on routes, timing and local food.',
    );
  });

  it('reads the persona from the server event, and drops one with a missing field', () => {
    const event = (persona: Record<string, unknown>) => ({
      type: 'tool.approval_required',
      tool_call_id: 'call-1',
      tier: 3,
      tier3_card: { ...TRAVEL_PLANNER_CARD, persona },
    });
    const [complete] = extractSentinelFromEvent(event(TRAVEL_PLANNER_CARD.persona));
    expect(complete?.card.persona).toEqual(TRAVEL_PLANNER_CARD.persona);

    const { name, description, instructions } = TRAVEL_PLANNER_CARD.persona;
    const [partial] = extractSentinelFromEvent(event({ name, description, instructions }));
    expect(partial?.card.persona).toBeNull();
  });
});
