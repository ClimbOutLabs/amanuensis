import type { ISessionStore, PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';

/** What a turn's stored events say about the images it may show. Nothing here comes from the client. */
export interface TurnImageFacts {
  /** Data URIs of the turn message attachments, in order. */
  uploads: string[];
  /** Text of every assistant message in the turn. */
  replyTexts: string[];
  /** Results of searches the designated provider ran without asking. */
  silentSearchResults: string[];
  /** HTML body of each email the turn read, by tool call id. */
  emailBodies: Map<string, string>;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50;
const EMAIL_READ_TOOL = 'read_email';

function assistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const parts: unknown[] = content;
  const texts: string[] = [];
  for (const part of parts) {
    if (typeof part === 'object' && part !== null && 'text' in part && typeof part.text === 'string') {
      texts.push(part.text);
    }
  }
  return texts.join('\n');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** The tool's own result inside a stored tool response, unwrapping the versioned envelope. */
function toolResultPayload(content: string): unknown {
  const parsed = parseJson(content);
  if (typeof parsed !== 'object' || parsed === null || !('schema_version' in parsed) || !('result' in parsed)) {
    return parsed;
  }
  const result = parsed.result;
  return typeof result === 'string' ? (parseJson(result) ?? result) : result;
}

function emailHtml(payload: unknown): string | undefined {
  if (
    typeof payload === 'object' &&
    payload !== null &&
    'bodyHtml' in payload &&
    typeof payload.bodyHtml === 'string'
  ) {
    return payload.bodyHtml;
  }
  return undefined;
}

export async function readTurnImageFacts(input: {
  sessionStore: Pick<ISessionStore, 'listTurnEvents'>;
  session_id: string;
  turn_id: string;
}): Promise<TurnImageFacts> {
  const events: PersistedTurnEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listed = await input.sessionStore.listTurnEvents({
      session_id: input.session_id,
      turn_id: input.turn_id,
      limit: PAGE_SIZE,
      page_token: pageToken,
      order: 'asc',
    });
    events.push(...listed.data);
    pageToken = listed.pagination.next_page_token;
    if (pageToken === undefined) {
      break;
    }
  }

  const facts: TurnImageFacts = { uploads: [], replyTexts: [], silentSearchResults: [], emailBodies: new Map() };
  const silentSearchCalls = new Set<string>();
  const emailCalls = new Set<string>();
  for (const event of events) {
    if (event.type === 'turn.created') {
      for (const item of event.input ?? []) {
        if (item.type === 'user.message' && typeof item.content !== 'string') {
          for (const part of item.content) {
            if (part.type === 'file') {
              facts.uploads.push(part.data);
            }
          }
        }
      }
    } else if (event.type === 'model.message') {
      facts.replyTexts.push(assistantText(event.content));
      for (const call of event.tool_calls ?? []) {
        if (call.tool_info.type !== 'mcp') {
          continue;
        }
        if (call.tool_info.silent_search_query !== undefined) {
          silentSearchCalls.add(call.id);
        }
        if (call.tool_info.name === EMAIL_READ_TOOL) {
          emailCalls.add(call.id);
        }
      }
    } else if (event.type === 'tool.response.v2' || event.type === 'tool.response') {
      if (silentSearchCalls.has(event.tool_call_id)) {
        facts.silentSearchResults.push(event.content);
      }
      if (emailCalls.has(event.tool_call_id)) {
        const html = emailHtml(toolResultPayload(event.content));
        if (html !== undefined) {
          facts.emailBodies.set(event.tool_call_id, html);
        }
      }
    }
  }
  return facts;
}
