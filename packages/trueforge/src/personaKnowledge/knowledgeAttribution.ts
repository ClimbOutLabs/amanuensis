import type { ChatCompletionContentPartRefusal, ChatCompletionContentPartText } from '@truefoundry/trueforge-core/core';
import type { PersonaKnowledgeHit } from './knowledgeRetrieval';

/**
 * Host-side attribution enforcement for persona-knowledge passages.
 *
 * The injected block asks the model to copy a passage's machine marker
 * (like `⟦src:1⟧`) next to claims drawn from it — a mechanical instruction
 * models follow far more reliably than "name the source title". But an
 * instruction is still just an instruction, and live testing proved the
 * model can ignore it. So the host does not trust the model: after the
 * turn completes, the final assistant message passes through
 * repairKnowledgeAttribution, which detects — by marker, by named title, or
 * by distinctive-content overlap — which injected passages the answer
 * actually used, and appends a `Sources:` line for any used passage the
 * model did not attribute. Complied-with markers get rendered; ignored
 * instructions get repaired.
 *
 * This is a backstop, not a guarantee: it catches markers, named titles,
 * and light paraphrases that reuse a passage's distinctive vocabulary. A
 * determined rewording that avoids the passage's rarest terms, names, and
 * numbers can still escape — and that is accepted, because the alternative
 * (a hair-trigger detector) cites passages the answer never used, and a
 * wrong citation is worse than none.
 *
 * Markers are stripped from the terminal message by the post-pass before the
 * turn record is persisted, and the host's sanitizeAssistantTextForContext
 * hook strips them from assistant messages entering the durable thread
 * context at the AGENT_CONTEXT_APPEND boundary — so transcripts never carry
 * live markers into later turns, where a stale marker could false-attribute
 * a passage the next answer never used. Per-turn nonces were rejected as
 * model-facing complexity for a scenario the persistence design already
 * prevents. Streamed deltas are deliberately not post-processed (see the
 * finalizeAssistantOutput contract); when the post-pass repairs the terminal
 * message, TurnHandle re-publishes the repaired model.message event (same
 * id) on the stream before TURN_DONE, so delta-folding live clients converge
 * on the repaired content — turn.done itself is turn-scoped and never
 * reaches message rendering.
 *
 * Everything here is pure and synchronous: no extra LLM call per turn, no
 * I/O, no throws. Callers treat "text returned unchanged" as "no repair".
 */

/** Machine citation marker for the injected passage at `index` (0-based). */
export function knowledgeCitationMarker(index: number): string {
  return `⟦src:${String(index + 1)}⟧`;
}

/** Matches machine citation markers so model-echoed ones can be stripped. */
const CITATION_MARKER_PATTERN = /⟦src:\d+⟧/g;

/**
 * Neutralizes marker-shaped text inside attacker-influenced passage content
 * (passage text, titles, URLs): a document containing `⟦src:2⟧` must not be
 * able to spoof attribution for another passage. Applied at injection time,
 * before the genuine markers are attached.
 */
export function neutralizeSpoofedCitationMarkers(text: string): string {
  return text.replace(CITATION_MARKER_PATTERN, '[src]');
}

