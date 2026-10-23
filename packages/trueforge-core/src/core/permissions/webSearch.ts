import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { isPrivateReadToolName } from './privateReadTools';
import { addPrivateFingerprints, type ChatPrivateFingerprints, emptyChatPrivateFingerprints } from './privateTextCheck';

/**
 * Host state and helpers for the designated search provider's silent runs: the per-turn count that
 * trips the loop breaker and the set of URLs the provider's own results returned, which is all a
 * silent fetch may name. Both live in host memory for one turn and never reach the model.
 */

/** Silent searches one turn may run before the next one asks. */
export const SILENT_SEARCH_LIMIT = 20;

/** Silent fetches of one host a turn may run before the next one asks. */
export const SILENT_FETCHES_PER_HOST = 2;

/** Cap on remembered result URLs per turn, so a huge result cannot grow host memory without bound. */
const MAX_RESULT_URLS = 500;

/** Reason code for a search the designated provider ran without asking. */
export const SEARCH_SILENT_REASON = 'mcp_search_provider';

/** Reason code for a search that ran without asking after a private read, because its text was checked. */
export const SEARCH_AFTER_READ_SILENT_REASON = 'mcp_search_after_read_checked';

/** Reason code for a search that ran without asking under "Allow searches in this chat". */
export const SEARCH_CHAT_GRANTED_SILENT_REASON = 'mcp_search_chat_granted';

/** Reason code for a search held because it carries a detail from the person's private data, or cannot be checked. */
export const SEARCH_PRIVATE_DETAIL_REASON = 'mcp_search_private_detail';

/** Reason code for a search held because the chat has read private data. */
export const SEARCH_AFTER_PRIVATE_READ_REASON = 'mcp_search_after_private_read';

/** Whether a decision reason is a search that ran without asking, after a private read or not. */
export function isSilentSearchReason(reason: string): boolean {
  return (
    reason === SEARCH_SILENT_REASON ||
    reason === SEARCH_AFTER_READ_SILENT_REASON ||
    reason === SEARCH_CHAT_GRANTED_SILENT_REASON
  );
}

/** Reason codes for a designated-provider call that stops for approval, and why. */
export const SEARCH_ASK_REASONS = [
  'mcp_search_setting_ask',
  'mcp_search_guard',
  'mcp_search_limit',
  'mcp_search_unreturned_url',
  'mcp_search_host_limit',
  SEARCH_AFTER_PRIVATE_READ_REASON,
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
  /** Searches that ran without asking this turn. */
  silentSearches: number;
  /** URLs the designated provider returned this turn, exactly as returned. */
  resultUrls: Set<string>;
  /** Silent fetches this turn, by host. */
  fetchesByHost: Map<string, number>;
  /** Tail of the text those searches sent, so a secret split across two searches is seen whole. */
  sentText: string;
  /** True once the session read private data (mail, calendar or a secret), after which a search is checked or asks. */
  privateDataRead: boolean;
  /**
   * Whether the chat's "Allow searches in this chat" grant is in force. Read at each search, so a grant the owner
   * gives during a turn covers the rest of that reply.
   */
  searchChatGranted: () => boolean;
  /**
   * The chat's kept fingerprints: loaded from the saved chat at the turn's start, then extended with this turn's
   * private texts. A grant's search check runs against these, since the texts of earlier turns are not held here.
   */
  chatFingerprints: ChatPrivateFingerprints;
  /** True once this turn had a private text it could not fingerprint, so the kept fingerprints miss a copy. */
  fingerprintsLost: boolean;
  /** True when the chat had a saved fingerprint record at the turn's start. A history mark without one is unchecked. */
  savedFingerprintsLoaded: boolean;
  /** Text of the private reads' results this turn received, so a later search can be checked against it. */
  privateTexts: string[];
  /** Private reads this turn that reached the model, by any thread. Each must have its result kept as text. */
  privateReadCalls: number;
  /** Private read results kept as text this turn, by any thread. */
  privateTextsKept: number;
  /** True when the private mark came from saved state or old context, whose text this turn never saw. */
  privateTextLost: boolean;
  /** True once the host put a private text of its own before the model this turn, such as recalled memory. */
  privateContextKept: boolean;
  /**
   * True once such a text was one the host does not put before the model again on later turns, such as an
   * attached file's text. The profile and recalled memory are put there each turn, so they are not counted.
   */
  onceOnlyContextKept: boolean;
  /** Tail of the one-at-a-time chain that classifies and counts the turn's search calls. */
  admission: Promise<void>;
}

