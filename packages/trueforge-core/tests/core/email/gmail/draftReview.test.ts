import { DraftReviewLedger, hashDraft, type ReviewableDraft } from '../../../../src/core/email/gmail/draftReview';

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

const ADA = { tenant_id: 't1', created_by: 'ada', draft_id: 'd1' };

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

describe('DraftReviewLedger', () => {
  it('hands back the reviewed hash once', () => {
    const ledger = new DraftReviewLedger();
    ledger.record({ ...ADA, hash: 'h1' });
    expect(ledger.take(ADA)).toBe('h1');
    expect(ledger.take(ADA)).toBeUndefined();
  });

  it('keeps the first review: a later review of an edited draft does not replace it', () => {
    const ledger = new DraftReviewLedger();
    ledger.record({ ...ADA, hash: 'first' });
    ledger.record({ ...ADA, hash: 'edited' });
    expect(ledger.take(ADA)).toBe('first');
  });

  it('lets an expired review be replaced, and sweeps every expired entry when the ledger is used', () => {
    let now = 1_000_000;
    const ledger = new DraftReviewLedger(() => now);
    ledger.record({ ...ADA, hash: 'old' });
    ledger.record({ ...ADA, draft_id: 'd2', hash: 'other-old' });
    now += 31 * 60 * 1000;
    ledger.record({ ...ADA, hash: 'new' });
    expect(ledger.take(ADA)).toBe('new');
    expect(ledger.take({ ...ADA, draft_id: 'd2' })).toBeUndefined();
  });

  it('forgets a review after thirty minutes', () => {
    let now = 1_000_000;
    const ledger = new DraftReviewLedger(() => now);
    ledger.record({ ...ADA, hash: 'h1' });
    now += 29 * 60 * 1000;
    expect(ledger.take({ ...ADA })).toBe('h1');
    ledger.record({ ...ADA, hash: 'h2' });
    now += 31 * 60 * 1000;
    expect(ledger.take(ADA)).toBeUndefined();
  });

  it('accepts a new review once the old one has expired', () => {
    let now = 1_000_000;
    const ledger = new DraftReviewLedger(() => now);
    ledger.record({ ...ADA, hash: 'old' });
    now += 31 * 60 * 1000;
    ledger.record({ ...ADA, hash: 'new' });
    expect(ledger.take(ADA)).toBe('new');
  });

  it('is kept per user: another user, tenant or draft shares nothing', () => {
    const ledger = new DraftReviewLedger();
    ledger.record({ ...ADA, hash: 'ada-hash' });
    expect(ledger.take({ ...ADA, created_by: 'grace' })).toBeUndefined();
    expect(ledger.take({ ...ADA, tenant_id: 't2' })).toBeUndefined();
    expect(ledger.take({ ...ADA, draft_id: 'd2' })).toBeUndefined();
    expect(ledger.take(ADA)).toBe('ada-hash');
  });

  it("does not let one user spoil another user's review of a draft with the same id", () => {
    const ledger = new DraftReviewLedger();
    ledger.record({ ...ADA, created_by: 'grace', hash: 'grace-hash' });
    ledger.record({ ...ADA, hash: 'ada-hash' });
    expect(ledger.take(ADA)).toBe('ada-hash');
    expect(ledger.take({ ...ADA, created_by: 'grace' })).toBe('grace-hash');
  });

  it('forgets a review when the draft is changed through Aman', () => {
    const ledger = new DraftReviewLedger();
    ledger.record({ ...ADA, hash: 'h1' });
    ledger.forget(ADA);
    expect(ledger.take(ADA)).toBeUndefined();
  });
});
