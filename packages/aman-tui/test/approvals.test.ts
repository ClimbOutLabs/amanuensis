import { TrueForgeError, type TrueForgeApi } from '@truefoundry/trueforge-sdk';
import { describe, expect, it } from 'vitest';

import {
  approvalHeadline,
  approvalLines,
  approveChoiceLabel,
  denyChoiceLabel,
  describeAnswerFailure,
  type PendingApproval,
} from '../src/approvals.js';

const BODY_LINES = Array.from({ length: 30 }, (_, index) => `Body line ${String(index + 1)} of the message.`);
const LONG_BODY = [...BODY_LINES, 'The last line of the message mentions the 8:15 train.'].join('\n');

function emailCard(overrides: Partial<TrueForgeApi.Tier3Card> = {}): TrueForgeApi.Tier3Card {
  return {
    amount: null,
    cannotBeUndone: null,
    copy: {
      headline: 'Send this email to Pippa?',
      consequence: 'Once it is sent, it cannot be unsent.',
      reason: null,
    },
    destination: null,
    destinationHost: null,
    mailFrom: 'nora@example.com',
    outboundText: null,
    outboundTruncated: false,
    parsedCommand: null,
    plainWhat: 'Send an email to Pippa.',
    plainWhy: 'You asked for the train summary to go to Pippa.',
    recipient: null,
    whyAskedAgain: null,
    email: {
      action: 'send',
      to: [{ address: 'pippa@example.com', name: 'Pippa' }],
      cc: [{ address: 'sam@example.com', name: '' }],
      bcc: [],
      subject: 'Train times',
      body: LONG_BODY,
      checkCode: 'K7Q2',
      replaces: null,
      replyInThread: null,
    },
    ...overrides,
  };
}

function emailWith(overrides: Partial<TrueForgeApi.Tier3Email>): TrueForgeApi.Tier3Email {
  const base = emailCard().email;
  if (base === null || base === undefined) {
    throw new Error('Expected an email card.');
  }
  return { ...base, ...overrides };
}

function pending(card: TrueForgeApi.Tier3Card | null, overrides: Partial<PendingApproval> = {}): PendingApproval {
  return {
    toolCallId: 'call-1',
    threadId: 'thread-1',
    card,
    toolName: 'Send email',
    canAlwaysAllow: true,
    held: false,
    expiresAt: null,
    ...overrides,
  };
}

function calendarCard(overrides: Partial<TrueForgeApi.Tier3CalendarEvent> = {}): TrueForgeApi.Tier3Card {
  return emailCard({
    email: null,
    copy: { headline: 'Add "Train to the coast" to your calendar?', consequence: null, reason: null },
    calendarEvent: {
      action: 'create',
      attendees: ['Pippa'],
      before: null,
      calendar: 'Personal',
      description: '',
      duration: '1 hour',
      location: '',
      oneOfRepeating: false,
      timeZone: 'Europe/Madrid',
      title: 'Train to the coast',
      when: 'Saturday 15 November at 9:00',
      ...overrides,
    },
  });
}

function failure(statusCode: number, code?: string): TrueForgeError {
  return new TrueForgeError({
    statusCode,
    body: { error: code === undefined ? { message: 'Server line.' } : { message: 'Server line.', code } },
  });
}

