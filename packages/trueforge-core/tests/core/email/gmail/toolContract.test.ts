import {
  DraftEmailSchema,
  DraftIdSchema,
  GetThreadSchema,
  GMAIL_READ_TOOL_NAMES,
  isGmailReadToolName,
  isGmailWriteToolName,
  ListInboxThreadsSchema,
  UpdateDraftSchema,
} from '../../../../src/core/email/gmail/toolContract';

const DRAFT = { to: ['grace@example.com'], subject: 'Lease', body: 'Thursday works.' };

describe('tool names', () => {
  it('sorts every tool into exactly one of read and write', () => {
    for (const name of GMAIL_READ_TOOL_NAMES) {
      expect(isGmailReadToolName(name)).toBe(true);
      expect(isGmailWriteToolName(name)).toBe(false);
    }
    for (const name of ['draft_email', 'update_draft', 'send_draft']) {
      expect(isGmailWriteToolName(name)).toBe(true);
      expect(isGmailReadToolName(name)).toBe(false);
    }
    expect(isGmailReadToolName('delete_everything')).toBe(false);
    expect(isGmailWriteToolName('delete_everything')).toBe(false);
  });

  it('treats attachments as reads and offers no other way to send', () => {
    expect(isGmailReadToolName('download_attachment')).toBe(true);
    expect(isGmailWriteToolName('send_message')).toBe(false);
  });
});

describe('read parameters', () => {
  it('default to the inbox and a page of results', () => {
    expect(ListInboxThreadsSchema.parse({})).toEqual({ query: 'in:inbox', max_results: 50 });
  });

  it.each([{ max_results: 0 }, { max_results: 101 }, { query: 'x'.repeat(257) }, { extra: 1 }])('refuse %j', value => {
    expect(ListInboxThreadsSchema.safeParse(value).success).toBe(false);
  });

  it('read a thread by exactly one of thread_id and message_id', () => {
    expect(GetThreadSchema.parse({ thread_id: 't1' })).toEqual({ thread_id: 't1', format: 'full' });
    expect(GetThreadSchema.safeParse({}).success).toBe(false);
    expect(GetThreadSchema.safeParse({ thread_id: 't1', message_id: 'm1' }).success).toBe(false);
    expect(GetThreadSchema.safeParse({ thread_id: 't1', format: 'raw' }).success).toBe(false);
  });

  it('name a draft by id only', () => {
    expect(DraftIdSchema.safeParse({ draft_id: 'd1' }).success).toBe(true);
    expect(DraftIdSchema.safeParse({ draft_id: 'd1', send: true }).success).toBe(false);
    expect(DraftIdSchema.safeParse({ draft_id: '' }).success).toBe(false);
  });
});

describe('draft parameters', () => {
  it('accept a plain draft and an update of one', () => {
    expect(DraftEmailSchema.safeParse(DRAFT).success).toBe(true);
    expect(UpdateDraftSchema.safeParse({ ...DRAFT, draft_id: 'd1' }).success).toBe(true);
  });

  it.each([
    ['no recipient', { to: [] }],
    ['a recipient that is not an address', { to: ['not an address'] }],
    ['more than 20 recipients', { to: Array.from({ length: 21 }, (_u, index) => `u${String(index)}@example.com`) }],
    ['an empty subject', { subject: '' }],
    ['a body over 20,000 characters', { body: 'x'.repeat(20_001) }],
    ['an unknown field', { attachments: ['a'] }],
    ['a hidden character in the subject', { subject: 'Lease​now' }],
    ['a tag character in the body', { body: 'Hello\u{E0041}' }],
    ['a hidden recipient name', { cc: ['grace​@example.com'] }],
  ])('refuse %s', (_name, change) => {
    expect(DraftEmailSchema.safeParse({ ...DRAFT, ...change }).success).toBe(false);
  });

  it('refuse more variation selectors than a name needs, in the subject and body together', () => {
    const selectors = '\u{E0100}'.repeat(10);
    expect(DraftEmailSchema.safeParse({ ...DRAFT, subject: `山${selectors}`, body: `山${selectors}` }).success).toBe(
      false,
    );
  });

  it('require the draft id to update one', () => {
    expect(UpdateDraftSchema.safeParse(DRAFT).success).toBe(false);
  });

  it('accept a reply with no recipient named, and refuse a draft with neither a recipient nor a reply', () => {
    expect(DraftEmailSchema.safeParse({ subject: 'Lease', body: 'ok', in_reply_to: 'm1' }).success).toBe(true);
    expect(DraftEmailSchema.safeParse({ subject: 'Lease', body: 'ok', to: ['grace@example.com'] }).success).toBe(true);
    expect(DraftEmailSchema.safeParse({ subject: 'Lease', body: 'ok' }).success).toBe(false);
    expect(DraftEmailSchema.safeParse({ subject: 'Lease', body: 'ok', to: [] }).success).toBe(false);
  });
});
