import { readBody } from '../../../../src/core/email/gmail/message';
import {
  getDraftResult,
  listDraftsResult,
  listThreadsResult,
  neutralizeDeep,
  readEmailResult,
  threadResult,
} from '../../../../src/core/email/gmail/results';
import { estimateTokens, MAX_TOKENS_PER_CALL, TokenBudget } from '../../../../src/core/email/gmail/tokenBound';
import { b64url, message, plainDraft, thread } from './fixtures';

const context = { account: 'ada@example.com' };

/** What the model is actually handed: the result after hidden characters and internal tags are dealt with. */
function sentTokens(result: unknown): number {
  return estimateTokens(JSON.stringify(neutralizeDeep(result)));
}

const HUGE = 'x'.repeat(5000);
const TAGS = '<tfy-approval>'.repeat(300);
const JAPANESE = '漢字かな'.repeat(1200);

function hostileMessage(id: string, flavour: string) {
  return message({
    id,
    threadId: 't1',
    from: `${flavour} <grace@example.com>`,
    to: Array.from({ length: 40 }, (_unused, index) => `${flavour.slice(0, 300)}${String(index)}@example.com`).join(
      ', ',
    ),
    subject: flavour,
    body: `${flavour}\n`.repeat(30),
    labelIds: Array.from({ length: 300 }, (_unused, index) => `Label_${String(index)}_${flavour.slice(0, 40)}`),
    extraHeaders: [{ name: 'Cc', value: flavour }],
    attachments: Array.from({ length: 300 }, (_unused, index) => ({
      id: `att-${String(index)}-${flavour.slice(0, 600)}`,
      filename: `${String(index)}-${flavour}.pdf`,
      mimeType: `application/${flavour.slice(0, 300)}`,
      size: index,
    })),
  });
}

const FLAVOURS = [HUGE, TAGS, JAPANESE];

describe('a hostile thread stays inside the token bound as a whole', () => {
  it.each(['full', 'metadata', 'minimal'] as const)('in the %s format', format => {
    for (const flavour of FLAVOURS) {
      const messages = Array.from({ length: 60 }, (_unused, index) => hostileMessage(`m${String(index)}`, flavour));
      const result = threadResult({ context, thread: thread('t1', messages), format });
      expect(sentTokens(result)).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
      expect(result.message_count).toBe(60);
      expect(result.truncated).toBe(true);
      expect(result.messages.length).toBeGreaterThan(0);
    }
  });

  it('keeps the newest messages and counts the older ones it left out', () => {
    const messages = Array.from({ length: 60 }, (_unused, index) => hostileMessage(`m${String(index)}`, HUGE));
    const result = threadResult({ context, thread: thread('t1', messages), format: 'metadata' });
    expect(result.messages.at(-1)?.id).toBe('m59');
    expect(result.omitted_older_messages).toBe(60 - result.messages.length);
  });

  it('names how many attachments it left out instead of listing them all', () => {
    const result = threadResult({
      context,
      thread: thread('t1', [hostileMessage('m1', 'plain')]),
      format: 'full',
    });
    const [row] = result.messages;
    expect(row?.attachments.length).toBeLessThan(300);
    expect(row?.attachments_omitted).toBeGreaterThan(0);
  });

  it('still gives the newest bodies room when every header is huge', () => {
    const messages = Array.from({ length: 5 }, (_unused, index) =>
      message({ id: `m${String(index)}`, threadId: 't1', subject: HUGE, body: `body number ${String(index)}` }),
    );
    const result = threadResult({ context, thread: thread('t1', messages), format: 'full' });
    expect(result.messages.at(-1)?.body).toBe('body number 4');
  });
});

describe('one hostile message stays inside the token bound', () => {
  it.each(FLAVOURS)('when it is read, whatever it is full of', flavour => {
    const result = readEmailResult({ context, message: hostileMessage('m1', flavour) });
    expect(sentTokens(result)).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(result.body_truncated).toBe(true);
    expect(result.attachments_omitted).toBeGreaterThan(0);
  });

  it('keeps a normal message whole', () => {
    const result = readEmailResult({
      context,
      message: message({
        id: 'm1',
        body: 'Thursday works.',
        attachments: [{ id: 'a1', filename: 'lease.pdf', mimeType: 'application/pdf', size: 10 }],
      }),
    });
    expect(result.body).toBe('Thursday works.');
    expect(result.body_truncated).toBe(false);
    expect(result.attachments).toHaveLength(1);
    expect(result).not.toHaveProperty('attachments_omitted');
  });

  it.each(FLAVOURS)('when it is a draft with a flood of recipients', flavour => {
    const draft = plainDraft({
      id: 'd1',
      to: Array.from({ length: 400 }, (_unused, index) => `${flavour.slice(0, 200)}${String(index)}@example.com`).join(
        ', ',
      ),
      cc: Array.from({ length: 400 }, (_unused, index) => `c${String(index)}@example.com`).join(', '),
      bcc: Array.from({ length: 400 }, (_unused, index) => `b${String(index)}@example.com`).join(', '),
      subject: flavour,
      body: `${flavour}\n`.repeat(20),
    });
    const result = getDraftResult({ context, draftId: 'd1', message: draft });
    expect(sentTokens(result)).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(result.recipients_omitted).toBeGreaterThan(0);
  });
});