describe('the approval lines', () => {
  it('shows the whole email draft, every line of a body longer than any window', () => {
    const lines = approvalLines(pending(emailCard()), 'Mannie');
    expect(lines[0]).toBe('Send this email to Pippa?');
    expect(lines).toContain('Once it is sent, it cannot be unsent.');
    expect(lines).toContain('From: nora@example.com');
    expect(lines).toContain('To: Pippa (pippa@example.com)');
    expect(lines).toContain('Copy: sam@example.com');
    expect(lines).toContain('Subject: Train times');
    expect(lines).toContain('Check code: K7Q2');
    expect(lines).toContain('Mannie says: You asked for the train summary to go to Pippa.');
    // Every body line is there, in order, with nothing cut.
    const messageAt = lines.indexOf('Message');
    expect(messageAt).toBeGreaterThan(0);
    expect(lines.slice(messageAt + 1, messageAt + 1 + BODY_LINES.length + 1)).toEqual([
      ...BODY_LINES,
      'The last line of the message mentions the 8:15 train.',
    ]);
  });

  it('shows a forward with its files line, and the no-files line when there are none', () => {
    const withFiles = emailCard();
    if (withFiles.email === null || withFiles.email === undefined) {
      throw new Error('Expected an email card.');
    }
    withFiles.email.forwards = {
      from: 'Sam',
      subject: 'Old times',
      body: 'The forwarded text.',
      truncated: false,
      attachments: ['times.pdf'],
    };
    const lines = approvalLines(pending(withFiles), 'Mannie');
    expect(lines).toContain('Forwarded message from Sam, subject “Old times”');
    expect(lines).toContain('Files sent with it: times.pdf');

    const noFiles = emailCard();
    if (noFiles.email === null || noFiles.email === undefined) {
      throw new Error('Expected an email card.');
    }
    noFiles.email.forwards = {
      from: 'Sam',
      subject: 'Old times',
      body: 'The forwarded text.',
      truncated: true,
      attachments: [],
    };
    const noFileLines = approvalLines(pending(noFiles), 'Mannie');
    expect(noFileLines).toContain('No files are sent with it.');
    expect(noFileLines).toContain('The forwarded message is longer than the part shown here. All of it is sent.');
  });

  it('builds the headline from the fields when a card carries no copy', () => {
    const card = emailCard({ copy: null });
    expect(approvalHeadline(card)).toBe('Send this email to Pippa?');
    expect(approvalHeadline(null)).toBe('Needs your OK');
    expect(approvalHeadline(emailCard({ copy: null, email: null }))).toBe('Needs your OK');
  });

  it('names the plain what sentence on a new-recipient card, so adding the address is never a surprise', () => {
    const card = emailCard({
      mailNewRecipients: ['pippa@example.com'],
      plainWhat: 'Pippa is not on your send list. Approving adds pippa@example.com to it, then sends.',
    });
    const lines = approvalLines(pending(card), 'Mannie');
    expect(lines).toContain('Pippa is not on your send list. Approving adds pippa@example.com to it, then sends.');
  });

  it('reads a card whose copy never arrived, building the headline from its fields as the web does', () => {
    const card = emailCard({ copy: undefined });
    expect(approvalHeadline(card)).toBe('Send this email to Pippa?');
    const lines = approvalLines(pending(card), 'Mannie');
    expect(lines[0]).toBe('Send this email to Pippa?');
    expect(lines).toContain('To: Pippa (pippa@example.com)');
    expect(lines).toContain('Subject: Train times');
    expect(lines).toContain('Message');
  });

  it('reads a card whose nullable fields never arrived, showing nothing for them', () => {
    const card = emailCard({ copy: null, whyAskedAgain: undefined, outboundText: undefined, plainWhy: undefined });
    const lines = approvalLines(pending(card), 'Mannie');
    expect(lines[0]).toBe('Send this email to Pippa?');
    expect(lines).toContain('Message');
    expect(lines.some(line => line.includes('undefined'))).toBe(false);
  });

  it('reads an email whose reply and replaces fields never arrived', () => {
    const card = emailCard({ email: emailWith({ replyInThread: undefined, replaces: undefined }) });
    const lines = approvalLines(pending(card), 'Mannie');
    expect(lines).toContain('To: Pippa (pippa@example.com)');
    expect(lines.some(line => line.startsWith('Reply in the thread'))).toBe(false);
    expect(lines.some(line => line.startsWith('Replaces'))).toBe(false);
  });

  it('reads a plain card whose fact fields never arrived, showing nothing for them', () => {
    const card = emailCard({
      email: null,
      copy: { headline: 'Post to the team board?', consequence: null, reason: null },
      destination: undefined,
      recipient: undefined,
      amount: undefined,
      parsedCommand: undefined,
      destinationHost: undefined,
      outboundText: undefined,
      whyAskedAgain: undefined,
      plainWhy: undefined,
    });
    expect(approvalLines(pending(card), 'Mannie')).toEqual(['Post to the team board?']);
  });

  it('shows only the generic headline for the smallest card the schema allows', () => {
    const card: TrueForgeApi.Tier3Card = {
      amount: null,
      cannotBeUndone: null,
      copy: null,
      destination: null,
      destinationHost: null,
      outboundText: null,
      outboundTruncated: false,
      parsedCommand: null,
      plainWhat: 'Do a thing.',
      plainWhy: null,
      recipient: null,
      whyAskedAgain: null,
    };
    expect(approvalLines(pending(card), 'Mannie')).toEqual(['Needs your OK']);
  });

  it('shows the facts of a plain card once, and the full request', () => {
    const card = emailCard({
      email: null,
      copy: { headline: 'Post to the team board?', consequence: null, reason: 'The board is outside this chat.' },
      destination: 'https://board.example/team',
      recipient: 'Team board',
      amount: null,
      outboundText: 'title: Hello team',
    });
    const lines = approvalLines(pending(card), 'Mannie');
    expect(lines[0]).toBe('Post to the team board?');
    expect(lines).toContain('The board is outside this chat.');
    expect(lines).toContain('Address: https://board.example/team');
    expect(lines).toContain('To: Team board');
    expect(lines).toContain('Full request');
    expect(lines).toContain('title: Hello team');
  });

  it('shows the calendar guest line in the words the card carries', () => {
    const lines = approvalLines(
      pending(calendarCard({ guestsLine: 'The calendar service will email every guest about this.' })),
      'Mannie',
    );
    expect(lines).toContain('Guests: Pippa');
    const guestsAt = lines.indexOf('Guests: Pippa');
    expect(lines[guestsAt + 1]).toBe('The calendar service will email every guest about this.');
    // The words are the card's own. The terminal never names a provider itself.
    expect(lines.some(line => line.includes('Google'))).toBe(false);
  });

  it('shows no guest email line when the calendar card carries none', () => {
    const withGuests = approvalLines(pending(calendarCard()), 'Mannie');
    expect(withGuests).toContain('Guests: Pippa');
    expect(withGuests.some(line => line.includes('email'))).toBe(false);
    const noGuests = approvalLines(pending(calendarCard({ attendees: [] })), 'Mannie');
    expect(noGuests).toContain('Guests: None');
    expect(noGuests.some(line => line.includes('email'))).toBe(false);
  });
});

