import type { HostToolCallPolicy, HostToolCallPolicyCall } from '@truefoundry/trueforge-core/core';

/**
 * Per-turn host facts about the internal sources, written once per turn by the
 * retrieval paths and read by the tool policy. Plain mutable data: the memory
 * capability populates the recall half during its pre-LLM pass, the knowledge
 * lookup populates the library half before the turn exists, and the policy
 * only reads.
 *
 * Child threads inherit the turn's policy (SessionHandle passes the
 * resolver's policy to sub-agent threads), so a sub-agent's web_search is
 * judged against the same turn's facts. Deliberate: the sub-agent works the
 * turn's question, not a new one — per-thread state would silently drop the
 * protection for the calls most likely to substitute.
 *
 * Turn-scoped by construction: the turn creates one instance, and it is
 * dropped with the turn. recallTokens/libraryQuery must never be logged or
 * persisted. The one exception is the near-miss outcome (consulted, answered
 * nothing), which the turn record carries as a boolean so an
 * approval/tool-response resubmission can re-arm the policy — the query text
 * itself is re-derived from the turn history, never stored.
 */
export interface InternalSourceState {
  /** The question the persona library was asked, when a persona is active. */
  libraryQuery: string | undefined;
  /** Normalized content tokens of the library query, for overlap comparison. */
  libraryTokens: readonly string[] | undefined;
  /** True when retrieval reached the relevance judge (the floor produced candidates). */
  libraryConsulted: boolean;
  /** True when at least one passage survived into the injected block. */
  libraryAnswered: boolean;
  /**
   * Normalized content tokens of what recall injected this turn (recalled
   * items plus entity summaries). Undefined when recall injected nothing.
   */
  recallTokens: readonly string[] | undefined;
}

export function createInternalSourceState(): InternalSourceState {
  return {
    libraryQuery: undefined,
    libraryTokens: undefined,
    libraryConsulted: false,
    libraryAnswered: false,
    recallTokens: undefined,
  };
}

/** Records the persona-library lookup outcome for the turn. Tolerates an absent state. */
export function noteLibraryLookup(
  state: InternalSourceState | undefined,
  input: { query: string; consulted: boolean; answered: boolean },
): void {
  if (state === undefined) {
    return;
  }
  state.libraryQuery = input.query;
  state.libraryTokens = tokenize(input.query);
  state.libraryConsulted = input.consulted;
  state.libraryAnswered = input.answered;
}

/** Records what recall injected this turn. Tolerates an absent state; empty input clears. */
export function noteRecallContent(state: InternalSourceState | undefined, texts: readonly string[]): void {
  if (state === undefined) {
    return;
  }
  const tokens = tokenize(texts.join('\n'));
  state.recallTokens = tokens.length === 0 ? undefined : tokens;
}

/**
 * Host fact injected as the persona-knowledge block when the library was
 * consulted for the turn's question and the relevance judge kept nothing.
 * Names what the host established (the library has no relevant passage) and
 * what the turn may do about it, so the model answers "not in the library"
 * instead of web-divining a substitute.
 */
export const PERSONA_LIBRARY_NEAR_MISS_MARKER =
  'Host fact: the active persona\u2019s knowledge library was searched for the current question and nothing in it was relevant. ' +
  'The library is the authority for this question \u2014 do not substitute open-web research for a library answer. ' +
  'If the library cannot answer it, say plainly that it is not in the persona\u2019s library.';

const LIBRARY_BLOCK_MESSAGE =
  'The persona\u2019s knowledge library was searched for this question and contains nothing relevant. ' +
  'Do not substitute open-web research for the library\u2019s answer: answer only from the library, ' +
  'or say plainly that it is not in the persona\u2019s library.';

const MEMORY_BLOCK_MESSAGE =
  'Memory recall surfaced material this turn that matches this query\u2019s terms (see the memory block). ' +
  'Web search is not a substitute for recall: answer from what was recalled, ' +
  'or say plainly that you do not have it.';

const CONVERSATION_BLOCK_MESSAGE =
  'Your conversation history is not on the open web and no search engine can retrieve it. ' +
  'Answer from the conversation and recalled memory instead of web_search.';

/**
 * The web query is about the agent's own conversation or memory: no web index
 * can satisfy it, so the call is blocked whatever the turn's shape. Kept
 * narrow on purpose — a legitimate open-web question never phrases its query
 * this way. Recall-phrased queries ("remember what we said about X") are
 * treated as internal by design: that phrasing is the substitution pathology
 * wearing a question mark, and the turn's recall is the authority for it.
 */
