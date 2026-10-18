import type { ISessionStore, PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import { isPrivateReadToolName } from '@truefoundry/trueforge-core/core/capabilities/builtins/PrivateDataRead';
import { CHAT_IMAGE_MAX_PER_EMAIL } from '@truefoundry/trueforge-core/core/chatImages';
import { htmlImageLinks } from '@truefoundry/trueforge-core/core/email/gmail/htmlText';
import { READ_EMAIL_TOOL_NAME } from '@truefoundry/trueforge-core/core/email/gmail/toolContract';

/** What a turn's stored events say about the images it may show. Nothing here comes from the client. */
export interface TurnImageFacts {
  /** Data URIs of the turn message attachments, in order. */
  uploads: string[];
  /** Text of every assistant message in the turn. */
  replyTexts: string[];
  /** Results of searches the designated provider ran without asking. */
  silentSearchResults: string[];
  /** Web image links of each email the turn read, by tool call id. */
  emailImageLinks: Map<string, string[]>;
  /** The turn called a tool that reads private data (mail), so web images ask like searches do. */
  readPrivateData: boolean;
}

const PAGE_SIZE = 200;
const MAX_PAGES = 50;

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

/**
 * The image links of an email read result: the Gmail tools list them as `linked_images`; the older Gmail
 * connector returns the HTML body, which is read here instead.
 */
function emailImageLinks(payload: unknown): string[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }
  if ('linked_images' in payload && Array.isArray(payload.linked_images)) {
    const values: unknown[] = payload.linked_images;
    return values
      .filter((value): value is string => typeof value === 'string' && /^https?:\/\//i.test(value))
      .slice(0, CHAT_IMAGE_MAX_PER_EMAIL);
  }
  if ('bodyHtml' in payload && typeof payload.bodyHtml === 'string') {
    return htmlImageLinks({ source: payload.bodyHtml, max: CHAT_IMAGE_MAX_PER_EMAIL });
  }
  return [];
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

  const facts: TurnImageFacts = {
    uploads: [],
    replyTexts: [],
    silentSearchResults: [],
    emailImageLinks: new Map(),
    readPrivateData: false,
  };
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
        const name = call.tool_info.name;
        if (call.tool_info.type === 'mcp' && call.tool_info.silent_search_query !== undefined) {
          silentSearchCalls.add(call.id);
        }
        if (name === READ_EMAIL_TOOL_NAME) {
          emailCalls.add(call.id);
        }
        if (isPrivateReadToolName(name)) {
          facts.readPrivateData = true;
        }
      }
    } else if (event.type === 'tool.response.v2' || event.type === 'tool.response') {
      if (silentSearchCalls.has(event.tool_call_id)) {
        facts.silentSearchResults.push(event.content);
      }
      if (emailCalls.has(event.tool_call_id)) {
        const links = emailImageLinks(toolResultPayload(event.content));
        if (links.length > 0) {
          facts.emailImageLinks.set(event.tool_call_id, links);
        }
      }
    }
  }
  return facts;
}