describe('the choice labels', () => {
  it('says Allow and Deny on a plain card', () => {
    const card = emailCard({ email: null });
    expect(approveChoiceLabel(card)).toBe('Allow');
    expect(denyChoiceLabel(card)).toBe('Deny');
  });

  it('keeps the safe words on a safe-first mail card', () => {
    const card = emailCard({ safeChoice: true });
    expect(denyChoiceLabel(card)).toBe("Don't send");
  });

  it('says Add and send on a new-recipient card, and Add and save draft on its draft form', () => {
    const send = emailCard({ mailNewRecipients: ['pippa@example.com'] });
    expect(approveChoiceLabel(send)).toBe('Add and send');
    expect(denyChoiceLabel(send)).toBe("Don't send");
    const draft = emailCard({ mailNewRecipients: ['pippa@example.com'], mailDraft: true });
    expect(approveChoiceLabel(draft)).toBe('Add and save draft');
    expect(denyChoiceLabel(draft)).toBe("Don't save");
  });
});

describe('the answer failure wording', () => {
  it('reads a refused key as the pair-again case', () => {
    expect(describeAnswerFailure(failure(401), 'Mannie')).toEqual({
      kind: 'key-refused',
      message: "Aman no longer accepts this terminal's key.",
    });
  });

  it('reads stale_approval_continuation as the chat having moved on', () => {
    expect(describeAnswerFailure(failure(409, 'stale_approval_continuation'), 'Mannie')).toEqual({
      kind: 'refused',
      message:
        'The chat moved on before this was answered. Nothing was approved or run. Ask again if you still want it.',
    });
  });

  it('reads approval_conflict as already answered', () => {
    expect(describeAnswerFailure(failure(409, 'approval_conflict'), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'This was already answered, or the chat has moved on. Nothing more was done.',
    });
  });

  it('reads approval_request_ended as the request being over', () => {
    expect(describeAnswerFailure(failure(409, 'approval_request_ended'), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'This request ended. Ask again if you still need it.',
    });
  });

  it('reads the held action refusals in their own words', () => {
    expect(describeAnswerFailure(failure(409, 'held_action_expired'), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'Expired, nothing was done. Ask again in chat.',
    });
    expect(describeAnswerFailure(failure(409, 'held_action_changed'), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'This no longer matches what was held, so nothing was done. Ask again in chat.',
    });
    expect(describeAnswerFailure(failure(409, 'held_action_tool_gone'), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'This tool is not available any more, so nothing was done. Ask again in chat.',
    });
  });

  it('keeps the approval for another try when a turn is still running', () => {
    expect(describeAnswerFailure(failure(409, 'previous_turn_running'), 'Mannie')).toEqual({
      kind: 'retry',
      message: 'Mannie is still working on your last message. Wait for it to finish, or press Stop, then send again.',
    });
    expect(describeAnswerFailure(failure(409, 'turn_could_not_start'), 'Mannie')).toEqual({
      kind: 'retry',
      message: 'That reply could not start, so nothing was done. Answer again.',
    });
  });

  it('reads an ownership refusal and a gone action in plain words', () => {
    expect(describeAnswerFailure(failure(403), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'Only the person this chat belongs to can answer this.',
    });
    expect(describeAnswerFailure(failure(404), 'Mannie')).toEqual({
      kind: 'refused',
      message: 'This saved action is no longer available. Ask again in chat.',
    });
  });

  it('leaves anything else as a try-again', () => {
    expect(describeAnswerFailure(failure(500), 'Mannie')).toEqual({
      kind: 'retry',
      message: 'That did not go through. Try again in a moment.',
    });
    expect(describeAnswerFailure(new Error('boom'), 'Mannie')).toEqual({
      kind: 'retry',
      message: 'That did not go through. Try again in a moment.',
    });
  });
});
