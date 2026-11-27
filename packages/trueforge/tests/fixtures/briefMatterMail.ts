/**
 * A recorded Gmail mailbox for the morning brief matter-link suite. It answers the same Google
 * token and threads routes as the recorded mail fixture, with the Review Desk acknowledgment the
 * scenario needs. Three variants:
 *
 * - `linked`: the acknowledgment names Records Office request R-1842 in its body.
 * - `ambiguous`: the acknowledgment is real but names no request and no distinguishing detail.
 * - `none`: no acknowledgment ever arrived; the inbox holds only an unrelated parks notice.
 *
 * Every variant also holds that unrelated notice, so the brief always has something to leave out.
 * All names, addresses and references are invented for this fixture.
 */

export type BriefMatterMailScenario = 'linked' | 'ambiguous' | 'none';

interface FixtureMessage {
  id: string;
  from: string;
  subject: string;
  date: string;
  internalDate: string;
  body: string;
}

interface FixtureThread {
  id: string;
  messages: readonly FixtureMessage[];
}

const PARKS_THREAD: FixtureThread = {
  id: 'thread-parks-notice',
  messages: [
    {
      id: 'parks-1',
      from: 'City Parks <news@parks.example>',
      subject: 'November trail closures',
      date: 'Mon, 09 Nov 2026 07:00:00 +0000',
      internalDate: String(Date.parse('2026-11-09T07:00:00.000Z')),
      body: [
        'Hello,',
        '',
        'The ridge trail and the north footbridge are closed for repairs through the end of November. All other trails stay open.',
        '',
        'City Parks',
      ].join('\n'),
    },
  ],
};

const REVIEW_DESK_LINKED: FixtureThread = {
  id: 'thread-review-desk',
  messages: [
    {
      id: 'review-desk-1',
      from: 'Review Desk <noreply@review-desk.example>',
      subject: 'Submission received · C-771',
      date: 'Tue, 10 Nov 2026 08:15:00 +0000',
      internalDate: String(Date.parse('2026-11-10T08:15:00.000Z')),
      body: [
        'Hello,',
        '',
        'We received your complaint about the delay in issuing the certified copy under Records Office request R-1842.',
        '',
        'Your complaint reference is C-771. We will review how your request was handled and write to you again when the review is complete. This acknowledgment is about the complaint only. It does not change the status of the certified copy itself.',
        '',
        'Review Desk',
      ].join('\n'),
    },
  ],
};

const REVIEW_DESK_AMBIGUOUS: FixtureThread = {
  id: 'thread-review-desk',
  messages: [
    {
      id: 'review-desk-1',
      from: 'Review Desk <noreply@review-desk.example>',
      subject: 'Submission received · C-771',
      date: 'Tue, 10 Nov 2026 08:15:00 +0000',
      internalDate: String(Date.parse('2026-11-10T08:15:00.000Z')),
      body: [
        'Hello,',
        '',
        'We received your complaint about a delay in issuing a certified copy.',
        '',
        'Your complaint reference is C-771. We will review how your request was handled and write to you again when the review is complete. This acknowledgment is about the complaint only. It does not change the status of the certified copy itself.',
        '',
        'Review Desk',
      ].join('\n'),
    },
  ],
};

export function briefMatterThreads(scenario: BriefMatterMailScenario): readonly FixtureThread[] {
  if (scenario === 'linked') {
    return [REVIEW_DESK_LINKED, PARKS_THREAD];
  }
  if (scenario === 'ambiguous') {
    return [REVIEW_DESK_AMBIGUOUS, PARKS_THREAD];
  }
  return [PARKS_THREAD];
}

function encodeBase64Url(text: string): string {
  return Buffer.from(text, 'utf8').toString('base64url');
}

function gmailMessage(message: FixtureMessage, format: string) {
  const headers = [
    { name: 'From', value: message.from },
    { name: 'Subject', value: message.subject },
    { name: 'Date', value: message.date },
  ];
  const base = { id: message.id, threadId: '', internalDate: message.internalDate, labelIds: ['INBOX'] };
  if (format === 'metadata') {
    return { ...base, snippet: message.body.slice(0, 80), payload: { mimeType: 'text/plain', headers } };
  }
  return {
    ...base,
    snippet: message.body.slice(0, 80),
    payload: {
      mimeType: 'text/plain',
      headers,
      body: { size: Buffer.byteLength(message.body), data: encodeBase64Url(message.body) },
    },
  };
}

/** The text of every message the mailbox would serve, for fixture-level assertions. */
export function briefMatterMailText(scenario: BriefMatterMailScenario): string {
  return briefMatterThreads(scenario)
    .flatMap(thread => thread.messages.map(message => `${message.subject}\n${message.body}`))
    .join('\n');
}

/**
 * Serves the scenario mailbox in place of Gmail until `restore` is called. Mirrors the recorded
 * mail fixture: the token route and the threads list and get routes, nothing else.
 */
export function installBriefMatterMail(scenario: BriefMatterMailScenario): { restore(): void } {
  const threads = briefMatterThreads(scenario);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      return Response.json({ access_token: 'recorded-access-token', expires_in: 3600, token_type: 'Bearer' });
    }
    if (url.startsWith('https://gmail.googleapis.com/gmail/v1/users/me/threads')) {
      const parsed = new URL(url);
      const threadId = parsed.pathname.split('/').at(-1);
      if (threadId !== undefined && threadId !== 'threads' && parsed.pathname.includes('/threads/')) {
        const thread = threads.find(candidate => candidate.id === threadId);
        if (thread === undefined) {
          return Response.json({ error: { code: 404, message: 'not found' } }, { status: 404 });
        }
        const format = parsed.searchParams.get('format') ?? 'full';
        return Response.json({
          id: thread.id,
          messages: thread.messages.map(message => ({ ...gmailMessage(message, format), threadId: thread.id })),
        });
      }
      return Response.json({
        threads: threads.map(thread => ({
          id: thread.id,
          snippet: thread.messages[0]?.body.slice(0, 80) ?? '',
          historyId: '99',
        })),
        resultSizeEstimate: threads.length,
      });
    }
    return originalFetch(input, init);
  };
  return {
    restore() {
      globalThis.fetch = originalFetch;
    },
  };
}
