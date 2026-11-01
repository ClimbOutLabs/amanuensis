// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { searchHoldCardText } from '@truefoundry/trueforge-core/core/permissions/searchHoldText';

import { EmailApprovalCard } from '@/sentinel/EmailApprovalCard.js';
import { PermissionApprovalCard } from '@/sentinel/PermissionApprovalCard.js';
import type { SentinelApprovalCard } from '@/sentinel/types.js';

function baseCard(overrides: Partial<SentinelApprovalCard> = {}): SentinelApprovalCard {
  return {
    plain_what: 'Run the report?',
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
    ...overrides,
  };
}

function renderTicket(card: SentinelApprovalCard) {
  return render(
    <PermissionApprovalCard
      approvalId="approval-1"
      card={card}
      othersWaiting={0}
      onApprove={vi.fn()}
      onDeny={vi.fn()}
    />,
  );
}

/** The card's Details disclosure, closed: the raw request stays folded behind it. */
function detailsDisclosure() {
  const summary = screen.getByText('Details');
  const details = summary.closest('details');
  if (details === null) throw new Error('the card has no Details disclosure');
  return details;
}

describe('approval card content', () => {
  it('asks an email send as a question naming the recipient, with details open and one status line', () => {
    const { container } = render(
      <EmailApprovalCard
        approvalId="approval-1"
        card={baseCard({
          plain_what: 'Send Lease from your Gmail to grace@example.com?',
          email: {
            action: 'send',
            to: [{ name: 'Grace', address: 'grace@example.com' }],
            cc: [],
            bcc: [],
            subject: 'Lease',
            body: 'Thursday works.',
            replaces: null,
            reply_in_thread: null,
            reply_to: null,
          },
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Send this email to Grace?' })).toBeInTheDocument();
    expect(screen.getByText('Grace (grace@example.com)')).toBeInTheDocument();
    expect(screen.getByText('Lease')).toBeInTheDocument();
    expect(screen.getByText('Thursday works.')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/gmail_send|send_draft|exec_shell/);
    expect(container.querySelector('.uppercase')).toBeNull();
  });

  it('asks a draft save as a question, with one status line', () => {
    render(
      <EmailApprovalCard
        approvalId="approval-1"
        card={baseCard({
          plain_what: 'Save a draft Lease in your Gmail to grace@example.com? It is not sent.',
          email: {
            action: 'save',
            to: [{ name: '', address: 'grace@example.com' }],
            cc: [],
            bcc: [],
            subject: 'Lease',
            body: 'Draft body.',
            replaces: null,
            reply_in_thread: null,
            reply_to: null,
          },
        })}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByRole('heading', { name: 'Save this draft?' })).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('asks a calendar add as a question, with the event open and one status line', () => {
    renderTicket(
      baseCard({
        calendar_event: {
          action: 'create',
          calendar: 'ada@example.com',
          title: 'Lunch with Ana',
          when: 'Friday, October 23, 2026, 1:00 pm to 2:00 pm',
          time_zone: 'Europe/Lisbon',
          duration: '1 hour',
          location: 'Cafe',
          description: '',
          attendees: ['ana@example.com'],
          guests_emailed: true,
          one_of_repeating: false,
          before: null,
        },
      }),
    );
    expect(screen.getByRole('heading', { name: 'Add "Lunch with Ana" to your calendar?' })).toBeInTheDocument();
    expect(screen.getByText('Main calendar of ada@example.com')).toBeInTheDocument();
    expect(screen.getByText('Friday, October 23, 2026, 1:00 pm to 2:00 pm')).toBeInTheDocument();
    expect(screen.getByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Not now' })).toBeInTheDocument();
  });

  it('asks a schedule create as a question, with its runs open and one status line', () => {
    renderTicket(
      baseCard({
        schedule: {
          action: 'create',
          name: 'Morning brief',
          when: 'Weekdays',
          time_zone: 'UTC',
          task: 'Summarize the inbox.',
          runs_as: 'Mannie',
          next_runs: ['Monday 8:00 am'],
        },
      }),
    );
    expect(screen.getByRole('heading', { name: 'Create the schedule "Morning brief"?' })).toBeInTheDocument();
    expect(screen.getByText('Weekdays (UTC)')).toBeInTheDocument();
    expect(screen.getByText('Mannie')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
  });

  it('asks a persona add as a question, with its description open and one status line', () => {
    renderTicket(
      baseCard({
        persona: {
          name: 'Tax helper',
          description: 'Files receipts.',
          instructions: 'Keep every receipt.',
          model_name: 'fast',
        },
      }),
    );
    expect(screen.getByRole('heading', { name: 'Add the persona "Tax helper"?' })).toBeInTheDocument();
    expect(screen.getByText('Files receipts.')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
  });

  it('asks a shell command as a question, with the command once, in mono, and one status line', () => {
    const command = 'git clone https://github.com/example/exitramp.git';
    const { container } = renderTicket(
      baseCard({
        plain_what: 'Run this command?',
        parsed_command: command,
        cannot_be_undone: 'Commands can change or delete files.',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Run this command?' })).toBeInTheDocument();
    expect(screen.getAllByText(command)).toHaveLength(1);
    expect(screen.getByText(command).className).toContain('font-mono');
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(container.textContent).not.toMatch(/exec_shell|allowlist|safe list/);
  });

  it('asks a connector send as a question with no tool name, and plain destination rows', () => {
    const { container } = renderTicket(
      baseCard({
        plain_what: 'Send an email to ana@example.com?',
        recipient: 'ana@example.com',
        destination_host: 'mcp.example.com',
        outbound_text: 'to: ana@example.com',
      }),
    );
    expect(screen.getByRole('heading', { name: 'Send an email to ana@example.com?' })).toBeInTheDocument();
    // The stub repeats the recipient, so the row itself is checked inside the details list.
    const details = container.querySelector('dl');
    if (details === null) throw new Error('the card has no details list');
    expect(within(details).getByText('ana@example.com')).toBeInTheDocument();
    expect(screen.getByText('mcp.example.com').className).not.toContain('font-mono');
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(detailsDisclosure().open).toBe(false);
  });

  it('asks a held search as a question with no provider id, and one status line', () => {
    const what = searchHoldCardText({
      summary: 'harbour tides',
      say: 'Searches are set to ask, so Mannie is checking with you first.',
      page: false,
    });
    const { container } = renderTicket(baseCard({ plain_what: what, destination_host: 'Tavily' }));
    expect(screen.getByRole('heading', { name: what })).toBeInTheDocument();
    expect(what.startsWith('Search the web for harbour tides?')).toBe(true);
    expect(container.textContent).not.toMatch(/api\.tavily|tavily_/);
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
  });

  it('asks a map render as a question, with the hosts named and one status line', () => {
    renderTicket(
      baseCard({
        plain_what:
          'Send Lisbon to maps.example.org to find it, then load map tiles for that area from tiles.example.org?',
        destination_host: 'maps.example.org, tiles.example.org',
      }),
    );
    expect(
      screen.getByRole('heading', {
        name: 'Send Lisbon to maps.example.org to find it, then load map tiles for that area from tiles.example.org?',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('maps.example.org, tiles.example.org')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
  });

  it('asks a calendar delete through a connector as a question, with raw arguments folded', () => {
    renderTicket(
      baseCard({
        plain_what: 'Delete "Dentist", Friday? The guest list could not be read, so anyone invited may be emailed.',
        outbound_text: 'calendar_id: home',
      }),
    );
    expect(
      screen.getByRole('heading', {
        name: 'Delete "Dentist", Friday? The guest list could not be read, so anyone invited may be emailed.',
      }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(detailsDisclosure().open).toBe(false);
  });

  it("keeps Add and send and Don't send on a new-recipient card, with the new address named", () => {
    renderTicket(
      baseCard({
        plain_what:
          'New recipient. You have never emailed new@example.com. Approving adds them to your send list and sends. Send an email to new@example.com?',
        recipient: 'new@example.com',
        mail_new_recipients: ['new@example.com'],
      }),
    );
    expect(screen.getByText(/You have never emailed new@example\.com/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add and send' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Don't send" })).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
  });

  it('shows the status once after answering, as the sent line, with no waiting line left', () => {
    renderTicket(baseCard({ plain_what: 'Run this command?' }));
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(screen.queryAllByText('Waiting for you')).toHaveLength(0);
    expect(screen.getByText(/^Done · /)).toBeInTheDocument();
  });
});
