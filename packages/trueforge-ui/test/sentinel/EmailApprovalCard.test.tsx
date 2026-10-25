// @vitest-environment jsdom
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { EmailApprovalCard, type EmailApprovalCardProps } from '@/sentinel/EmailApprovalCard.js';
import type { SentinelApprovalCard, SentinelApprovalEmail } from '@/sentinel/types.js';

const bare = (address: string) => ({ name: '', address });

function email(overrides: Partial<SentinelApprovalEmail> = {}): SentinelApprovalEmail {
  return {
    action: 'send',
    to: [bare('grace@example.com')],
    cc: [],
    bcc: [],
    subject: 'Lease',
    body: 'Thursday works.\n\nBest,\nAda',
    replaces: null,
    reply_in_thread: null,
    reply_to: null,
    ...overrides,
  };
}

function cardWith(emailOverrides: Partial<SentinelApprovalEmail> = {}): SentinelApprovalCard {
  return {
    plain_what: 'Send an email',
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
    email: email(emailOverrides),
    calendar_event: null,
    schedule: null,
    persona: null,
  };
}

function renderEmail(emailOverrides: Partial<SentinelApprovalEmail> = {}, props: Partial<EmailApprovalCardProps> = {}) {
  const handlers = { onApprove: vi.fn(), onDeny: vi.fn() };
  render(
    <EmailApprovalCard
      approvalId="approval-1"
      card={cardWith(emailOverrides)}
      onApprove={handlers.onApprove}
      onDeny={handlers.onDeny}
      {...props}
    />,
  );
  return handlers;
}

/** A message of `lines` lines, each with `wordsPerLine` words, so the word count is known exactly. */
function longBody(lines: number, wordsPerLine: number): string {
  return Array.from({ length: lines }, (_, line) =>
    Array.from({ length: wordsPerLine }, (__, word) => `w${String(line)}-${String(word)}`).join(' '),
  ).join('\n');
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter(word => word !== '').length;
}