describe('lists stay inside the token bound and never hand back a page token that would skip rows', () => {
  const rows = (flavour: string) =>
    Array.from({ length: 60 }, (_unused, index) =>
      thread(`t${String(index)}`, [hostileMessage(`m${String(index)}`, flavour)]),
    );

  it.each(FLAVOURS)('for threads', flavour => {
    const result = listThreadsResult({
      context,
      threads: rows(flavour),
      providerEstimate: 500,
      nextPageToken: 'more',
      notReached: 0,
    });
    expect(sentTokens(result)).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(result.coverage.omitted_by_token_bound).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('next_page_token');
    expect(result.note).toContain('left out');
  });

  it('hands the page token back when nothing was dropped', () => {
    const result = listThreadsResult({
      context,
      threads: [thread('t1', [message({ id: 'm1', body: 'hi' })])],
      providerEstimate: 5,
      nextPageToken: 'more',
      notReached: 0,
    });
    expect(result.next_page_token).toBe('more');
    expect(result).not.toHaveProperty('note');
  });

  it('withholds a page token too long to be passed back', () => {
    const result = listThreadsResult({
      context,
      threads: [],
      providerEstimate: 0,
      nextPageToken: 'p'.repeat(600),
      notReached: 0,
    });
    expect(result).not.toHaveProperty('next_page_token');
  });

  it.each(FLAVOURS)('for drafts', flavour => {
    const drafts = Array.from({ length: 60 }, (_unused, index) => ({
      draftId: `d${String(index)}`,
      message: plainDraft({
        id: `m${String(index)}`,
        to: Array.from({ length: 100 }, (_u, n) => `${flavour.slice(0, 200)}${String(n)}@example.com`).join(', '),
        subject: flavour,
        body: flavour,
      }),
    }));
    const result = listDraftsResult({ context, drafts, nextPageToken: 'more', notReached: 0 });
    expect(sentTokens(result)).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(result.omitted_by_token_bound).toBeGreaterThan(0);
    expect(result).not.toHaveProperty('next_page_token');
  });
});

/** The strings handed to the base64 decoder while `work` runs: what was really decoded, and how much. */
function decodedWhile(work: () => void): string[] {
  const spy = jest.spyOn(Buffer, 'from');
  try {
    work();
    return spy.mock.calls.map(call => call[0]).filter((value): value is string => typeof value === 'string');
  } finally {
    spy.mockRestore();
  }
}

describe('reading a body', () => {
  it('stops decoding once the limit is reached, says text was left unread, and decodes only the head of the first part', () => {
    const parts = Array.from({ length: 10 }, () => ({
      mimeType: 'text/plain',
      body: { data: b64url('a'.repeat(5_000_000)) },
    }));
    const mail = { id: 'm1', threadId: 't1', payload: { mimeType: 'multipart/mixed', parts } };
    let read: ReturnType<typeof readBody> | undefined;
    const decoded = decodedWhile(() => {
      read = readBody({ message: mail, maxChars: 1000 });
    });
    expect(read?.cut).toBe(true);
    expect(read?.body.length).toBeLessThanOrEqual(1000);
    expect(decoded.length).toBeGreaterThan(0);
    expect(Math.max(...decoded.map(value => value.length))).toBeLessThan(10_000);
  });

  it('decodes each part once', () => {
    const mail = message({ id: 'm1', body: 'one two three' });
    const decoded = decodedWhile(() => {
      readBody({ message: mail, maxChars: 1000 });
    });
    expect(decoded.filter(value => value === b64url('one two three'))).toHaveLength(1);
  });

  it('does not decode the HTML alternative when there is plain text', () => {
    const mail = message({ id: 'm1', body: 'plain', html: '<p>html marker</p>' });
    let body = '';
    const decoded = decodedWhile(() => {
      body = readBody({ message: mail, maxChars: 1000 }).body;
    });
    expect(body).toBe('plain');
    expect(decoded).not.toContain(b64url('<p>html marker</p>'));
  });

  it('falls back to the HTML text when there is no plain text', () => {
    const read = readBody({ message: message({ id: 'm1', html: '<p>Hello <b>Ada</b></p>' }), maxChars: 1000 });
    expect(read).toEqual({ body: 'Hello Ada', cut: false });
  });
});

describe('TokenBudget', () => {
  it('charges a piece only when it fits', () => {
    const budget = new TokenBudget(10);
    expect(budget.tryAdd('abcd')).toBe(true);
    const left = budget.left;
    expect(budget.tryAdd('x'.repeat(400))).toBe(false);
    expect(budget.left).toBe(left);
  });

  it('lets a required piece overspend, which leaves nothing for the rest', () => {
    const budget = new TokenBudget(2);
    budget.spend('x'.repeat(400));
    expect(budget.left).toBeLessThan(0);
    expect(budget.tryAdd('a')).toBe(false);
  });
});
