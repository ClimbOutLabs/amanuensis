import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { EXTRACT_DOCUMENT_TEXT_TOOL_NAME } from '../../documents/toolContract';
import { CALENDAR_READ_TOOL_NAMES } from '../calendar/toolContract';
import { htmlImages } from '../email/gmail/htmlText';
import { isGmailReadToolName } from '../email/gmail/toolContract';
import { isMailReadToolName } from '../email/mailConnector/toolContract';
import { DEFAULT_ASSISTANT_NAME } from '../personas/assistantName';
import { REPLACE_TASK_CHECKLIST_TOOL_NAME, TASK_STATE_TOOL_NAME } from '../runtime/taskState';
import { isPageReaderTool, isSearchResultTool } from '../search/fetchedPages';
import { BROWSER_OPEN_SILENT_REASON, BROWSER_OPEN_TOOL_NAME, isBrowserToolName } from './browserToolNames';
import {
  emptyChatProvenance,
  namesUrl,
  recordEmailText,
  recordPageImageUrls,
  recordSearchResults,
  recordUntrustedText,
  type ChatProvenance,
  type ReadSource,
} from './provenance';

/**
 * Host state for one turn's outbound lookups: the count that trips the loop breaker, the text already sent, and where
 * each link and address the model may name came from. It lives in host memory for one turn and never reaches the model.
 */

/** Silent lookups one turn may run; the next is stopped with a plain line, never a card. */
export const SILENT_SEARCH_LIMIT = 20;

/** Reason code for a search or page read the designated provider ran without asking. */
export const SEARCH_SILENT_REASON = 'mcp_search_provider';

/**
 * Whether a call that ran without asking counts toward the turn's silent lookup limit: a search or page read of the
 * designated provider, or a page the browser opened.
 */
export function countsAsSilentLookup(input: { tool_name: string; reason: string }): boolean {
  return (
    isSilentSearchReason(input.reason) ||
    (baseToolName(input.tool_name) === BROWSER_OPEN_TOOL_NAME && input.reason === BROWSER_OPEN_SILENT_REASON)
  );
}

/** Whether a decision reason is a search that ran without asking. */
export function isSilentSearchReason(reason: string): boolean {
  return reason === SEARCH_SILENT_REASON;
}

/** Reason code for a lookup held because read content chose its link and the link carries more than it gave. */
export const SEARCH_STEERED_REASON = 'mcp_search_steered';

/** Reason code for a lookup held because it carries a private detail of the person's, in a chat that read other content. */
export const SEARCH_PRIVATE_DETAIL_REASON = 'mcp_search_private_detail';

/** Reason codes for a designated-provider call that stops for approval, and why. */
export const SEARCH_ASK_REASONS = [
  'mcp_search_setting_ask',
  'mcp_search_guard',
  SEARCH_STEERED_REASON,
  SEARCH_PRIVATE_DETAIL_REASON,
] as const;
export type SearchAskReason = (typeof SEARCH_ASK_REASONS)[number];

export function isSearchAskReason(reason: string): boolean {
  return SEARCH_ASK_REASONS.some(known => known === reason);
}

/** What the host lets the designated search provider's connector do silently, resolved for one turn. */
export interface SearchProviderGrant {
  /** Tools that run without asking even when the server does not declare them read-only. */
  tools: readonly string[];
  /** Top-level argument names that are provider plumbing, not user text. */
  plumbing_fields: readonly string[];
}

export interface WebSearchTurnState {
  /** Lookups that ran without asking this turn. */
  silentSearches: number;
  /** Tail of the text those searches sent, so a secret split across two searches is seen whole. */
  sentText: string;
  /** Where the links and addresses this chat has seen came from. */
  provenance: ChatProvenance;
  /** The name the person calls the assistant, for the sentences on its cards. */
  assistantName: string;
  /** Tail of the one-at-a-time chain that classifies and counts the turn's search calls. */
  admission: Promise<void>;
}

export function createWebSearchTurnState(): WebSearchTurnState {
  return {
    silentSearches: 0,
    sentText: '',
    provenance: emptyChatProvenance(),
    assistantName: DEFAULT_ASSISTANT_NAME,
    admission: Promise.resolve(),
  };
}

/**
 * Runs the work after every earlier call of this turn finished its own, whether it succeeded or not.
 * The silent count and the text already sent are then read and updated by one call at a time, so
 * the parallel calls of one batch cannot all pass on the same count or split a secret between them.
 */
export function runOneAtATime<T>(input: { state: WebSearchTurnState; work: () => Promise<T> }): Promise<T> {
  const run = input.state.admission.then(input.work);
  input.state.admission = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Text a result carries: its text blocks and its structured content. An error result carries none. */
export function resultTexts(result: CallToolResult): string[] {
  if (result.isError === true) {
    return [];
  }
  const texts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (block.type === 'text') {
        texts.push(block.text);
      }
    }
  }
  if (result.structuredContent !== undefined) {
    texts.push(JSON.stringify(result.structuredContent));
  }
  return texts;
}

