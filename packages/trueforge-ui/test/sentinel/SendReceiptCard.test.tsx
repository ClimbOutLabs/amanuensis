// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { formatSentTime, NOT_SENT_TEXT, SendReceiptCard } from '@/sentinel/SendReceiptCard.js';
import { NOT_SENT_REASONS, type SentinelSendReceipt } from '@/sentinel/types.js';

// 09:12 in whatever time zone the test runs in, so the assertion reads the same everywhere.
const LOCAL_NINE_TWELVE = new Date(2026, 9, 17, 9, 12, 30).toISOString();

const SENT: SentinelSendReceipt = {
  outcome: 'sent',
  toolCallId: 'call-1',
  sentAt: LOCAL_NINE_TWELVE,
  sentMessageId: 'm-1',
  checkCode: 'A7F39C',
  message: {
    to: ['grace@example.com', 'lin@example.com'],
    cc: ['sam@example.com'],
    bcc: [],
    subject: 'Lease',
    body: 'Thursday works.\n\nBest,\nAda',
  },
};

describe('SendReceiptCard for a send that went out', () => {
  it('says when it was sent, in local time, and that it went exactly as approved', () => {
    render(<SendReceiptCard receipt={SENT} />);
    expect(screen.getByText('Sent at 09:12, exactly as approved')).toBeInTheDocument();
  });

  it('shows the same recipients, subject, body and check code the approval card showed', () => {
    render(<SendReceiptCard receipt={SENT} />);
    expect(screen.getByText('To: grace@example.com, lin@example.com')).toBeInTheDocument();
    expect(screen.getByText('Copy: sam@example.com')).toBeInTheDocument();
    expect(screen.queryByText(/Hidden copy/)).not.toBeInTheDocument();
    expect(screen.getByText('Subject: Lease')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Message, exactly as sent' }).textContent).toBe(
      'Thursday works.\n\nBest,\nAda',
    );
    expect(screen.getByText('Check code', { exact: false })).toHaveTextContent('Check code A7F39C');
  });

  it('has no approve or deny buttons left', () => {
    render(<SendReceiptCard receipt={SENT} />);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });
});

describe('SendReceiptCard for a send that did not go out', () => {
  it('says in plain words that the draft changed, and offers the new card', () => {
    const onReviewAgain = vi.fn();
    render(
      <SendReceiptCard
        receipt={{ outcome: 'not_sent', toolCallId: 'call-1', reason: 'draft_changed' }}
        onReviewAgain={onReviewAgain}
      />,
    );
    expect(screen.getByText('Not sent: the draft changed after you approved it. Review it again.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show the new card' }));
    expect(onReviewAgain).toHaveBeenCalledTimes(1);
  });

  it.each(NOT_SENT_REASONS)('never shows a receipt, a time or a check code for "%s"', reason => {
    render(<SendReceiptCard receipt={{ outcome: 'not_sent', toolCallId: 'call-1', reason }} onReviewAgain={vi.fn()} />);
    expect(screen.getByText(NOT_SENT_TEXT[reason])).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/Sent at|exactly as approved|Check code|Email sent/);
  });

  it('offers the new card only where asking again can help', () => {
    const { rerender } = render(
      <SendReceiptCard
        receipt={{ outcome: 'not_sent', toolCallId: 'call-1', reason: 'gmail_refused' }}
        onReviewAgain={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    rerender(
      <SendReceiptCard
        receipt={{ outcome: 'not_sent', toolCallId: 'call-1', reason: 'needs_ok_again' }}
        onReviewAgain={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Show the new card' })).toBeInTheDocument();
  });

  it('does not say "Not sent" when Gmail never answered, because the message may have gone', () => {
    render(<SendReceiptCard receipt={{ outcome: 'not_sent', toolCallId: 'call-1', reason: 'unconfirmed' }} />);
    expect(NOT_SENT_TEXT.unconfirmed).not.toMatch(/^Not sent/);
    expect(screen.getByText(/may have gone through/)).toBeInTheDocument();
  });
});

describe('formatSentTime', () => {
  it('falls back to the raw text for a time it cannot read', () => {
    expect(formatSentTime('not a time')).toBe('not a time');
  });
});
