// @vitest-environment jsdom
import { render, screen } from '@testing-library/react';
import { holdSay, searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';
import { describe, expect, it, vi } from 'vitest';

import { APPROVAL_CHOICES, EMAIL_CHOICES, offersChangeIt } from '@/sentinel/approvalChoices.js';
import { HeldActionCard } from '@/sentinel/HeldActionCard.js';
import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import { SentinelApiProvider } from '@/sentinel/SentinelApiContext.js';
import { SentinelSettings } from '@/sentinel/SentinelSettings.js';
import type { SentinelApi, SentinelApprovalCard } from '@/sentinel/types.js';

const card: SentinelApprovalCard = {
  plain_what: 'Send a short note to the Example team',
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
  agent: null,
};

const buttonNames = () => screen.getAllByRole('button').map(button => button.textContent);

describe('approval choices', () => {
  it('shows the safe verb, the quiet no, and Always allow this here in plain view, and never Always deny', () => {
    render(
      <PermissionApprovalCard
        approvalId="approval-1"
        othersWaiting={0}
        card={card}
        onApprove={vi.fn()}
        onApproveForChat={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(buttonNames()).toEqual(['Allow', 'Not now', 'Always allow this here']);
    // A choice the server offers is never folded into the closed Details block.
    expect(screen.getByRole('button', { name: 'Always allow this here' }).closest('details')).toBeNull();
    expect(screen.getByRole('button', { name: 'Allow' })).toHaveAttribute('title', 'Allow this one call only.');
    expect(screen.getByRole('button', { name: 'Always allow this here' })).toHaveAttribute(
      'title',
      "Don't ask again for this kind of action in this chat.",
    );
    expect(screen.queryByText(/Always deny/i)).not.toBeInTheDocument();
  });

  it('shows Approve, Always allow this tool, Deny in that order on a held action, and never Always deny', () => {
    render(
      <HeldActionCard
        card={card}
        status={{ kind: 'waiting' }}
        alwaysAllowOffered
        onApprove={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(buttonNames()).toEqual(['Approve', 'Always allow this tool', 'Deny']);
    expect(screen.getByRole('button', { name: 'Always allow this tool' })).toHaveAttribute(
      'title',
      'Run this tool on this connector without asking, in every chat, until you remove it in settings.',
    );
    expect(screen.queryByText(/Always deny/i)).not.toBeInTheDocument();
  });

  it('lists all four choices in order on the Settings permissions page, with no Always deny', async () => {
    const settings = {
      offline_mode: false,
      tier2_auto_allow: [],
      search_without_asking: true,
      maps_without_asking: false,
      sandbox_without_asking: true,
    };
    const api: SentinelApi = {
      listAuditEntries: vi.fn(async () => []),
      listBriefItemCompletions: async () => [],
      markBriefItemDone: async () => undefined,
      unmarkBriefItemDone: async () => undefined,
      listUserAuditEntries: vi.fn(async () => ({ entries: [] })),
      getUserSettings: vi.fn(async () => settings),
      updateUserSettings: vi.fn(async patch => ({ ...settings, ...patch })),
      listSentinelSessionContext: vi.fn(async () => ({ approvals: [] })),
    };
    render(
      <SentinelApiProvider api={api}>
        <SentinelSettings />
      </SentinelApiProvider>,
    );
    const terms = (await screen.findAllByRole('term')).map(term => term.textContent);
    expect(terms).toEqual(['Approve', 'Always allow this here', 'Always allow', 'Deny']);
    expect(screen.queryByText(/Always deny/i)).not.toBeInTheDocument();
  });
});

describe('grant hint wording', () => {
  it('never calls the chat persona an agent in a Change it or Edit hint, and says persona', () => {
    expect(APPROVAL_CHOICES.changeIt.hint).toBe('Ask the persona to change this first. Nothing runs now.');
    expect(EMAIL_CHOICES.edit.hint).toBe('Ask the persona to change this first. Nothing is sent now.');
    for (const hint of [APPROVAL_CHOICES.changeIt.hint, EMAIL_CHOICES.edit.hint]) {
      expect(hint).not.toMatch(/\bagent\b/i);
    }
  });

  it('shows the persona hint as the Change it title on a held card', () => {
    render(
      <HeldActionCard
        card={card}
        status={{ kind: 'waiting' }}
        alwaysAllowOffered={false}
        onApprove={vi.fn()}
        onAlwaysAllow={vi.fn()}
        onDeny={vi.fn()}
        onChangeRequest={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Change it' })).toHaveAttribute(
      'title',
      'Ask the persona to change this first. Nothing runs now.',
    );
  });
});

describe('offersChangeIt', () => {
  const mail = {
    action: 'send' as const,
    to: [],
    cc: [],
    bcc: [],
    subject: 'Lunch',
    body: 'Lunch at noon?',
    replaces: null,
    reply_in_thread: null,
    reply_to: null,
  };
  const event = {
    action: 'create' as const,
    calendar: 'Work',
    title: 'Sync',
    when: 'Mon 10:00',
    time_zone: 'UTC',
    duration: '30 min',
    location: '',
    description: '',
    attendees: [],
    guests_emailed: false,
    one_of_repeating: false,
    before: null,
  };
  const schedule = {
    action: 'create' as const,
    name: 'Daily digest',
    when: 'Every day at 8',
    time_zone: 'UTC',
    task: 'Send the digest',
    runs_as: 'Aman',
    next_runs: [],
  };

  it('offers Change it for a mail, a calendar event, or a new schedule', () => {
    expect(offersChangeIt({ ...card, email: mail })).toBe(true);
    expect(offersChangeIt({ ...card, calendar_event: event })).toBe(true);
    expect(offersChangeIt({ ...card, schedule })).toBe(true);
  });

  it('offers Change it for a held web search or page read, so its words can be edited before it is sent', () => {
    const say = holdSay('Aman').search_setting;
    expect(
      offersChangeIt({ ...card, plain_what: searchHoldCardText({ summary: 'clinic hours', say, page: false }) }),
    ).toBe(true);
    expect(
      offersChangeIt({ ...card, plain_what: searchHoldCardText({ summary: 'https://example.org', say, page: true }) }),
    ).toBe(true);
  });

  it('offers Change it for a new persona', () => {
    expect(
      offersChangeIt({
        ...card,
        persona: { name: 'Tutor', description: 'Helps', instructions: 'Be patient.', model_name: 'model-a' },
      }),
    ).toBe(true);
  });

  it('offers Change it for a new agent', () => {
    expect(
      offersChangeIt({
        ...card,
        agent: {
          name: 'tutor',
          description: 'Helps',
          instructions: 'Be patient.',
          model_name: 'model-a',
          connectors: [],
          skills: [],
          sandbox_enabled: false,
        },
      }),
    ).toBe(true);
  });

  it('offers no Change it for a delete or for an action with nothing to edit', () => {
    expect(offersChangeIt({ ...card, schedule: { ...schedule, action: 'delete' } })).toBe(false);
    expect(offersChangeIt({ ...card, parsed_command: 'rm -rf /tmp/work' })).toBe(false);
  });

  it('offers Change it for a mail send or draft to a new recipient, and not for a card with none', () => {
    expect(offersChangeIt({ ...card, mail_new_recipients: ['a@x.com'] })).toBe(true);
    expect(offersChangeIt({ ...card, mail_new_recipients: ['a@x.com'], mail_draft: true })).toBe(true);
    expect(offersChangeIt({ ...card, mail_new_recipients: null })).toBe(false);
  });
});
