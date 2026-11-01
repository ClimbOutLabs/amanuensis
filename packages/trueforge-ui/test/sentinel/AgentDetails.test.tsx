// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { extractSentinelFromEvent, type SentinelApprovalCard } from '@/sentinel/types.js';

const INSTRUCTIONS = 'Read my calendar and mail.\n\nSum up the day in five lines.';

/** The card the server sends when the chat asks to save a morning brief agent. */
const MORNING_BRIEF_CARD = {
  plain_what: 'Save an agent: morning-brief? Reads my calendar and mail each morning.',
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
  persona: null,
  agent: {
    name: 'morning-brief',
    description: 'Reads my calendar and mail each morning.',
    instructions: INSTRUCTIONS,
    model_name: 'openai/gpt-5.2',
    connectors: ['calendar', 'mail'],
    skills: [],
    sandbox_enabled: false,
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

describe('the agent approval card', () => {
  it('asks the question in plain words, and the stub says it is a new agent', () => {
    renderCard(MORNING_BRIEF_CARD);
    expect(screen.getByRole('heading', { name: 'Save the agent "morning-brief"?' })).toBeInTheDocument();
    expect(screen.getByText('New agent')).toBeInTheDocument();
  });

  it('lists everything that was agreed, and keeps the instructions under Details', () => {
    renderCard(MORNING_BRIEF_CARD);
    const region = document.querySelector('[data-role="agent"]');
    expect(region).not.toBeNull();
    expect(region).toHaveTextContent('Name: morning-brief');
    expect(region).toHaveTextContent('For: Reads my calendar and mail each morning.');
    expect(region).toHaveTextContent('Answers with: openai/gpt-5.2');
    expect(region).toHaveTextContent('Connectors: calendar, mail');
    expect(region).toHaveTextContent('Skills: None');
    expect(region).toHaveTextContent('Sandbox: Off');

    const details = screen.getByRole('region', { name: 'Agent instructions' }).closest('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(screen.getByRole('region', { name: 'Agent instructions' })).toHaveTextContent(
      'Sum up the day in five lines.',
    );
  });

  it('says when skills and the sandbox are on', () => {
    renderCard({
      ...MORNING_BRIEF_CARD,
      agent: { ...MORNING_BRIEF_CARD.agent, skills: ['pdf', 'charts'], sandbox_enabled: true },
    });
    const region = document.querySelector('[data-role="agent"]');
    expect(region).toHaveTextContent('Skills: pdf, charts');
    expect(region).toHaveTextContent('Sandbox: On');
  });

  it('reads the agent from the server event, and drops one with a missing field', () => {
    const event = (agent: Record<string, unknown>) => ({
      type: 'tool.approval_required',
      tool_call_id: 'call-1',
      tier: 3,
      tier3_card: { ...MORNING_BRIEF_CARD, agent },
    });
    const [complete] = extractSentinelFromEvent(event(MORNING_BRIEF_CARD.agent));
    expect(complete?.card.agent).toEqual(MORNING_BRIEF_CARD.agent);

    const { name, description, instructions, model_name, connectors, skills } = MORNING_BRIEF_CARD.agent;
    const [partial] = extractSentinelFromEvent(
      event({ name, description, instructions, model_name, connectors, skills }),
    );
    expect(partial?.card.agent).toBeNull();
  });

  it('reads a card from an older server that has no agent as a card with none', () => {
    const { agent: _agent, ...older } = MORNING_BRIEF_CARD;
    const [parsed] = extractSentinelFromEvent({
      type: 'tool.approval_required',
      tool_call_id: 'call-1',
      tier: 3,
      tier3_card: older,
    });
    expect(parsed?.card.agent).toBeNull();
  });
});