/** Lowercase letter/number runs; Unicode-aware so Spanish text tokenizes. */
const WORD_PATTERN = /[\p{L}\p{N}]{2,}/gu;
/** Capitalized words: proper-noun candidates for the distinctive set. */
const CAPITALIZED_WORD_PATTERN = /[\p{Lu}][\p{L}\p{N}]+/gu;
/** Control and format characters, including bidi overrides like U+202E. */
const CONTROL_CHARS_PATTERN = /[\p{Cc}\p{Cf}]/gu;
/** Markdown metacharacters escaped so footer entries render as inert text. */
const MARKDOWN_ESCAPE_PATTERN = /([\\`*_[\]()#!|<>])/g;
/** Only http(s) URLs render in the footer; anything else is omitted. */
const SAFE_URL_SCHEME_PATTERN = /^https?:\/\//i;

/**
 * Compact English + Spanish stopword set. The retrieval model is
 * multilingual and libraries contain both languages, so the signature must
 * not treat "para" or "with" as distinctive.
 */
const STOPWORDS: ReadonlySet<string> = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'have',
  'has',
  'had',
  'were',
  'was',
  'are',
  'been',
  'being',
  'will',
  'would',
  'could',
  'should',
  'there',
  'their',
  'then',
  'than',
  'they',
  'them',
  'your',
  'yours',
  'about',
  'into',
  'over',
  'after',
  'before',
  'between',
  'through',
  'during',
  'under',
  'again',
  'once',
  'here',
  'when',
  'where',
  'which',
  'while',
  'what',
  'whom',
  'whose',
  'how',
  'all',
  'any',
  'both',
  'each',
  'more',
  'most',
  'other',
  'some',
  'such',
  'only',
  'same',
  'also',
  'just',
  'like',
  'because',
  'until',
  'very',
  'cannot',
  'does',
  'did',
  'doing',
  'done',
  'los',
  'las',
  'una',
  'unos',
  'unas',
  'del',
  'este',
  'esta',
  'estos',
  'estas',
  'ese',
  'esa',
  'esos',
  'esas',
  'aquel',
  'para',
  'como',
  'pero',
  'porque',
  'entre',
  'hasta',
  'desde',
  'sobre',
  'cuando',
  'donde',
  'quien',
  'cual',
  'cada',
  'todo',
  'toda',
  'todos',
  'todas',
  'esto',
  'eso',
  'muy',
  'sin',
  'con',
  'por',
  'son',
  'fue',
  'fueron',
  'están',
  'estaba',
  'tiene',
  'tienen',
  'hacer',
  'hace',
  'hacen',
  'puede',
  'pueden',
  'también',
  'sólo',
  'solo',
  'pues',
  'poco',
  'mucho',
  'mucha',
  'muchos',
  'otra',
  'otro',
]);

const MIN_SIGNATURE_WORD_LENGTH = 4;
/** Pure-digit tokens (years, codes, counts) carry meaning at any length. */
function isNumericToken(token: string): boolean {
  return /^\p{N}+$/u.test(token);
}
/**
 * Signatures at or below this size get an attribution-quality floor: the
 * relative "rarest 40%" tier stops meaning "rare" when the whole signature
 * is a handful of generic words (e.g. a 9-word passage whose "distinctive"
 * tier is just bamboo/eating). See isPassageUsedInAnswer.
 */
const SHORT_SIGNATURE_TERM_MAX = 6;
/** Longest-first cap: long passages must not dilute the signal into noise. */
const SIGNATURE_TERM_CAP = 12;
/** Share of the longest-first signature that counts as the rarest tier. */
const DISTINCTIVE_TIER_FRACTION = 0.4;
/** Shared signature terms needed before overlap counts as use. */
const MIN_SHARED_TERMS = 3;
/**
 * Shared terms that must come from the passage's distinctive set. Ordinary
 * same-topic wording shares generic topic words ("giant", "pandas",
 * "bamboo"); actual use of the passage shares what identifies it — its
 * rarest vocabulary, names, or numbers.
 */
const MIN_DISTINCTIVE_TERMS = 2;

function tokenize(text: string): string[] {
  return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

/**
 * Lowercased terms capitalized mid-passage: sentence-initial capitalization
 * is positional, not evidence of a proper noun.
 */
function properNounTerms(passageText: string): Set<string> {
  const nouns = new Set<string>();
  let match: RegExpExecArray | null;
  CAPITALIZED_WORD_PATTERN.lastIndex = 0;
  while ((match = CAPITALIZED_WORD_PATTERN.exec(passageText)) !== null) {
    if (match.index !== 0 && !/[.!?]\s*$/.test(passageText.slice(0, match.index))) {
      nouns.add(match[0].toLowerCase());
    }
  }
  return nouns;
}

interface PassageTermAnalysis {
  /**
   * Deduplicated non-stopword terms of length >= 4 — plus short pure-numeric
   * tokens, which carry meaning at any length — longest first, capped.
   */
  signature: string[];
  /** The signature's identifying subset: rarest tier, names, numbers. */
  distinctive: Set<string>;
  /**
   * Signature terms that are hard identifiers: contain a digit, or are
   * proper nouns. For short passages these are the only trustworthy
   * attribution signal (see isPassageUsedInAnswer).
   */
  hardIdentifiers: Set<string>;
}

function analyzePassageTerms(passageText: string): PassageTermAnalysis {
  const seen = new Set<string>();
  const signature: string[] = [];
  for (const token of tokenize(passageText)) {
    if (
      (!isNumericToken(token) && token.length < MIN_SIGNATURE_WORD_LENGTH) ||
      STOPWORDS.has(token) ||
      seen.has(token)
    ) {
      continue;
    }
    seen.add(token);
    signature.push(token);
  }
  signature.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
  const capped = signature.slice(0, SIGNATURE_TERM_CAP);
  const tierSize = Math.max(1, Math.ceil(capped.length * DISTINCTIVE_TIER_FRACTION));
  const properNouns = properNounTerms(passageText);
  const distinctive = new Set<string>();
  const hardIdentifiers = new Set<string>();
  capped.forEach((term, index) => {
    const isHardIdentifier = /\p{N}/u.test(term) || properNouns.has(term);
    if (index < tierSize || isHardIdentifier) {
      distinctive.add(term);
    }
    if (isHardIdentifier) {
      hardIdentifiers.add(term);
    }
  });
  return { signature: capped, distinctive, hardIdentifiers };
}

/**
 * The passage's most distinctive vocabulary: deduplicated non-stopword
 * terms of length >= 4 — plus short pure-numeric tokens, which carry
 * meaning at any length — longest first, capped.
 */
export function passageSignatureTerms(passageText: string): string[] {
  return analyzePassageTerms(passageText).signature;
}

/**
 * Whether the answer draws on the passage, judged by distinctive-content
 * overlap — not verbatim matching, so light paraphrase is still caught. A
 * passage counts as used when at least 3 of its signature terms appear in
 * the answer AND at least 2 of those are distinctive (rarest vocabulary,
 * names, numbers): a same-topic answer from general knowledge shares
 * generic topic words, while a paraphrased use shares what identifies the
 * passage.
 *
 * Short passages (six or fewer signature terms) get a quality floor on top:
 * the relative rarest-40% tier is meaningless at that size — generic topic
 * words fill it — so attribution additionally requires a shared hard
 * identifier (a name or number). A short passage with no hard identifiers
 * at all only attributes on near-verbatim overlap of the whole signature.
 * Determined rewording that avoids the distinctive vocabulary can still
 * escape; the bar is set to avoid wrong citations, not to catch everything.
 */
export function isPassageUsedInAnswer(input: { passageText: string; answerText: string }): boolean {
  const { signature, distinctive, hardIdentifiers } = analyzePassageTerms(input.passageText);
  if (signature.length === 0) {
    return false;
  }
  const answerWords = new Set(tokenize(input.answerText));
  let matched = 0;
  let distinctiveMatched = 0;
  let hardIdentifierMatched = 0;
  for (const term of signature) {
    if (answerWords.has(term)) {
      matched += 1;
      if (distinctive.has(term)) {
        distinctiveMatched += 1;
        if (hardIdentifiers.has(term)) {
          hardIdentifierMatched += 1;
        }
      }
    }
  }
  if (matched < MIN_SHARED_TERMS || distinctiveMatched < MIN_DISTINCTIVE_TERMS) {
    return false;
  }
  if (signature.length <= SHORT_SIGNATURE_TERM_MAX) {
    // Without a shared hard identifier, a short passage's "distinctive"
    // tier is just its longest generic words — not evidence of use.
    if (hardIdentifiers.size > 0) {
      return hardIdentifierMatched >= 1;
    }
    return matched >= signature.length;
  }
  return true;
}

/** Whitespace-collapsed, control-stripped text for footer rendering. */
function cleanFooterText(text: string): string {
  return text.replace(CONTROL_CHARS_PATTERN, '').replace(/\s+/g, ' ').trim();
}

/** Truncates, neutralizes spoofed markers, and escapes markdown. */
function inertFooterText(text: string, maxLength: number): string {
  return cleanFooterText(text)
    .replace(CITATION_MARKER_PATTERN, '[src]')
    .slice(0, maxLength)
    .replace(MARKDOWN_ESCAPE_PATTERN, '\\$1');
}

/**
 * Percent-encodes markdown link-forming characters in footer/injection URLs.
 * An attacker-influenced sourceUrl like
 * `https://docs.legit.example/guide [verify](https://evil.example/phish)`
 * passes the https scheme allowlist, so without this the host-generated
 * Sources line renders a live phishing link. Angle brackets are encoded too:
 * `<https://evil.example>` is a CommonMark autolink and would otherwise
 * render as a live clickable link inside the host-trusted Sources line.
 * Percent-encoding — not backslash-escaping — keeps legitimate URLs with
 * brackets or parens (e.g. Wikipedia's disambiguation titles)
 * copy-pasteable.
 */
function percentEncodeUrlMarkdownChars(url: string): string {
  return url.replace(/[[\]()<>]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

const TITLE_MAX_LENGTH = 200;
const LABEL_MAX_LENGTH = 100;
const URL_MAX_LENGTH = 300;

/**
 * Scheme + authority + path/query of a source URL: fragments never name a
 * different document, so they are dropped for identity.
 */
const SOURCE_URL_IDENTITY_PATTERN = /^([a-z][a-z0-9+.-]*):\/\/([^\s/?#]+)([^\s#]*)/i;

/**
 * Normalizes a source URL for document identity: lowercase scheme and host,
 * drop default ports and fragments, collapse trailing slashes. Query strings
 * are kept — they can name genuinely different documents. Cosmetic URL
 * differences must never split one document's passages; distinct documents
 * must never merge.
 */
function normalizeSourceUrlForIdentity(rawUrl: string): string {
  const cleaned = cleanFooterText(rawUrl);
  const match = SOURCE_URL_IDENTITY_PATTERN.exec(cleaned);
  if (match === null) {
    return cleaned.toLowerCase();
  }
  const scheme = (match[1] ?? '').toLowerCase();
  const host = (match[2] ?? '').toLowerCase().replace(/:(80|443)$/, '');
  const pathAndQuery = (match[3] ?? '').replace(/\/+$/, '');
  return `${scheme}://${host}${pathAndQuery === '' ? '/' : pathAndQuery}`;
}

/**
 * Document identity for footer dedup: the indexed document id when the hit
 * carries one (threaded from the knowledge_documents row), otherwise the
 * normalized source URL, otherwise the normalized title and label. Two
 * passages from the same document — the normal chunked-index shape — share
 * the id, so same-document passages dedupe even when their URLs differ
 * cosmetically; the URL and title fallbacks cover hits built without an id.
 */
export function knowledgeHitDocumentKey(hit: PersonaKnowledgeHit): string {
  const documentId = typeof hit.documentId === 'string' ? hit.documentId : '';
  if (documentId !== '') {
    return `id:${documentId}`;
  }
  const rawUrl = typeof hit.sourceUrl === 'string' ? cleanFooterText(hit.sourceUrl) : '';
  const normalizedUrl = normalizeSourceUrlForIdentity(rawUrl);
  if (normalizedUrl !== '') {
    return `url:${normalizedUrl}`;
  }
  const title = cleanFooterText(typeof hit.title === 'string' ? hit.title : '').toLowerCase();
  const label = cleanFooterText(typeof hit.sourceLabel === 'string' ? hit.sourceLabel : '').toLowerCase();
  return `fallback:${title}\n${label}`;
}

/**
 * One footer entry per document: two used passages from the same document
 * cite once, first used wins, order preserved. Applied where the footer is
 * built — repairKnowledgeAttribution and repairAssistantMessageContent — not
 * inside findUsedKnowledgeHits, whose index order the injected ⟦src:N⟧
 * markers depend on.
 */
export function dedupeHitsByDocument(hits: readonly PersonaKnowledgeHit[]): PersonaKnowledgeHit[] {
  const seen = new Set<string>();
  const deduped: PersonaKnowledgeHit[] = [];
  for (const hit of hits) {
    const key = knowledgeHitDocumentKey(hit);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(hit);
    }
  }
  return deduped;
}

/**
 * Human-readable form for titles that are really URL slugs: a title with no
 * whitespace and an underscore ("Giant_panda") is a URL fragment, not prose —
 * rendering it with spaces reads like a human wrote it, instead of showing
 * the markdown-escaped "Giant\_panda". Titles with real prose keep their
 * underscores escaped as before. Runs before inertFooterText, so the result
 * is still markdown-escaped and inert.
 */
function prettifyUrlDerivedTitle(title: string): string {
  if (title === '' || /\s/.test(title) || !title.includes('_')) {
    return title;
  }
  return title.replace(/_/g, ' ');
}

/**
 * One shared formatter for the injected attribution line and the repaired
 * `Sources:` footer: a title neutralized at injection cannot reappear raw
 * in the footer. Attacker-influenced title/label/URL render as inert text —
 * control and bidi characters stripped, citation markers neutralized,
 * markdown escaped in titles/labels and link-forming characters
 * percent-encoded in URLs, non-http(s) URLs omitted, lengths capped — so an
 * imported page can never buy a trusted citation badge for a phishing
 * title or URL.
 *
 * A title that is missing, is itself a URL, or equals the source URL adds
 * nothing next to the URL: it renders as a single clean entry (the URL
 * alone) instead of "URL — URL".
 */
export function formatSourceEntry(hit: PersonaKnowledgeHit): string {
  const rawTitle = cleanFooterText(typeof hit.title === 'string' ? hit.title : '');
  const label = inertFooterText(typeof hit.sourceLabel === 'string' ? hit.sourceLabel : '', LABEL_MAX_LENGTH);
  const rawUrl =
    typeof hit.sourceUrl === 'string' ? cleanFooterText(hit.sourceUrl).replace(CITATION_MARKER_PATTERN, '[src]') : '';
  const url = SAFE_URL_SCHEME_PATTERN.test(rawUrl)
    ? percentEncodeUrlMarkdownChars(rawUrl.slice(0, URL_MAX_LENGTH))
    : '';
  if (url !== '') {
    if (rawTitle === '' || SAFE_URL_SCHEME_PATTERN.test(rawTitle) || rawTitle === rawUrl) {
      return url;
    }
    return `${inertFooterText(prettifyUrlDerivedTitle(rawTitle), TITLE_MAX_LENGTH)} — ${url}`;
  }
  const title = inertFooterText(prettifyUrlDerivedTitle(rawTitle), TITLE_MAX_LENGTH);
  if (label !== '') {
    return `${title} (${label})`;
  }
  return title;
}

/**
 * Machine markers are host bookkeeping, never prose: strip them all. Also
 * wired as the host's sanitizeAssistantTextForContext hook so assistant
 * messages entering the durable thread context never carry live markers
 * into later turns.
 */
export function stripCitationMarkers(text: string): string {
  return text
    .replace(CITATION_MARKER_PATTERN, '')
    .split('\n')
    .map(line => line.trimEnd())
    .join('\n')
    .trimEnd();
}

/**
 * Which injected passages the answer used: marker present, title named in
 * prose, or distinctive-content overlap. Malformed hits (non-string text or
 * title past the upstream boundary) are skipped — fail open, never fail the
 * turn.
 */
export function findUsedKnowledgeHits(answerText: string, hits: readonly PersonaKnowledgeHit[]): PersonaKnowledgeHit[] {
  const used: PersonaKnowledgeHit[] = [];
  const loweredAnswer = answerText.toLowerCase();
  for (let index = 0; index < hits.length; index += 1) {
    const hit = hits[index];
    if (hit === undefined) {
      continue;
    }
    const title = typeof hit.title === 'string' ? hit.title.trim() : '';
    const passageText = typeof hit.text === 'string' ? hit.text : '';
    if (passageText === '') {
      continue;
    }
    const marked = answerText.includes(knowledgeCitationMarker(index));
    // A bare common word ("Notes") is not evidence of attribution; a real
    // title named in prose is.
    const titled = title.length >= 8 && loweredAnswer.includes(title.toLowerCase());
    if (marked || titled || isPassageUsedInAnswer({ passageText, answerText })) {
      used.push(hit);
    }
  }
  return used;
}

/**
 * Enforces attribution on the final assistant text. Returns the text
 * unchanged when no injected passage was used. Otherwise strips any
 * model-echoed machine markers and appends a single `Sources:` line naming
 * every used passage — so even a model that ignored the citation
 * instruction produces a sourced answer. A model that already named a
 * title in prose still gets the footer: the footer is the canonical
 * machine-readable attribution (uniform shape, always with URL or label),
 * and making its presence depend on prose phrasing would make attribution
 * unpredictable — the opposite of enforcement.
 */
export function repairKnowledgeAttribution(answerText: string, hits: readonly PersonaKnowledgeHit[]): string {
  if (hits.length === 0) {
    return answerText;
  }
  const used = dedupeHitsByDocument(findUsedKnowledgeHits(answerText, hits));
  if (used.length === 0) {
    return answerText;
  }
  const cleaned = stripCitationMarkers(answerText);
  const footer = `Sources: ${used.map(formatSourceEntry).join('; ')}`;
  return cleaned.length === 0 ? footer : `${cleaned}\n\n${footer}`;
}

/** Assistant text part, as the core message schema defines it. */
export type AssistantTextPart = ChatCompletionContentPartText;
/** Assistant refusal part, as the core message schema defines it. */
export type AssistantRefusalPart = ChatCompletionContentPartRefusal;

export type RepairableAssistantContent = string | (AssistantTextPart | AssistantRefusalPart)[] | null | undefined;

/**
 * Applies the attribution repair to a model message's content without
 * disturbing its shape: strings stay strings, refusal parts are never
 * touched, and the `Sources:` footer lands on the last text part. Returns
 * the identical reference when nothing changed, so callers can tell
 * "repaired" from "untouched" by identity.
 */
export function repairAssistantMessageContent(content: string, hits: readonly PersonaKnowledgeHit[]): string;
export function repairAssistantMessageContent(
  content: (AssistantTextPart | AssistantRefusalPart)[],
  hits: readonly PersonaKnowledgeHit[],
): (AssistantTextPart | AssistantRefusalPart)[];
export function repairAssistantMessageContent(
  content: null | undefined,
  hits: readonly PersonaKnowledgeHit[],
): null | undefined;
export function repairAssistantMessageContent(
  content: RepairableAssistantContent,
  hits: readonly PersonaKnowledgeHit[],
): RepairableAssistantContent;
export function repairAssistantMessageContent(
  content: RepairableAssistantContent,
  hits: readonly PersonaKnowledgeHit[],
): RepairableAssistantContent {
  if (hits.length === 0 || content === null || content === undefined) {
    return content;
  }
  if (typeof content === 'string') {
    return repairKnowledgeAttribution(content, hits);
  }
  const fullText = content
    .filter((part): part is AssistantTextPart => part.type === 'text')
    .map(part => part.text)
    .join('\n');
  const used = dedupeHitsByDocument(findUsedKnowledgeHits(fullText, hits));
  if (used.length === 0) {
    return content;
  }
  const footer = `Sources: ${used.map(formatSourceEntry).join('; ')}`;
  let lastTextIndex = -1;
  const parts = content.map((part, index) => {
    if (part.type !== 'text') {
      return part;
    }
    lastTextIndex = index;
    return { ...part, text: stripCitationMarkers(part.text) };
  });
  const last = parts[lastTextIndex];
  if (last?.type !== 'text') {
    return content;
  }
  const withFooter = last.text.length === 0 ? footer : `${last.text}\n\n${footer}`;
  return [...parts.slice(0, lastTextIndex), { ...last, text: withFooter }, ...parts.slice(lastTextIndex + 1)];
}
