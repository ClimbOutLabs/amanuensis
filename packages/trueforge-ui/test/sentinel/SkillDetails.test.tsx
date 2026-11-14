// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { extractSentinelFromEvent, type SentinelApprovalCard } from '@/sentinel/types.js';

const COMMIT = 'a'.repeat(40);

/** The card the server sends when the chat asks to add a skill from someone's repository. */
const RELEASE_NOTES_CARD = {
  plain_what: 'Add the skill "release-notes"? Aman will follow its instructions when a task calls for it.',
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
  skill: {
    name: 'release-notes',
    description: 'Writes release notes from merged changes.',
    source: 'github.com/acme/skills, folder skills/release-notes',
    version: COMMIT,
    starter: false,
    instructions: '# Steps\n\nRead the log.',
    websites: ['api.release-feed.info'],
    makes_up_addresses: false,
    can_send: false,
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

describe('the skill approval card', () => {
  it('asks the question in plain words', () => {
    renderCard(RELEASE_NOTES_CARD);
    expect(screen.getByRole('heading', { name: 'Add the skill "release-notes"?' })).toBeInTheDocument();
  });

  it('keeps where the skill comes from and its exact version in view, and its instructions under Details', () => {
    renderCard(RELEASE_NOTES_CARD);
    const region = document.querySelector('[data-role="skill"]');
    expect(region).toHaveTextContent('Name: release-notes');
    expect(region).toHaveTextContent('For: Writes release notes from merged changes.');
    expect(region).toHaveTextContent('From: github.com/acme/skills, folder skills/release-notes');
    expect(region).toHaveTextContent(`Version: ${COMMIT}`);
    expect(region).toHaveTextContent('This skill was written by someone else.');
    expect(region).toHaveTextContent('Running code still asks you first');

    const instructions = screen.getByRole('region', { name: 'Skill instructions' });
    expect(instructions.closest('details')).not.toHaveAttribute('open');
    expect(instructions).toHaveTextContent('Read the log.');
  });

  it('lists the websites the skill sends requests to, and says approving allows only those', () => {
    renderCard(RELEASE_NOTES_CARD);
    const websites = document.querySelector('[data-role="skill-websites"]');
    expect(websites).toHaveTextContent('It sends requests to these websites:');
    expect(screen.getByRole('listitem')).toHaveTextContent('api.release-feed.info');
    expect(websites).toHaveTextContent('Adding it lets the skill reach these websites and no others.');
    expect(websites).toHaveTextContent('The skill can send any of your data to them');
    expect(websites).not.toHaveTextContent('send email as you');
    expect(websites).not.toHaveTextContent('makes up web addresses');
  });

  it('warns when one of the websites can send email as the person', () => {
    renderCard({ ...RELEASE_NOTES_CARD, skill: { ...RELEASE_NOTES_CARD.skill, can_send: true } });
    expect(document.querySelector('[data-role="skill-websites"]')).toHaveTextContent(
      'One of these sites can send email. This skill will be able to send email as you, without asking each time.',
    );
  });

  it('says when the skill sends no requests, and warns about addresses it makes up while it runs', () => {
    renderCard({
      ...RELEASE_NOTES_CARD,
      skill: { ...RELEASE_NOTES_CARD.skill, websites: [], makes_up_addresses: true },
    });
    const websites = document.querySelector('[data-role="skill-websites"]');
    expect(websites).toHaveTextContent("It doesn't send requests to any website.");
    expect(websites).toHaveTextContent(
      "Aman also found code that makes up web addresses while it runs. Those websites stay blocked, and you'll be asked about each one.",
    );
  });

  it('says a starter skill comes with the app, and shows no empty Details', () => {
    renderCard({ ...RELEASE_NOTES_CARD, skill: { ...RELEASE_NOTES_CARD.skill, starter: true, instructions: null } });
    expect(document.querySelector('[data-role="skill"]')).toHaveTextContent(
      'This is one of the starter skills that come with the app.',
    );
    expect(document.querySelectorAll('details')).toHaveLength(0);
  });

  it('offers only a yes or a no for this one install', () => {
    renderCard(RELEASE_NOTES_CARD);
    expect(screen.getByRole('button', { name: /Allow/ })).toBeInTheDocument();
    expect(screen.queryByText(/Always allow/)).toBeNull();
    expect(screen.queryByText('Change it')).toBeNull();
  });

  it('reads the skill from the server event, and drops one with a missing field', () => {
    const event = (skill: Record<string, unknown>) => ({
      type: 'tool.approval_required',
      tool_call_id: 'call-1',
      tier: 3,
      tier3_card: { ...RELEASE_NOTES_CARD, skill },
    });
    const [complete] = extractSentinelFromEvent(event(RELEASE_NOTES_CARD.skill));
    expect(complete?.card.skill).toEqual(RELEASE_NOTES_CARD.skill);

    const { name, description, source } = RELEASE_NOTES_CARD.skill;
    const [partial] = extractSentinelFromEvent(event({ name, description, source }));
    expect(partial?.card.skill).toBeNull();

    const [badWebsites] = extractSentinelFromEvent(event({ ...RELEASE_NOTES_CARD.skill, websites: [42] }));
    expect(badWebsites?.card.skill).toBeNull();

    // A card saved before websites were shown has neither field, and shows none.
    const { websites: _w, makes_up_addresses: _m, can_send: _c, ...older } = RELEASE_NOTES_CARD.skill;
    const [old] = extractSentinelFromEvent(event(older));
    expect(old?.card.skill).toMatchObject({ websites: [], makes_up_addresses: false, can_send: false });
  });
});