/** A markdown picture: `![alt](url)` with an optional title after the link. */
const MARKDOWN_IMAGE = /!\[([^\]]*)\]\(\s*<?([^)\s>]+)>?(?:\s+(?:"[^"]*"|'[^']*'))?\s*\)/g;

/** Cap on image links taken from one page read, so a gallery page cannot grow host memory without bound. */
const MAX_PAGE_IMAGE_URLS = 200;

/** Most pictures the model is shown from one page read; the list is a hint, not the page's whole gallery. */
const PAGE_PICTURES_SHOWN_MAX = 8;

/** Longest description shown beside a picture link; a page's alt text can run to a paragraph. */
const PICTURE_ALT_MAX_CHARS = 120;

/** The name of the host-added picture list under a page read; the refusal for a made up picture names it. */
export const PAGE_PICTURES_LABEL = 'Pictures on this page';

const PAGE_PICTURES_HEADING = `${PAGE_PICTURES_LABEL}:`;

/** One picture a page shows: its link and, when the page gives one, the words that describe it. */
export interface PagePicture {
  url: string;
  alt: string | undefined;
}

/**
 * The pictures a page read returned, from markdown pictures and raw `<img>` tags, once each and in
 * order. Tracking pixels are left out by the HTML reader, and a data: picture is not a link out, so
 * only web picture links are returned. This is the one reader of a page's pictures: the provenance
 * record and the list the model is shown both come from it.
 */
export function pagePictures(text: string): PagePicture[] {
  const pictures: PagePicture[] = [];
  const add = ({ url: raw, alt }: PagePicture): void => {
    const url = raw.trim();
    if (/^https?:\/\//i.test(url) && url.length <= 2048 && !pictures.some(picture => picture.url === url)) {
      pictures.push({ url, alt });
    }
  };
  for (const match of text.matchAll(MARKDOWN_IMAGE)) {
    if (match[2] !== undefined) {
      const alt = match[1]?.trim() ?? '';
      add({ url: match[2], alt: alt === '' ? undefined : alt });
    }
  }
  for (const image of htmlImages({ source: text, max: MAX_PAGE_IMAGE_URLS })) {
    add(image);
  }
  return pictures;
}

/** The picture links a page read returned, as `pagePictures` finds them. */
export function pageImageUrls(text: string): string[] {
  return pagePictures(text).map(picture => picture.url);
}

/**
 * The short list of a page's pictures the model is shown under a page read, or undefined when the
 * tool is not a page reader or the page has no https picture. It is a host-added list, kept apart
 * from the page text so the page's own words stay framed as untrusted data. A space only accepts an
 * https picture, so an http one is left out rather than offered and then refused.
 */
export function pagePicturesNote(input: { tool_name: string; text: string }): string | undefined {
  if (!isPageReaderTool(baseToolName(input.tool_name))) {
    return undefined;
  }
  const shown = pagePictures(input.text)
    .filter(picture => /^https:\/\//i.test(picture.url))
    .slice(0, PAGE_PICTURES_SHOWN_MAX);
  if (shown.length === 0) {
    return undefined;
  }
  const lines = shown.map(picture => {
    const alt = picture.alt?.replace(/\s+/g, ' ').trim().slice(0, PICTURE_ALT_MAX_CHARS) ?? '';
    return alt === '' ? `- ${picture.url}` : `- ${picture.url} (${alt})`;
  });
  return [PAGE_PICTURES_HEADING, ...lines].join('\n');
}

/** A tool's own name, without the server prefix a connector adds. */
function baseToolName(toolName: string): string {
  const separator = toolName.lastIndexOf('__');
  return separator < 0 ? toolName : toolName.slice(separator + 2);
}

/**
 * Host tools whose results never contain stored or outside text: the finding recorder answers with a fixed
 * line, and the task checklist writer answers with the checklist the model just wrote. Spaces, schedules and
 * reminders are not here: their results echo stored bodies, names and tasks that may hold page text saved in
 * an earlier turn. This is the only list; any tool not on it, including every connector, shell tool and
 * unknown name, counts as bringing in outside content.
 */
const HOST_ONLY_TOOL_NAMES: ReadonlySet<string> = new Set([TASK_STATE_TOOL_NAME, REPLACE_TASK_CHECKLIST_TOOL_NAME]);

/** Whether a tool's result may hold text written outside the chat: true for every tool not known to be host-only. */
export function toolReturnsOutsideContent(toolName: string): boolean {
  return !HOST_ONLY_TOOL_NAMES.has(baseToolName(toolName));
}

/** The kind of content a tool's result is, so a card or a memory note can say where something was read. */
export function readSourceOf(toolName: string): ReadSource {
  const baseName = baseToolName(toolName);
  if (isSearchResultTool(baseName) || isPageReaderTool(baseName) || isBrowserToolName(baseName)) {
    return 'page';
  }
  if (isGmailReadToolName(baseName) || isMailReadToolName(baseName)) {
    return 'email';
  }
  if (CALENDAR_READ_TOOL_NAMES.some(name => name === baseName)) {
    return 'event';
  }
  return baseName === EXTRACT_DOCUMENT_TEXT_TOOL_NAME ? 'file' : 'tool_result';
}

/**
 * Records where the links and addresses of one tool result came from, before the model reads it. A search's results
 * are the person's to open; every other text is data, the headers of their own mail and their events' guests too.
 * `argument_values` are the call's own strings, so a search that names a link counts as opening a page.
 */
export function recordToolResultProvenance(input: {
  state: WebSearchTurnState;
  tool_name: string;
  argument_values: readonly string[];
  texts: readonly string[];
}): void {
  const { provenance } = input.state;
  const baseName = baseToolName(input.tool_name);
  const searchTool = isSearchResultTool(baseName);
  if (searchTool && !namesUrl(input.argument_values)) {
    recordSearchResults({ provenance, texts: input.texts });
    return;
  }
  const source = readSourceOf(baseName);
  const pageReader = isPageReaderTool(baseName);
  for (const text of input.texts) {
    if (source === 'email') {
      recordEmailText({ provenance, text });
    } else {
      recordUntrustedText({ provenance, text, source });
    }
    if (pageReader) {
      // A page the chat opened is the exception to that rule for its pictures: opening the page
      // saw them, so a space may use a picture file the search result never named. Only the
      // page's own pictures count, and the page's text itself stays untrusted data.
      recordPageImageUrls({ provenance, urls: pageImageUrls(text) });
    }
  }
}
