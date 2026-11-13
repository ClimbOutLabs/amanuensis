import { LATEST_ANSWER_AT_METADATA_KEY } from '@truefoundry/trueforge-core/agent-session/schemas/sessionMetadataKeys';
import type { ChatAnswerMark, ChatAnswerMarksApi } from '@truefoundry/trueforge-ui';

import { apiPath } from './publicPath';

const SESSIONS_URL = '/api/v1/sessions';
// The server caps one page of chats at 25. Answers are recent activity, and the list is
// newest first, so a few pages cover every chat that could plausibly carry a fresh dot;
// the provider also asks again every 30 seconds.
const PAGE_SIZE = 25;
const MAX_PAGES = 4;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseMark(value: unknown): ChatAnswerMark | null {
  if (!isRecord(value) || typeof value.id !== 'string' || !isRecord(value.metadata)) {
    return null;
  }
  const answeredAt = value.metadata[LATEST_ANSWER_AT_METADATA_KEY];
  return typeof answeredAt === 'string' ? { sessionId: value.id, answeredAt } : null;
}

async function readBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    throw new Error(`That did not work (error ${String(response.status)}). Try again in a moment.`);
  }
  return body;
}

/** Backs `ChatAnswerMarksProvider`: the latest answer time of each of the person's chats. */
export function createChatAnswerMarksApi(fetcher: typeof fetch): ChatAnswerMarksApi {
  return {
    async listAnswerMarks() {
      const marks: ChatAnswerMark[] = [];
      const seenPageTokens = new Set<string>();
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const query = new URLSearchParams({ limit: String(PAGE_SIZE), order: 'desc' });
        if (pageToken !== undefined) {
          query.set('page_token', pageToken);
        }
        const body = await readBody(await fetcher(`${apiPath(SESSIONS_URL)}?${query.toString()}`));
        const rows: unknown = isRecord(body) ? body.data : undefined;
        if (Array.isArray(rows)) {
          for (const row of rows) {
            const mark = parseMark(row);
            if (mark !== null) {
              marks.push(mark);
            }
          }
        }
        const pagination: unknown = isRecord(body) ? body.pagination : undefined;
        const next =
          isRecord(pagination) && typeof pagination.next_page_token === 'string'
            ? pagination.next_page_token
            : undefined;
        if (next === undefined || seenPageTokens.has(next)) {
          break;
        }
        seenPageTokens.add(next);
        pageToken = next;
      }
      return marks;
    },
  };
}