describe('EmailApprovalCard title and verb', () => {
  it('asks "Send this reply to grace@example.com?" with Allow on the button for a reply', () => {
    renderEmail({
      reply_in_thread: { subject: 'Lease', from: 'Grace' },
      subject: 'Re: Lease',
    });
    expect(screen.getByRole('heading', { name: 'Send this reply to grace@example.com?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  it('asks "Send this email to grace@example.com?" with Allow on the button for a new message', () => {
    renderEmail();
    expect(screen.getByRole('heading', { name: 'Send this email to grace@example.com?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  it('asks "Save this draft?" with Allow on the button when the action is a draft', () => {
    renderEmail({ action: 'save' });
    expect(screen.getByRole('heading', { name: 'Save this draft?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Send' })).not.toBeInTheDocument();
  });

  it('uses the same verb for a changed draft as for a new draft', () => {
    renderEmail({ action: 'change' });
    expect(screen.getByRole('heading', { name: 'Save this draft?' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Allow' })).toBeInTheDocument();
  });

  it('shows the Gmail label, one waiting line, and no all-caps', () => {
    const { container } = render(
      <EmailApprovalCard approvalId="approval-1" card={cardWith()} onApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    expect(screen.getByText('Gmail')).toBeInTheDocument();
    expect(screen.getAllByText('Waiting for you')).toHaveLength(1);
    expect(container.querySelector('.uppercase')).toBeNull();
  });
});

describe('EmailApprovalCard fields', () => {
  it('shows each field once: the subject is not repeated under the title', () => {
    renderEmail({ subject: 'Lease' });
    expect(screen.getAllByText('Lease')).toHaveLength(1);
    expect(screen.getAllByText('grace@example.com')).toHaveLength(1);
  });

  it('shows the Copy and Hidden copy rows only when there are some', () => {
    const { unmount } = render(
      <EmailApprovalCard approvalId="approval-1" card={cardWith()} onApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    expect(screen.queryByText('Copy')).not.toBeInTheDocument();
    expect(screen.queryByText('Hidden copy')).not.toBeInTheDocument();
    unmount();

    renderEmail({ cc: [bare('sam@example.com')], bcc: [bare('audit@example.com')] });
    expect(screen.getByText('Copy')).toBeInTheDocument();
    expect(screen.getByText('sam@example.com')).toBeInTheDocument();
    expect(screen.getByText('Hidden copy')).toBeInTheDocument();
    expect(screen.getByText('audit@example.com')).toBeInTheDocument();
  });

  it('shows the reply-in-thread subject and sender rows only for a reply', () => {
    const { unmount } = render(
      <EmailApprovalCard approvalId="approval-1" card={cardWith()} onApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    expect(screen.queryByText('Reply in existing thread')).not.toBeInTheDocument();
    expect(screen.queryByText('Reply in the thread, subject')).not.toBeInTheDocument();
    expect(screen.queryByText('Reply in the thread, from')).not.toBeInTheDocument();
    unmount();

    renderEmail({ reply_in_thread: { subject: 'Lease', from: 'Grace' }, subject: 'Re: Lease' });
    expect(screen.getByText('Reply in existing thread')).toBeInTheDocument();
    expect(screen.getByText('Reply in the thread, subject')).toBeInTheDocument();
    expect(screen.getByText('Lease', { selector: 'dd' })).toBeInTheDocument();
    expect(screen.getByText('Reply in the thread, from')).toBeInTheDocument();
    expect(screen.getByText('Grace', { selector: 'dd' })).toBeInTheDocument();
  });

  it('shows an address replies go to, on its own line, before the person approves', () => {
    renderEmail({ reply_to: 'mallory@example.com' });
    expect(screen.getByText('Replies go to: mallory@example.com')).toBeInTheDocument();
  });

  it('shows no reply line when replies go to the sender', () => {
    renderEmail({ reply_to: null });
    expect(screen.queryByText(/Replies go to/)).not.toBeInTheDocument();
  });

  it('labels the metadata and the message body', () => {
    renderEmail();
    expect(screen.getByText('What will be sent')).toBeInTheDocument();
    expect(screen.getByText('Message body')).toBeInTheDocument();
  });

  it('shows the full recipient list, not a count', () => {
    renderEmail({ to: [bare('grace@example.com'), bare('lin@example.com'), bare('sam@example.com')] });
    expect(screen.getByText('grace@example.com, lin@example.com, sam@example.com')).toBeInTheDocument();
  });
});

describe('EmailApprovalCard body', () => {
  it('keeps the line breaks of a short body and shows no fold control', () => {
    renderEmail({ body: 'Thursday works.\n\nBest,\nAda' });
    const paragraph = screen.getByText(/Thursday works\./);
    expect(paragraph.className).toContain('whitespace-pre-wrap');
    expect(paragraph.textContent).toBe('Thursday works.\n\nBest,\nAda');
    expect(screen.queryByRole('button', { name: /Show full message/ })).not.toBeInTheDocument();
  });

  it('folds a long body to nine lines and shows an honest word count', () => {
    const body = longBody(12, 18);
    renderEmail({ body });
    const fold = screen.getByRole('button', { name: `Show full message · ${String(wordCount(body))} words` });
    expect(fold).toBeInTheDocument();
    expect(fold).toHaveClass('text-gold-ink');
    expect(fold.parentElement?.firstElementChild).toHaveClass('max-h-[13.5rem]');
  });

  it('expands the full message inline and folds it again', () => {
    const body = longBody(12, 18);
    renderEmail({ body });
    fireEvent.click(screen.getByRole('button', { name: /Show full message/ }));
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/w11-17/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show less' }));
    expect(screen.getByRole('button', { name: /Show full message/ })).toBeInTheDocument();
  });

  it('renders a fenced code block in mono, with its line breaks', () => {
    renderEmail({ body: 'Run this:\n```\n$ npm test\n$ npm run build\n```\nThen reply.' });
    const block = screen.getByText(/\$ npm test/);
    expect(block.tagName.toLowerCase()).toBe('pre');
    expect(block).toHaveClass('font-mono');
    expect(block.textContent).toBe('$ npm test\n$ npm run build');
    expect(screen.getByText('Run this:')).not.toHaveClass('font-mono');
  });

  it('keeps the action bar visible under a 3000-word body', () => {
    renderEmail({ body: longBody(300, 10) });
    const send = screen.getByRole('button', { name: 'Allow' });
    const bar = send.parentElement;
    if (bar === null) throw new Error('the allow button has no action bar');
    expect(bar).toHaveClass('sticky', 'bottom-0');
    expect(within(bar).getByRole('button', { name: 'Not now' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Show full message · 3000 words/ })).toBeInTheDocument();
  });

  it('says so when the message has no text', () => {
    renderEmail({ body: '' });
    expect(screen.getByText('This message has no text.')).toBeInTheDocument();
  });
});

describe('EmailApprovalCard actions', () => {
  it('sends once, then shows Sent with the time and no buttons', () => {
    const { onApprove } = renderEmail();
    fireEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(onApprove).toHaveBeenCalledTimes(1);
    expect(screen.getByText(/^Sent · /)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Allow' })).not.toBeInTheDocument();
  });

  it('calls onDeny from Not now', () => {
    const { onDeny } = renderEmail();
    fireEvent.click(screen.getByRole('button', { name: 'Not now' }));
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it('shows Save as draft only when the server offers a draft option', () => {
    const { unmount } = render(
      <EmailApprovalCard approvalId="approval-1" card={cardWith()} onApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Save as draft' })).not.toBeInTheDocument();
    unmount();

    const onSaveDraft = vi.fn();
    renderEmail({}, { onSaveDraft });
    fireEvent.click(screen.getByRole('button', { name: 'Save as draft' }));
    expect(onSaveDraft).toHaveBeenCalledTimes(1);
  });

  it('does not offer Save as draft on a card that is already a draft', () => {
    renderEmail({ action: 'save' }, { onSaveDraft: vi.fn() });
    expect(screen.queryByRole('button', { name: 'Save as draft' })).not.toBeInTheDocument();
  });

  it('shows Edit only when the container passes a change handler, and sends the typed change', () => {
    const { unmount } = render(
      <EmailApprovalCard approvalId="approval-1" card={cardWith()} onApprove={vi.fn()} onDeny={vi.fn()} />,
    );
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
    unmount();

    const onChangeRequest = vi.fn();
    renderEmail({}, { onChangeRequest });
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    const box = screen.getByRole('textbox');
    fireEvent.change(box, { target: { value: '  Make it shorter.  ' } });
    // The change box's own submit button; the card's primary Send is a plain button.
    const boxSend = screen
      .getAllByRole('button', { name: 'Send' })
      .find(button => button.getAttribute('type') === 'submit');
    if (boxSend === undefined) throw new Error('the change box has no submit button');
    fireEvent.click(boxSend);
    expect(onChangeRequest).toHaveBeenCalledWith('Make it shorter.');
  });

  it('never offers Always allow on a mail card', () => {
    renderEmail();
    expect(screen.queryByText(/Always allow/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Always allow this here/)).not.toBeInTheDocument();
  });
});

describe('EmailApprovalCard for a new recipient', () => {
  const card: SentinelApprovalCard = {
    ...cardWith(),
    mail_new_recipients: ['grace@example.com'],
  };

  it("offers Add and send, Edit, Save as draft and Don't send, with the full recipient list", () => {
    const onSaveDraft = vi.fn();
    render(
      <EmailApprovalCard
        approvalId="approval-1"
        card={{ ...card, email: email({ to: [bare('grace@example.com'), bare('lin@example.com')] }) }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onChangeRequest={vi.fn()}
        onSaveDraft={onSaveDraft}
      />,
    );
    const labels = screen.getAllByRole('button').map(button => button.textContent);
    expect(labels).toEqual(['Add and send', 'Edit', 'Save as draft', "Don't send"]);
    expect(screen.getByText('grace@example.com, lin@example.com')).toBeInTheDocument();
  });

  it('says in the server sentence that approving adds the address and sends', () => {
    const sentence = 'New recipient. Approving adds stranger@example.net to your send list and sends.';
    render(
      <EmailApprovalCard
        approvalId="approval-1"
        card={{ ...card, plain_what: sentence }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText(sentence)).toBeInTheDocument();
  });
});

describe('EmailApprovalCard server sentences', () => {
  it('shows the reason and the cannot-be-undone note the server sent', () => {
    render(
      <EmailApprovalCard
        approvalId="approval-1"
        card={{
          ...cardWith(),
          plain_why: 'You asked for the lease reply.',
          cannot_be_undone: "Once this is sent, it can't be unsent.",
        }}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
      />,
    );
    expect(screen.getByText('Why: You asked for the lease reply.')).toBeInTheDocument();
    expect(screen.getByText("Once this is sent, it can't be unsent.")).toBeInTheDocument();
  });
});