const OWN_CONVERSATION_PATTERNS: readonly RegExp[] = [
  /\bour\s+(earlier\s+|previous\s+|recent\s+|last\s+)?(conversation|conversations|chat|chats|discussion|discussions)\b/i,
  /\b(chat|conversation|discussion)\s+history\b/i,
  /\bchat\s+logs?\b/i,
  /\bfrom\s+our\s+(earlier\s+|previous\s+|recent\s+|last\s+)?(conversation|chat|discussion)\b/i,
  /\bin\s+(this|our)\s+(conversation|chat)\b/i,
  /\bwhat\s+did\s+we\s+(discuss|decide|talk\s+about|say)\b/i,
  /\bwe\s+(discussed|talked\s+about|decided|agreed)\b/i,
  /\bremember\s+what\s+(we|you|i)\b/i,
  /\bsearch\s+my\s+memor(y|ies)\b/i,
  /\bfrom\s+(your\s+)?memory\b/i,
  /\byou\s+(said|told\s+me|mentioned)\b/i,
];

export function webQueryTargetsOwnConversation(query: string): boolean {
  return OWN_CONVERSATION_PATTERNS.some(pattern => pattern.test(query));
}

/**
 * Argument names carrying the search text across web_search providers. A
 * value may be a string or a list of strings (Parallel sends an `objective`
 * plus `search_queries`). Each readable value is checked on its own, so a
 * private detail in any one of them blocks the call; joining them would
 * dilute the overlap ratio behind a clean sibling query.
 *
 * Coverage assumption: the web provider's tool is named `web_search`
 * (matched case-insensitively), reached directly or through a dispatcher
 * that reports it via underlyingToolName, with the query under one of the
 * keys below. A provider exposing search under a different tool name is
 * outside this policy's coverage — the guarantee is narrowed to the covered
 * shapes, not impossibility by construction.
 */
const WEB_QUERY_ARG_KEYS: readonly string[] = [
  'query',
  'q',
  'search_query',
  'searchQuery',
  'text',
  'question',
  'prompt',
  'objective',
  'search_queries',
  'queries',
];

function readableStrings(value: unknown): string[] {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.flatMap(readableStrings);
  }
  return [];
}

function extractWebQueries(args: Record<string, unknown>): string[] {
  return WEB_QUERY_ARG_KEYS.flatMap(key => readableStrings(args[key]));
}

const STOPWORDS: ReadonlySet<string> = new Set(
  (
    'a an the and or but of to in on for with at by from as is are was were be been being ' +
    'it its this that these those i you he she we they me him her us them my your his our their ' +
    'mine yours ours what which who whom how when where why do does did have has had having ' +
    'not no yes so if then than too very can will would should could just about into over after ' +
    'before between out up down off all any both each few more most other some such only own same ' +
    's t d ll re ve m'
  ).split(' '),
);

/** Plural-only stemming: both sides stem identically, so overlap is what matters, not lemmas. */
function stemPlural(token: string): string {
  if (token.length > 4 && token.endsWith('ies')) {
    return `${token.slice(0, -3)}y`;
  }
  if (token.length > 4 && token.endsWith('es') && /(s|x|z|ch|sh)es$/.test(token)) {
    return token.slice(0, -2);
  }
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss') && !token.endsWith('us')) {
    return token.slice(0, -1);
  }
  return token;
}

/**
 * Lowercase content tokens: version-like compounds (`v4.2.1`) stay whole,
 * stopwords drop out. Deterministic and cheap — no model call.
 */
