import { readMessage } from '../../../../src/core/email/gmail/message';
import {
  addressListIsPlain,
  getDraftResult,
  listThreadsResult,
  mailboxesOf,
  readEmailResult,
  threadResult,
  UNTRUSTED_NOTICE,
} from '../../../../src/core/email/gmail/results';
import { estimateTokens, MAX_TOKENS_PER_CALL } from '../../../../src/core/email/gmail/tokenBound';
import { message, thread } from './fixtures';

const context = { account: 'ada@example.com', attachmentsOpenable: true };

describe('message reading', () => {
  it('prefers the plain text part and lists attachments with their ids', () => {
    const read = readMessage(
      message({
        id: 'm1',
        body: 'See attached.',
        html: '<p>ignored</p>',
        attachments: [{ id: 'att-1', filename: 'lease.pdf', mimeType: 'application/pdf', size: 1234 }],
      }),
    );
    expect(read.body).toBe('See attached.');
    expect(read.attachments).toEqual([{ id: 'att-1', filename: 'lease.pdf', mimeType: 'application/pdf', size: 1234 }]);
  });

  it('falls back to HTML as text, without scripts or tags', () => {
    const read = readMessage(
      message({ id: 'm1', html: '<style>p{}</style><p>Hello&nbsp;<b>Ada</b></p><script>steal()</script>' }),
    );
    expect(read.body).toBe('Hello Ada');
  });

  it('splits an address header on commas outside quotes, keeping each name with its address', () => {
    expect(mailboxesOf('"Lovelace, Ada" <ada@example.com>, grace@example.com')).toEqual([
      { name: 'Lovelace, Ada', address: 'ada@example.com' },
      { name: '', address: 'grace@example.com' },
    ]);
  });

  it('decodes an encoded name, and takes the address from the brackets when a name looks like one', () => {
    expect(
      mailboxesOf('=?UTF-8?Q?Maya_L=C3=B3pez?= <maya@example.com>, "boss@example.com" <other@evil.example>'),
    ).toEqual([
      { name: 'Maya López', address: 'maya@example.com' },
      { name: 'boss@example.com', address: 'other@evil.example' },
    ]);
  });
});

describe('result shapes', () => {
  it('names the account and marks mail untrusted on every result', () => {
    const results = [
      listThreadsResult({ context, threads: [], providerEstimate: 0, nextPageToken: undefined, notReached: 0 }),
      readEmailResult({ context, message: message({ id: 'm1', body: 'hi' }) }),
      threadResult({ context, thread: thread('t1', [message({ id: 'm1', body: 'hi' })]), format: 'full' }),
      getDraftResult({ context, draftId: 'd1', message: message({ id: 'm1', body: 'hi' }) }),
    ];
    for (const result of results) {
      expect(result.account).toBe('ada@example.com');
      expect(result.untrusted_content).toBe(UNTRUSTED_NOTICE);
    }
  });

  it('lists the web images an email links, even when it also has plain text', () => {
    const withImages = readEmailResult({
      context,
      message: message({
        id: 'm1',
        body: 'Sale today',
        html: '<p>Sale</p><img src="https://example.com/banner.png"><img src="cid:logo">',
      }),
    });
    expect(withImages.linked_images).toEqual(['https://example.com/banner.png']);
    const plain = readEmailResult({ context, message: message({ id: 'm2', body: 'hi' }) });
    expect('linked_images' in plain).toBe(false);
  });

  it('lists threads with the fields the fetch semantics expect and states coverage', () => {
    const result = listThreadsResult({
      context,
      threads: [
        thread('t1', [
          message({ id: 'm1', threadId: 't1', body: 'one' }),
          message({ id: 'm2', threadId: 't1', body: 'two', subject: 'Re: Lease' }),
        ]),
      ],
      providerEstimate: 12,
      nextPageToken: 'next',
      notReached: 0,
    });
    expect(result.threads[0]).toMatchObject({
      id: 't1',
      thread_id: 't1',
      subject: 'Re: Lease',
      message_count: 2,
      label_ids: ['INBOX'],
    });
    expect(result.coverage).toEqual({
      returned: 1,
      provider_estimate: 12,
      truncated_by: 'max_results',
      omitted_by_token_bound: 0,
    });
    expect(result.next_page_token).toBe('next');
  });

  it('keeps a long thread inside the token bound, newest bodies first, and keeps every message id', () => {
    const long = 'word '.repeat(10_000);
    const messages = [1, 2, 3].map(index => message({ id: `m${String(index)}`, threadId: 't1', body: long }));
    const result = threadResult({ context, thread: thread('t1', messages), format: 'full' });
    expect(result.messages.map(row => row.id)).toEqual(['m1', 'm2', 'm3']);
    expect(result.truncated).toBe(true);
    const bodyTokens = result.messages.reduce((sum, row) => sum + estimateTokens(row.body ?? ''), 0);
    expect(bodyTokens).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(result.messages[2]?.body?.length).toBeGreaterThan(result.messages[0]?.body?.length ?? 0);
  });

  it('keeps a Japanese thread inside the same bound', () => {
    const long = '日本語のメール'.repeat(5000);
    const result = threadResult({
      context,
      thread: thread('t1', [message({ id: 'm1', threadId: 't1', body: long })]),
      format: 'full',
    });
    expect(estimateTokens(result.messages[0]?.body ?? '')).toBeLessThanOrEqual(MAX_TOKENS_PER_CALL);
    expect(result.truncated).toBe(true);
  });

  it('returns no bodies for the metadata format', () => {
    const result = threadResult({
      context,
      thread: thread('t1', [message({ id: 'm1', body: 'hi' })]),
      format: 'metadata',
    });
    expect(result.messages[0]).not.toHaveProperty('body');
    expect(result.truncated).toBe(false);
  });

  it('states when a single message body is cut', () => {
    const result = readEmailResult({ context, message: message({ id: 'm1', body: 'word '.repeat(20_000) }) });
    expect(result.body_truncated).toBe(true);
  });

  it('reads a draft with its recipients split into addresses', () => {
    const result = getDraftResult({
      context,
      draftId: 'd1',
      message: message({
        id: 'm1',
        body: 'Thursday works.',
        to: 'Grace <grace@example.com>, lin@example.com',
        extraHeaders: [
          { name: 'Cc', value: 'sam@example.com' },
          { name: 'In-Reply-To', value: '<abc@mail.example.com>' },
        ],
      }),
    });
    expect(result).toMatchObject({
      draft_id: 'd1',
      to: ['grace@example.com', 'lin@example.com'],
      cc: ['sam@example.com'],
      bcc: [],
      in_reply_to: '<abc@mail.example.com>',
      attachments: [],
    });
  });
});

describe('mailbox headers that could read two ways', () => {
  it('refuses a quoted display name that looks like an address, as it refuses one unquoted', () => {
    expect(addressListIsPlain('"boss@example.com" <other@example.org>')).toBe(false);
    expect(addressListIsPlain('"Reviewer (ops)" <ops@example.org>')).toBe(false);
    expect(addressListIsPlain('boss@example.com <other@example.org>')).toBe(false);
    expect(addressListIsPlain('"Grace Lee" <grace@example.com>')).toBe(true);
  });

  it('shows a part with more than one angle bracket whole, as the address, and never splits it', () => {
    expect(mailboxesOf('"Ada" <ada@example.com> <grace@example.org>')).toEqual([
      { name: '', address: '"Ada" <ada@example.com> <grace@example.org>' },
    ]);
    expect(mailboxesOf('Ada <ada@example.com>')).toEqual([{ name: 'Ada', address: 'ada@example.com' }]);
  });
});
