import type { ISessionStore, PersistedTurnEvent } from '@truefoundry/trueforge-core/agent-session';
import {
  isPageReaderTool,
  isSearchResultTool,
  pageImageUrls,
  searchResultUrls,
} from '@truefoundry/trueforge-core/core';

import { replyImageUrls } from '../chatImages/imageLinks';

/** Events read per page of the session feed; the feed is newest first, so recent evidence is found early. */
const PAGE_SIZE = 200;
/** Pages walked before giving up, so one picture check never scans a whole long chat. */
const MAX_PAGES = 10;

/** Comparable form of a link: the parsed URL, so encoding differences between turns do not matter. */
export function normalizeSeenLink(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : undefined;
  } catch {
    return undefined;
  }
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

/** A message part carrying text, as stored. The null check comes first: a null part would pass a type check but fail a field read. */
function isTextPart(part: unknown): part is { text: string } {
  return part !== null && typeof part === 'object' && 'text' in part && typeof part.text === 'string';
}

/** Text of one assistant message, from a string body or its text parts. */
function assistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (!Array.isArray(content)) {
    return '';
  }
  const texts: string[] = [];
  for (const part of content) {
    if (isTextPart(part)) {
      texts.push(part.text);
    }
  }
  return texts.join('\n');
}

/**
 * The text a stored tool response carries: what the model saw. A versioned result's stored
 * content is the envelope, unwrapped by the caller. A screened result keeps the raw provider text
 * in storage while the model saw something else, so it never counts: counting it would let a
 * picture from hidden, untrusted content into a page.
 */
function toolResponseText(event: PersistedTurnEvent): string | undefined {
  if (event.type === 'tool.response.v2') {
    if (event.disposition !== 'executed_ok' && event.disposition !== 'executed_nonzero') {
      return undefined;
    }
    if (event.screen !== undefined) {
      return undefined;
    }
    return event.content;
  }
  if (event.type === 'tool.response') {
    return typeof event.content === 'string' ? event.content : assistantText(event.content);
  }
  return undefined;
}

/**
 * Whether one picture link was seen in this chat: a search result's own link or a picture it listed,
 * a picture on a page the chat opened, or a picture the reply itself showed. Nothing here comes from the client: every
 * candidate is read back from the chat's stored turn events, and a tool result only counts when
 * the call that produced it is named as a search or page reader by the model's own message, ran
 * to completion, and was not screened (a screened result's stored text is not what the model saw).
 * A picture whose evidence sits past the newest ten pages of the feed is not seen, so it stays
 * blank rather than being fetched on a guess.
 */
export async function isChatSeenLink(input: {
  sessionStore: Pick<ISessionStore, 'listSessionEvents'>;
  session_id: string;
  url: string;
}): Promise<boolean> {
  const wanted = normalizeSeenLink(input.url);
  if (wanted === undefined) {
    return false;
  }
  const seen = new Set<string>();
  const add = (url: string): void => {
    const normalized = normalizeSeenLink(url);
    if (normalized !== undefined) {
      seen.add(normalized);
    }
  };
  const callNames = new Map<string, string>();
  const toolResponses: PersistedTurnEvent[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const listed = await input.sessionStore.listSessionEvents({
      session_id: input.session_id,
      limit: PAGE_SIZE,
      page_token: pageToken,
      last_turn_id: undefined,
      types: ['model.message', 'tool.response.v2', 'tool.response'],
      after_event_id: undefined,
    });
    for (const item of listed.data) {
      const event = item.event;
      if (event.type === 'model.message') {
        for (const url of replyImageUrls(assistantText(event.content))) {
          add(url);
        }
        if (Array.isArray(event.tool_calls)) {
          for (const call of event.tool_calls) {
            if (
              typeof call === 'object' &&
              'id' in call &&
              typeof call.id === 'string' &&
              'tool_info' in call &&
              typeof call.tool_info === 'object' &&
              'name' in call.tool_info &&
              typeof call.tool_info.name === 'string'
            ) {
              callNames.set(call.id, call.tool_info.name);
            }
          }
        }
      } else {
        toolResponses.push(event);
      }
    }
    if (seen.has(wanted)) {
      return true;
    }
    pageToken = listed.pagination.next_page_token;
    if (pageToken === undefined) {
      break;
    }
  }
  for (const event of toolResponses) {
    if (event.type !== 'tool.response' && event.type !== 'tool.response.v2') {
      continue;
    }
    const name = callNames.get(event.tool_call_id);
    if (name === undefined) {
      continue;
    }
    const text = toolResponseText(event);
    if (text === undefined) {
      continue;
    }
    const payload = toolResultPayload(text);
    if (isSearchResultTool(name)) {
      const found = searchResultUrls(payload);
      for (const url of [...found.links, ...found.pictures]) {
        add(url);
      }
    } else if (isPageReaderTool(name)) {
      // A page result is text: the unwrapped string when the stored result is JSON, or the raw
      // text when it was stored unquoted. Anything else carries no page to read pictures from.
      const pageText = typeof payload === 'string' ? payload : payload === undefined ? text : undefined;
      if (pageText !== undefined) {
        for (const url of pageImageUrls(pageText)) {
          add(url);
        }
      }
    }
    if (seen.has(wanted)) {
      return true;
    }
  }
  return seen.has(wanted);
}