export function tokenize(text: string): string[] {
  const raw = text
    .toLowerCase()
    .replace(/['\u2019]/g, '')
    .match(/[a-z0-9]+(?:[._-][a-z0-9]+)*/g);
  if (raw === null) {
    return [];
  }
  const tokens: string[] = [];
  for (const word of raw) {
    const stemmed = stemPlural(word);
    if (stemmed.length > 0 && !STOPWORDS.has(stemmed)) {
      tokens.push(stemmed);
    }
  }
  return tokens;
}

/**
 * Initialism expansion with alias provenance. Every 3-4 token run also
 * matches its initialism (`quality assurance processes` also matches `qap`),
 * so abbreviations and their expansions compare equal without a dictionary.
 * Two-token runs do NOT generate aliases generically: two-letter aliases
 * collide far too easily (`ai` from `annual income` would then block a query
 * about artificial intelligence). They come only from the explicit allowlist
 * below, whose entries each need a test pinning both the expansion and a
 * non-collision case. Runs need every token to start with a letter of length
 * >= 2 to keep the aliases from turning into noise.
 *
 * Provenance matters for counting: a shared token counts toward the overlap
 * only when it is an original on at least one side. Alias-on-both-sides
 * intersections (two expansions that happen to abbreviate the same way) are
 * coincidence, not paraphrase, and never count — this also keeps the
 * numerator bounded by real tokens.
 */
const TWO_TOKEN_INITIALISMS: ReadonlyMap<string, string> = new Map([
  // alias -> the exact expansion it may be generated from
  ['qa', 'quality assurance'],
]);

interface ExpandedTokenSet {
  /** Originals plus generated initialism aliases. */
  all: ReadonlySet<string>;
  /** Tokens the text actually contained; generated aliases excluded. */
  originals: ReadonlySet<string>;
  /** Original token count, before alias expansion: the overlap denominator. */
  size: number;
}

function expandWithInitialisms(tokens: readonly string[]): ExpandedTokenSet {
  const originals = new Set<string>(tokens);
  const all = new Set<string>(tokens);
  for (let run = 2; run <= 4; run += 1) {
    for (let i = 0; i + run <= tokens.length; i += 1) {
      const slice = tokens.slice(i, i + run);
      if (!slice.every(t => t.length >= 2 && /^[a-z]/.test(t))) {
        continue;
      }
      const alias = slice.map(t => t[0]).join('');
      if (run === 2) {
        // Two-letter aliases only from the allowlist: generic 2-token runs
        // collide too easily (`ai` from `annual income`). The allowlist maps
        // the alias to the exact expansion it may be generated from.
        if (TWO_TOKEN_INITIALISMS.get(alias) !== slice.join(' ')) {
          continue;
        }
      }
      all.add(alias);
    }
  }
  return { all, originals, size: tokens.length };
}

/**
 * Whether two queries ask the same question.
 *
 * Single-token queries are evaluated, never auto-passed: the lone token
 * matches when it is exactly (or abbreviates) what the other side is about.
 * Multi-token queries compare the share of the smaller side's content tokens
 * found in the other against the threshold.
 *
 * This is token overlap — word-order, stopword, plural, and initialism
 * variation — not semantic similarity. "Spanish nationality requirements" vs
 * "Spanish citizenship requirements" does not match, and token drift
 * (a paraphrase past token recognition) evades it: inherent to a
 * zero-model-call scheme, accepted as residual.
 */
const LIBRARY_OVERLAP_THRESHOLD = 0.6;
/**
 * Higher bar for recall: the recall token bag is a union over everything
 * recall injected (items, entities, observations), so coincidental overlap
 * with an open-web question is likelier than against the single library
 * question. 2/3 overlap ("best tapas Madrid" vs a Madrid-trip recall) passes;
 * 3/4 and above blocks.
 */
const RECALL_OVERLAP_THRESHOLD = 0.75;

export function queriesAskSameQuestion(input: {
  a: readonly string[];
  b: readonly string[];
  /** Share of the smaller side's tokens that must match. Defaults to the library threshold. */
  threshold?: number | undefined;
}): boolean {
  return expandedAskSameQuestion({
    a: expandWithInitialisms(input.a),
    b: expandWithInitialisms(input.b),
    threshold: input.threshold ?? LIBRARY_OVERLAP_THRESHOLD,
  });
}

/** Overlap comparison over pre-expanded token sets; see queriesAskSameQuestion. */
function expandedAskSameQuestion(input: { a: ExpandedTokenSet; b: ExpandedTokenSet; threshold: number }): boolean {
  if (input.a.size === 0 || input.b.size === 0) {
    return false;
  }
  if (input.a.size === 1 || input.b.size === 1) {
    // No auto-pass: a lone token still blocks when it is exactly (or
    // abbreviates) what the other side is about.
    const singleSide = input.a.size === 1 ? input.a : input.b;
    const otherSide = input.a.size === 1 ? input.b : input.a;
    const [single] = [...singleSide.originals];
    return single !== undefined && otherSide.all.has(single);
  }
  let shared = 0;
  for (const token of input.a.all) {
    if (input.b.all.has(token) && (input.a.originals.has(token) || input.b.originals.has(token))) {
      shared += 1;
    }
  }
  return shared / Math.min(input.a.size, input.b.size) >= input.threshold;
}

/**
 * Builds the per-turn tool policy that narrows the internal-source fallback
 * pathology for the covered shapes. Three independent rules, all enforced
 * by the harness at dispatch time — never by instruction compliance:
 *
 * - Library near-miss: the library was consulted for the turn's question and
 *   the relevance judge kept nothing. A web_search about the same question is
 *   the model substituting open-web research for the library's (absent)
 *   answer; it is blocked.
 * - Recall authority: recall injected material and the web query asks about
 *   that same material. Web search is not a substitute for recall; blocked.
 * - Own-conversation queries: the web query targets the agent's conversation
 *   or memory, which no web index can satisfy; blocked unconditionally.
 *
 * Matching is token overlap — word-order, stopword, plural, and initialism
 * variation — evaluated per call against the turn's state; single-token
 * queries are judged by exact or initialism equality, never auto-passed. The
 * recall bar (0.75) sits above the library bar (0.6) because the recall bag
 * unions everything recall injected. This is not semantic similarity and not
 * impossibility by construction: a paraphrase past token recognition, or a
 * search tool under a different name than the covered `web_search` shape,
 * evades it.
 *
 * Everything else passes untouched, so mixed turns keep full web access for
 * their open-web questions. No model call, no per-turn latency beyond
 * tokenizing short strings.
 */
export function buildInternalSourceToolPolicy(
  state: InternalSourceState,
  logger?: { warn(message: string): void },
): HostToolCallPolicy {
  // Expanded lazily and memoized per distinct token array: recall records
  // its content during the pre-LLM pass, after this policy is built, so
  // eager expansion at build time would freeze an empty set.
  let libraryTokensSeen: readonly string[] | undefined = undefined;
  let libraryExpanded: ExpandedTokenSet | undefined = undefined;
  let recallTokensSeen: readonly string[] | undefined = undefined;
  let recallExpanded: ExpandedTokenSet | undefined = undefined;
  const librarySet = (): ExpandedTokenSet | undefined => {
    if (state.libraryTokens === undefined) {
      return undefined;
    }
    if (state.libraryTokens !== libraryTokensSeen) {
      libraryTokensSeen = state.libraryTokens;
      libraryExpanded = expandWithInitialisms(state.libraryTokens);
    }
    return libraryExpanded;
  };
  const recallSet = (): ExpandedTokenSet | undefined => {
    if (state.recallTokens === undefined) {
      return undefined;
    }
    if (state.recallTokens !== recallTokensSeen) {
      recallTokensSeen = state.recallTokens;
      recallExpanded = expandWithInitialisms(state.recallTokens);
    }
    return recallExpanded;
  };
  return (call: HostToolCallPolicyCall) => {
    const name = call.underlyingToolName ?? call.functionName;
    if (name.toLowerCase() !== 'web_search') {
      return undefined;
    }
    const queries = extractWebQueries(call.args);
    if (queries.length === 0) {
      // Fail open, but not silently: a web_search with no readable query
      // argument is outside the policy's coverage, and that must be visible.
      logger?.warn('web_search call carried no readable query argument; allowing the call');
      return undefined;
    }
    if (queries.some(webQueryTargetsOwnConversation)) {
      return { message: CONVERSATION_BLOCK_MESSAGE };
    }
    // Armed-ness is checked before the queries are tokenized: when neither
    // rule can fire, a web_search costs a name comparison and nothing more.
    const libraryArmed = state.libraryConsulted && !state.libraryAnswered && state.libraryTokens !== undefined;
    const recallArmed = state.recallTokens !== undefined;
    if (!libraryArmed && !recallArmed) {
      return undefined;
    }
    for (const query of queries) {
      const web = expandWithInitialisms(tokenize(query));
      if (libraryArmed) {
        const library = librarySet();
        if (
          library !== undefined &&
          expandedAskSameQuestion({ a: web, b: library, threshold: LIBRARY_OVERLAP_THRESHOLD })
        ) {
          return { message: LIBRARY_BLOCK_MESSAGE };
        }
      }
      if (recallArmed) {
        const recall = recallSet();
        if (
          recall !== undefined &&
          expandedAskSameQuestion({ a: web, b: recall, threshold: RECALL_OVERLAP_THRESHOLD })
        ) {
          return { message: MEMORY_BLOCK_MESSAGE };
        }
      }
    }
    return undefined;
  };
}
