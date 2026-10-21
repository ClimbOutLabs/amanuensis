/**
 * One invented inbox thread for the scheduled brief, answered from these recordings: Google's token
 * endpoint and the Gmail thread routes. The snippet names the address the grounded finder fixtures
 * geocode, so a map of that address is one the mail actually carries. No real person or account appears.
 */
import { HARBOUR_ADDRESS } from './groundedFinderFixtures';

export const MAIL_SENDER_NAME = 'Marta Lopes';
const THREAD_ID = 'thread-brief-1';

const threadList = { threads: [{ id: THREAD_ID }], resultSizeEstimate: 1 };

const thread = {
  id: THREAD_ID,
  messages: [
    {
      id: 'message-brief-1',
      threadId: THREAD_ID,
      labelIds: ['INBOX'],
      snippet: `Your visit is at ${HARBOUR_ADDRESS}. See you on Monday.`,
      internalDate: '1760860800000',
      payload: {
        mimeType: 'text/plain',
        headers: [
          { name: 'From', value: `${MAIL_SENDER_NAME} <marta.lopes@clinic.example>` },
          { name: 'To', value: 'owner@example.com' },
          { name: 'Subject', value: 'Your visit' },
          { name: 'Date', value: 'Sun, 19 Oct 2026 09:00:00 +0000' },
        ],
      },
    },
  ],
};

/**
 * Answers Google's token refresh and the Gmail inbox routes from the recordings above, and lets every
 * other request reach whatever fetch was installed before it.
 */
export function installRecordedMail(): { calls: string[]; restore: () => void } {
  const previous = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === 'gmail.googleapis.com') {
      calls.push(url.pathname);
    }
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      return Promise.resolve(
        Response.json({ access_token: 'recorded-access', expires_in: 3600, token_type: 'Bearer' }),
      );
    }
    if (url.hostname === 'gmail.googleapis.com') {
      if (url.pathname === '/gmail/v1/users/me/threads') {
        return Promise.resolve(Response.json(threadList));
      }
      if (url.pathname === `/gmail/v1/users/me/threads/${THREAD_ID}`) {
        return Promise.resolve(Response.json(thread));
      }
      return Promise.resolve(new Response('', { status: 404 }));
    }
    return previous(input, init);
  };
  return {
    calls,
    restore: () => {
      globalThis.fetch = previous;
    },
  };
}