export function createWebSearchTurnState(): WebSearchTurnState {
  return {
    silentSearches: 0,
    resultUrls: new Set(),
    fetchesByHost: new Map(),
    sentText: '',
    privateDataRead: false,
    searchChatGranted: () => false,
    chatFingerprints: emptyChatPrivateFingerprints(),
    fingerprintsLost: false,
    savedFingerprintsLoaded: false,
    privateTexts: [],
    privateReadCalls: 0,
    privateTextsKept: 0,
    privateTextLost: false,
    privateContextKept: false,
    onceOnlyContextKept: false,
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

const TRAILING_PUNCTUATION = /[.,;:!?)\]}'"]+$/;
const SCHEME_URL = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>\\`]+/g;
const SCHEMELESS_URL_WITH_PATH = /(?<![\w@.-])(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}(?::\d+)?\/[^\s"'<>\\`]*/g;
const WWW_URL = /(?<![\w@.-])www\.[^\s"'<>\\`]+/gi;
/** A whole value that is a bare host (optionally with port and path): `example.com`, `10.0.0.1:8080/x`. */
const WHOLE_HOST = /^(?:(?:[A-Za-z0-9-]+\.)+[A-Za-z]{2,}|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:[/?#]\S*)?$/;

/** URLs in free text, each match removed before the next pattern runs so one URL is never counted twice. */
function urlsInText(text: string): string[] {
  const found: string[] = [];
  let rest = text;
  for (const pattern of [SCHEME_URL, WWW_URL, SCHEMELESS_URL_WITH_PATH]) {
    rest = rest.replace(pattern, match => {
      found.push(match);
      return ' ';
    });
  }
  return found;
}

/** Keys whose contents describe the page or what it links to, never the result itself. */
const NON_RESULT_KEYS = new Set(['links', 'metadata', 'images', 'favicon', 'excerpts', 'content', 'raw_content']);
const MAX_RESULT_DEPTH = 3;

/** The `url` field of each result object in a provider's JSON; text inside a result is never read for links. */
function collectResultUrls(node: unknown, into: string[], depth: number): void {
  if (depth > MAX_RESULT_DEPTH) {
    return;
  }
  if (Array.isArray(node)) {
    for (const child of node) {
      collectResultUrls(child, into, depth + 1);
    }
  } else if (typeof node === 'object' && node !== null) {
    for (const [key, child] of Object.entries(node)) {
      if (key === 'url' && typeof child === 'string') {
        into.push(child);
      } else if (!NON_RESULT_KEYS.has(key)) {
        collectResultUrls(child, into, depth + 1);
      }
    }
  }
}

/**
 * Remembers each result's own `url` field, as returned. A link that only appears in an excerpt, a
 * result's own links, or prose is not a result, so a fetch of it asks. Nothing else is ever added.
 */
export function recordResultUrls(input: { state: WebSearchTurnState; texts: readonly string[] }): void {
  for (const text of input.texts) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const urls: string[] = [];
    collectResultUrls(parsed, urls, 0);
    for (const url of urls) {
      if (url.length > 0 && input.state.resultUrls.size < MAX_RESULT_URLS) {
        input.state.resultUrls.add(url);
      }
    }
  }
}

function isWholeUrl(value: string): boolean {
  return WHOLE_HOST.test(value) || /^[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+$/.test(value) || /^www\.\S+$/i.test(value);
}

/** Whether any outbound value is, or contains, a URL: a call that fetches rather than searches. */
export function namesUrl(values: readonly string[]): boolean {
  return values.some(value => isWholeUrl(value) || urlsInText(value).length > 0);
}

/**
 * URLs an outbound call names that no search result of this turn returned. A value that is itself a
 * URL must match a returned one exactly; a URL embedded in prose may also match without trailing
 * punctuation. A bare hostname counts as a URL, so a model cannot compose a fetch by dropping the
 * scheme.
 */
export function unreturnedUrls(input: { values: readonly string[]; state: WebSearchTurnState }): string[] {
  const unreturned: string[] = [];
  for (const value of input.values) {
    if (isWholeUrl(value)) {
      if (!input.state.resultUrls.has(value)) {
        unreturned.push(value);
      }
      continue;
    }
    for (const url of urlsInText(value)) {
      if (!input.state.resultUrls.has(url) && !input.state.resultUrls.has(url.replace(TRAILING_PUNCTUATION, ''))) {
        unreturned.push(url);
      }
    }
  }
  return unreturned;
}

/** Host of a URL as the fetch would reach it, or undefined when the value does not parse as one. */
function hostOfUrl(value: string): string | undefined {
  try {
    return new URL(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) ? value : `https://${value}`).hostname.toLowerCase();
  } catch {
    return undefined;
  }
}

/** Distinct hosts of the URLs an outbound call names. */
function fetchedHosts(values: readonly string[]): Set<string> {
  const hosts = new Set<string>();
  for (const value of values) {
    for (const url of isWholeUrl(value) ? [value] : urlsInText(value)) {
      const host = hostOfUrl(url);
      if (host !== undefined) {
        hosts.add(host);
      }
    }
  }
  return hosts;
}

/** Whether the call names a host the turn already fetched silently its allowance of times. */
export function namesHostAtFetchLimit(input: { values: readonly string[]; state: WebSearchTurnState }): boolean {
  return [...fetchedHosts(input.values)].some(
    host => (input.state.fetchesByHost.get(host) ?? 0) >= SILENT_FETCHES_PER_HOST,
  );
}

export function countSilentFetches(input: { values: readonly string[]; state: WebSearchTurnState }): void {
  for (const host of fetchedHosts(input.values)) {
    input.state.fetchesByHost.set(host, (input.state.fetchesByHost.get(host) ?? 0) + 1);
  }
}

/**
 * The one place that records and answers "has this session read private data". Called for each private read before
 * its result reaches the model, so the search provider's classifier sees every read first.
 */
export function markPrivateDataRead(state: WebSearchTurnState): void {
  state.privateDataRead = true;
  state.privateReadCalls += 1;
}

/** Mark restored from saved state or from the context of a thread: the text it read is not held here. */
export function markPrivateDataReadFromHistory(state: WebSearchTurnState): void {
  state.privateDataRead = true;
  state.privateTextLost = true;
  if (!state.savedFingerprintsLoaded) {
    state.fingerprintsLost = true;
  }
}

export function hasReadPrivateData(state: WebSearchTurnState): boolean {
  return state.privateDataRead;
}

/** Above this, the text is not kept whole, so a check could miss a copy; the turn then asks. */
const MAX_PRIVATE_TEXT_CHARS = 2_000_000;

/** Keeps the text a private read's result returned, for the checks on later searches and maps. */
export function recordPrivateReadText(input: { state: WebSearchTurnState; text: string }): void {
  input.state.privateTextsKept += 1;
  keepText({ ...input, running_details: true });
}

/**
 * Keeps a sub-agent's final answer for the checks. The answer reaches the parent's model and can carry what the
 * sub-agent read from mail, so it is checked like a private read's text. It is not counted as a read, so it cannot
 * stand in for one that failed.
 */
export function keepSubAgentAnswerText(input: { state: WebSearchTurnState; text: string }): void {
  // The answer can also carry what the sub-agent found on the web, so names in its running text are not kept.
  keepText({ ...input, running_details: false });
}

function keepText(input: { state: WebSearchTurnState; text: string; running_details: boolean }): void {
  const { state, text } = input;
  // Fingerprints are kept even after the turn's own text was lost, since a later turn checks them.
  if (
    !state.fingerprintsLost &&
    !addPrivateFingerprints({
      state: state.chatFingerprints,
      text,
      word_runs: true,
      running_details: input.running_details,
    })
  ) {
    state.fingerprintsLost = true;
  }
  if (state.privateTextLost) {
    return;
  }
  const kept = state.privateTexts.reduce((total, held) => total + held.length, 0);
  if (kept + text.length > MAX_PRIVATE_TEXT_CHARS) {
    state.privateTexts = [];
    state.privateTextLost = true;
    return;
  }
  state.privateTexts.push(text);
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
 * The text of a private read's result, or undefined when it cannot be read whole: an error, or a block that is
 * not text (an image or a file this check cannot scan).
 */
function scannableResultText(result: CallToolResult): string | undefined {
  if (result.isError === true || !Array.isArray(result.content)) {
    return undefined;
  }
  if (result.content.some(block => block.type !== 'text')) {
    return undefined;
  }
  return resultTexts(result).join('\n');
}

/**
 * Keeps the details of a private text the host itself puts before the model: recalled memory, the person's profile,
 * or the text of a file they attached. It is not a private read, so it never holds a search on its own; a search
 * that carries one of its names, contacts, numbers or addresses asks first, in this turn and in later turns.
 */
export function recordPrivateContextText(input: {
  state: WebSearchTurnState;
  text: string;
  /**
   * `each_turn` for a text the host puts before the model again every turn (the profile, recalled memory); its
   * ordinary wording is left out, or it would hold ordinary searches. `attachment` for a file's text, kept whole.
   */
  source: 'each_turn' | 'attachment';
}): void {
  const { state, text } = input;
  if (text.trim() === '') {
    return;
  }
  state.privateContextKept = true;
  const attachment = input.source === 'attachment';
  if (attachment) {
    state.onceOnlyContextKept = true;
  }
  if (
    !state.fingerprintsLost &&
    !addPrivateFingerprints({ state: state.chatFingerprints, text, word_runs: attachment, running_details: true })
  ) {
    state.fingerprintsLost = true;
  }
}

/** What Aman could read of a file the person attached, at the moment it arrives. */
export type AttachedFileContent =
  | { kind: 'text'; text: string }
  /** A PDF or scanned image, whose text is kept once it is extracted later in the turn. */
  | { kind: 'extracted_later' }
  /** An image the model reads itself, a spreadsheet, or any other file whose text cannot be read here. */
  | { kind: 'unreadable' };

/**
 * Counts one file the person attached, before the model sees it, and keeps its text when it can be read. A file
 * whose text cannot be read leaves the chat unable to check its searches, so each one asks.
 */
export function recordAttachedFile(input: { state: WebSearchTurnState; content: AttachedFileContent }): void {
  const { state, content } = input;
  state.chatFingerprints.attached_files += 1;
  state.privateContextKept = true;
  state.onceOnlyContextKept = true;
  if (content.kind === 'unreadable') {
    state.fingerprintsLost = true;
  } else if (content.kind === 'text') {
    recordPrivateContextText({ state, text: content.text, source: 'attachment' });
  }
}

/** A file counted at upload whose text could not be extracted after all: the chat can no longer check its searches. */
export function markAttachedFileUnreadable(state: WebSearchTurnState): void {
  state.fingerprintsLost = true;
}

/**
 * Called with how many files the chat's history says the person attached. More than the record covers means a file
 * from an earlier turn, an imported chat or a lost save left no fingerprints, so the chat's searches ask.
 */
export function checkAttachedFilesCovered(input: { state: WebSearchTurnState; attached_in_history: number }): void {
  if (input.attached_in_history > input.state.chatFingerprints.attached_files) {
    input.state.fingerprintsLost = true;
  }
}

/**
 * Records one tool result that is about to reach the model. The dispatch loop calls this for every result, so no
 * tool has to remember to. A private read is always marked, and its text is kept when it can be scanned; one that
 * cannot be scanned keeps no text, so the turn's later searches and maps ask. Once the turn has read private data,
 * any other result is kept too, since a command can print a file a mail read downloaded. An error from a tool that
 * does not read private data carries no file text, so it is not kept.
 */
export function recordPrivateToolResult(input: {
  state: WebSearchTurnState;
  tool_name: string;
  result: CallToolResult;
}): void {
  const { state, result } = input;
  if (isPrivateReadToolName(input.tool_name)) {
    markPrivateDataRead(state);
    const text = scannableResultText(result);
    if (text !== undefined && text !== '') {
      recordPrivateReadText({ state, text });
    }
    return;
  }
  if (!hasReadPrivateData(state) || result.isError === true) {
    return;
  }
  const text = scannableResultText(result);
  if (text === undefined) {
    state.privateTexts = [];
    state.privateTextLost = true;
    state.fingerprintsLost = true;
    return;
  }
  // Any other result after a private read, such as a web page or a command's output, is kept as main kept it.
  keepText({ state, text, running_details: false });
}

/**
 * Whether the chat's saved fingerprints can check this turn's searches: every private read the chat made has its
 * text fingerprinted, and none was lost. A chat that cannot be checked asks before each search.
 */
export function privateFingerprintsUsable(state: WebSearchTurnState): boolean {
  return (
    state.chatFingerprints.complete &&
    !state.fingerprintsLost &&
    state.privateTextsKept >= state.privateReadCalls &&
    !state.chatFingerprints.secret
  );
}

/**
 * Whether the chat has read private data that a search or map must not send without asking. The process mark is lost
 * on a restart, so the saved record answers too: it is incomplete only after a private read Aman could not check.
 */
export function chatPrivateReadHeld(input: { state: WebSearchTurnState; markedInProcess: boolean }): boolean {
  const saved = input.state.chatFingerprints;
  return input.markedInProcess || saved.secret || (input.state.savedFingerprintsLoaded && !saved.complete);
}

/** Whether this turn holds private-text fingerprints, or a lost one, that the chat's saved record must take in. */
export function hasPrivateFingerprintsToSave(state: WebSearchTurnState): boolean {
  return (
    state.privateReadCalls > 0 || state.privateContextKept || state.fingerprintsLost || state.chatFingerprints.secret
  );
}

/**
 * Whether a later turn that starts before this one saves would miss fingerprints it cannot get back. The profile and
 * recalled memory are put before the model again each turn, so they alone never make a later turn distrust the record.
 */
export function hasUnrepeatedPrivateFingerprints(state: WebSearchTurnState): boolean {
  return (
    state.privateReadCalls > 0 || state.onceOnlyContextKept || state.fingerprintsLost || state.chatFingerprints.secret
  );
}

/** The chat's fingerprints as the next turn of this chat loads them. */
export function chatFingerprintsAfterTurn(state: WebSearchTurnState): ChatPrivateFingerprints {
  return {
    complete: privateFingerprintsUsable(state),
    has_text: state.chatFingerprints.has_text,
    secret: state.chatFingerprints.secret,
    entries: state.chatFingerprints.entries,
    attached_files: state.chatFingerprints.attached_files,
  };
}

/**
 * Whether every search must be checked against the chat's kept fingerprints: the chat holds some, or lost one.
 * Only a chat that never saw private text, here or in an earlier turn, skips the check.
 */
export function privateDetailCheckNeeded(state: WebSearchTurnState): boolean {
  return state.chatFingerprints.has_text || state.fingerprintsLost || !state.chatFingerprints.complete;
}

/** Whether the kept fingerprints cover every private text the chat saw, so a check against them is whole. */
export function privateDetailCheckable(state: WebSearchTurnState): boolean {
  return state.chatFingerprints.complete && !state.fingerprintsLost;
}

/**
 * The text a search or map is checked against, or undefined when it is not all there: the mark came
 * from earlier history, or some private read has no result kept to compare with.
 */
export function privateTextForChecks(state: WebSearchTurnState): readonly string[] | undefined {
  if (state.privateTextLost || state.privateTextsKept < state.privateReadCalls) {
    return undefined;
  }
  return state.privateTexts;
}
