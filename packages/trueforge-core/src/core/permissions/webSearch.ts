import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { DEFAULT_ASSISTANT_NAME } from '../personas/assistantName';
import { isSearchResultTool } from '../search/fetchedPages';
import { isPrivateReadToolName } from './privateReadTools';
import {
  emptyChatProvenance,
  namesUrl,
  recordOwnStoreResult,
  recordSearchResults,
  recordUntrustedText,
  type ChatProvenance,
} from './provenance';

/**
 * Host state for one turn's outbound lookups: the count that trips the loop breaker, the text already sent, and where
 * each link and address the model may name came from. It lives in host memory for one turn and never reaches the model.
 */

/** Silent searches one turn may run before the next one asks. */
export const SILENT_SEARCH_LIMIT = 20;

/** Reason code for a search or page read the designated provider ran without asking. */
export const SEARCH_SILENT_REASON = 'mcp_search_provider';

/** Whether a decision reason is a search that ran without asking. */
export function isSilentSearchReason(reason: string): boolean {
  return reason === SEARCH_SILENT_REASON;
}

/** Reason code for a lookup held because read content chose its link and the link carries more than it gave. */
export const SEARCH_STEERED_REASON = 'mcp_search_steered';

/** Reason codes for a designated-provider call that stops for approval, and why. */
export const SEARCH_ASK_REASONS = [
  'mcp_search_setting_ask',
  'mcp_search_guard',
  'mcp_search_limit',
  SEARCH_STEERED_REASON,
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
  /** Searches that ran without asking this turn. */
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

/**
 * Records where the links and addresses of one tool result came from, before the model reads it. A search's results
 * are the person's to open; a read of their own mail or calendar gives their contacts; every other text is data.
 * `argument_values` are the call's own strings, so a search that names a link counts as opening a page.
 */
export function recordToolResultProvenance(input: {
  state: WebSearchTurnState;
  tool_name: string;
  argument_values: readonly string[];
  texts: readonly string[];
}): void {
  const { provenance } = input.state;
  const separator = input.tool_name.lastIndexOf('__');
  const baseName = separator < 0 ? input.tool_name : input.tool_name.slice(separator + 2);
  if (isSearchResultTool(baseName) && !namesUrl(input.argument_values)) {
    recordSearchResults({ provenance, texts: input.texts });
    return;
  }
  if (isPrivateReadToolName(input.tool_name)) {
    recordOwnStoreResult({ provenance, texts: input.texts });
    return;
  }
  for (const text of input.texts) {
    recordUntrustedText({ provenance, text });
  }
}
