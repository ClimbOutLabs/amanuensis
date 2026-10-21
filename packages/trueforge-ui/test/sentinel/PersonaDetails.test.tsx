// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { extractSentinelFromEvent, type SentinelApprovalCard } from '@/sentinel/types.js';

const INSTRUCTIONS = 'Plans trips in detail, with a day-by-day route.\n\nFocus on routes, timing and local food.';

/** The card the server sends when the chat asks to add a travel planner specialist. */
const TRAVEL_PLANNER_CARD = {
  plain_what: 'Add a specialist: Travel planner. Plans trips in detail, with a day-by-day route.',
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
    <PermissionApprovalCard toolName="create_persona" card={card} tier={3} onApprove={vi.fn()} onDeny={vi.fn()} />,
  );
}

describe('the specialist approval card', () => {
  it('states the one sentence that says what will be added', () => {
    renderCard(TRAVEL_PLANNER_CARD);
    expect(screen.getByText(TRAVEL_PLANNER_CARD.plain_what)).toBeInTheDocument();
    expect(screen.getByText('New specialist')).toBeInTheDocument();
  });

  it('shows the name and what it is for, and keeps the instructions under Details', () => {
    renderCard(TRAVEL_PLANNER_CARD);
    const region = document.querySelector('[data-role="persona"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('Name: Travel planner');
    expect(region).toHaveTextContent('For: Plans trips in detail, with a day-by-day route.');
    expect(region).toHaveTextContent('Answers with: openai/gpt-5.2');

    const details = screen.getByText('Details').closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByRole('region', { name: 'Specialist instructions' })).toHaveTextContent(
      'Focus on routes, timing and local food.',
    );
  });

  it('reads the specialist from the server event, and drops one with a missing field', () => {
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
