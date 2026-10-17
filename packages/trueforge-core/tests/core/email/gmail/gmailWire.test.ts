import {
  AttachmentBodySchema,
  DraftListSchema,
  DraftSchema,
  GmailMessageSchema,
  GmailThreadSchema,
  ThreadListSchema,
} from '../../../../src/core/email/gmail/gmailWire';

describe('Gmail wire shapes', () => {
  it('reads a message with only the fields Gmail always sends', () => {
    expect(GmailMessageSchema.parse({ id: 'm1', threadId: 't1' })).toEqual({ id: 'm1', threadId: 't1' });
  });

  it('reads nested parts to any depth, with their headers, bodies and attachment ids', () => {
    const part = GmailMessageSchema.parse({
      id: 'm1',
      threadId: 't1',
      payload: {
        mimeType: 'multipart/mixed',
        parts: [
          {
            mimeType: 'multipart/alternative',
            parts: [
              {
                mimeType: 'text/plain',
                headers: [{ name: 'Content-Type', value: 'text/plain' }],
                body: { data: 'YQ' },
              },
            ],
          },
          { mimeType: 'application/pdf', filename: 'lease.pdf', body: { attachmentId: 'att-1', size: 12 } },
        ],
      },
    }).payload;
    expect(part?.parts?.[0]?.parts?.[0]?.body?.data).toBe('YQ');
    expect(part?.parts?.[1]?.body?.attachmentId).toBe('att-1');
  });

  it('drops fields it does not read', () => {
    expect(GmailMessageSchema.parse({ id: 'm1', threadId: 't1', historyId: '9', sizeEstimate: 5 })).toEqual({
      id: 'm1',
      threadId: 't1',
    });
  });

  it.each([
    ['a message with no id', GmailMessageSchema, { threadId: 't1' }],
    [
      'a header with no value',
      GmailMessageSchema,
      { id: 'm1', threadId: 't1', payload: { headers: [{ name: 'From' }] } },
    ],
    ['a thread whose messages are not a list', GmailThreadSchema, { id: 't1', messages: 'm1' }],
    ['a draft with no id', DraftSchema, { message: { id: 'm1', threadId: 't1' } }],
    ['a label that is not text', GmailMessageSchema, { id: 'm1', threadId: 't1', labelIds: [1] }],
  ])('refuses %s', (_name, schema, value) => {
    expect(schema.safeParse(value).success).toBe(false);
  });

  it('reads lists that Gmail leaves empty by omitting the field', () => {
    expect(ThreadListSchema.parse({})).toEqual({});
    expect(DraftListSchema.parse({})).toEqual({});
    expect(GmailThreadSchema.parse({ id: 't1' })).toEqual({ id: 't1' });
    expect(AttachmentBodySchema.parse({})).toEqual({});
  });

  it('reads a draft with its message and a list with a page token', () => {
    expect(DraftSchema.parse({ id: 'd1', message: { id: 'm1', threadId: 't1' } }).message?.id).toBe('m1');
    expect(DraftListSchema.parse({ drafts: [{ id: 'd1' }], nextPageToken: 'n' }).nextPageToken).toBe('n');
    expect(ThreadListSchema.parse({ threads: [{ id: 't1' }], resultSizeEstimate: 3 }).resultSizeEstimate).toBe(3);
  });
});
