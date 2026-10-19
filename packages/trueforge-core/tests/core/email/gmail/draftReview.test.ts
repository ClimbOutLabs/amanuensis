import { hashDraft, type ReviewableDraft } from '../../../../src/core/email/gmail/draftReview';

/** A recipient with no display name: the bare address. */
const bare = (address: string) => ({ name: '', address });

const DRAFT: ReviewableDraft = {
  to: [bare('grace@example.com')],
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
    ['cc', { cc: [bare('lin@example.com')] }],
    ['bcc', { bcc: [bare('lin@example.com')] }],
    ['threadId', { threadId: 't10' }],
    ['to', { to: [bare('mallory@example.com')] }],
    ['an added recipient', { to: [bare('grace@example.com'), bare('lin@example.com')] }],
    ['the name a recipient is shown with', { to: [{ name: 'Grace Lee', address: 'grace@example.com' }] }],
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
    expect(hashDraft({ ...DRAFT, to: [], cc: [bare('grace@example.com')] })).not.toBe(hashDraft(DRAFT));
  });
});
