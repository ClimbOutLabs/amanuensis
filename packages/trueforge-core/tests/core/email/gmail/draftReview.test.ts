import { hashDraft, type ReviewableDraft } from '../../../../src/core/email/gmail/draftReview';

const DRAFT: ReviewableDraft = {
  to: ['grace@example.com'],
  cc: [],
  bcc: [],
  subject: 'Lease',
  body: 'Thursday works.',
  threadId: 't9',
  inReplyTo: '',
  references: '',
  fromName: '',
};

describe('hashDraft', () => {
  const changes: [string, Partial<ReviewableDraft>][] = [
    ['subject', { subject: 'Keys' }],
    ['cc', { cc: ['lin@example.com'] }],
    ['bcc', { bcc: ['lin@example.com'] }],
    ['threadId', { threadId: 't10' }],
    ['to', { to: ['mallory@example.com'] }],
    ['an added recipient', { to: ['grace@example.com', 'lin@example.com'] }],
    ['body', { body: 'Thursday works. Also send the keys.' }],
    ['inReplyTo', { inReplyTo: '<x@mail.example.com>' }],
    ['references', { references: '<x@mail.example.com>' }],
    ['the name it is sent under', { fromName: 'Ada Lovelace' }],
  ];

  it('is stable for the same draft', () => {
    expect(hashDraft({ ...DRAFT })).toBe(hashDraft(DRAFT));
  });

  it.each(changes)('changes when the %s changes', (_name, change) => {
    expect(hashDraft({ ...DRAFT, ...change })).not.toBe(hashDraft(DRAFT));
  });

  it('tells a recipient moved from to into cc', () => {
    expect(hashDraft({ ...DRAFT, to: [], cc: ['grace@example.com'] })).not.toBe(hashDraft(DRAFT));
  });
});
