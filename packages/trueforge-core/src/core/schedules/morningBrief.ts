import { z } from 'zod';

/**
 * The length limits of a brief. The prompt states them and the schema enforces them, so they cannot drift apart.
 * `digest` is a display length: a longer digest is shortened, not refused. `digestCeiling` only guards against abuse.
 */
export const BRIEF_LIMITS = {
  digest: 240,
  digestCeiling: 4000,
  items: 40,
  title: 160,
  subtitleParts: 4,
  subtitlePart: 120,
  actionLabel: 40,
  promptText: 1000,
  source: 24,
} as const;

/**
 * The morning brief prompt and its answer format. The tour card, the demo seed and any schedule the chat
 * creates as a brief all send this text, so every brief asks for the same things in the same order.
 */
export const MORNING_BRIEF_PROMPT = `Give me my morning brief. 1. Read everything new since my last brief, or the last 24 hours: all of it, page by page, not just the first few. Then today's and the next 7 days' calendar, the lists in my spaces, and what you remember about me. 2. Write one plain-words digest sentence of at most ${String(BRIEF_LIMITS.digest)} characters, then the items, most urgent first, at most ${String(BRIEF_LIMITS.items)} of them. Each item is one thing I can act on. Put anything that may be wrong (a conflict, a likely typo, a date or time that does not match) under check_first. Put replies and choices waiting on me under decision. Put calendar items under coming_up, with their start time. Put a due date under deadline only when it is not already a decision. Each item gets one next step: a label and a target, where the target is a prompt for me to send. 3. Give the answer as one JSON object in a \`\`\`json code block, shaped as {"digest": string, "items": [{"section": "check_first" | "decision" | "coming_up" | "deadline", "title": string, "subtitle": [string, ...], "source": "email" | "calendar" | "web" | "memory" | "space", "when": ISO 8601 time with offset (coming_up only), "action": {"label": string, "target": {"kind": "prompt", "text": string}}}]}. Keep these limits, because an item over a limit is left out of the brief: a title is at most ${String(BRIEF_LIMITS.title)} characters; a subtitle has at most ${String(BRIEF_LIMITS.subtitleParts)} parts of at most ${String(BRIEF_LIMITS.subtitlePart)} characters each; an action label is at most ${String(BRIEF_LIMITS.actionLabel)} characters; a prompt text is at most ${String(BRIEF_LIMITS.promptText)} characters; a source is at most ${String(BRIEF_LIMITS.source)} characters. Write titles and subtitle parts in plain text with no markdown. Say where each item came from in its source. Offer next steps, but do not send or save anything without asking me. 4. If something could not be read, leave it out and say so in the digest instead of guessing.`;

const MORNING_BRIEF_OPENING = 'Give me my morning brief.';

/** Whether a user message is a morning brief request, by the opening that every brief prompt shares. */
export function isMorningBriefPrompt(text: string): boolean {
  return text.startsWith(MORNING_BRIEF_OPENING);
}

export const BRIEF_SECTION_VALUES = ['check_first', 'decision', 'coming_up', 'deadline'] as const;

export const BriefSectionSchema = z.enum(BRIEF_SECTION_VALUES);

export type BriefSection = z.infer<typeof BriefSectionSchema>;

const BriefPromptTargetSchema = z.object({
  kind: z.literal('prompt'),
  text: z.string().min(1).max(BRIEF_LIMITS.promptText),
});

const BriefLinkTargetSchema = z.object({
  kind: z.literal('link'),
  url: z.url({ protocol: /^https$/ }).max(2000),
});

const BriefTargetSchema = z.discriminatedUnion('kind', [BriefPromptTargetSchema, BriefLinkTargetSchema]);

const BriefActionSchema = z.object({
  label: z.string().min(1).max(BRIEF_LIMITS.actionLabel),
  target: BriefTargetSchema,
});

const BriefItemBaseSchema = z.object({
  title: z.string().min(1).max(BRIEF_LIMITS.title),
  /** Parts joined with " · " when shown, such as an address and a person. */
  subtitle: z.array(z.string().min(1).max(BRIEF_LIMITS.subtitlePart)).max(BRIEF_LIMITS.subtitleParts),
  action: BriefActionSchema,
  /** Where the item came from, shown as a small label: email, calendar, web. */
  source: z.string().min(1).max(BRIEF_LIMITS.source).optional(),
  when: z.iso.datetime({ offset: true }).optional(),
});

export const BriefItemSchema = z.discriminatedUnion('section', [
  BriefItemBaseSchema.extend({ section: z.literal('check_first') }),
  BriefItemBaseSchema.extend({ section: z.literal('decision') }),
  BriefItemBaseSchema.extend({ section: z.literal('coming_up') }),
  BriefItemBaseSchema.extend({ section: z.literal('deadline') }),
]);

export type BriefItem = z.infer<typeof BriefItemSchema>;

export const MorningBriefSchema = z.object({
  digest: z.string().min(1).max(BRIEF_LIMITS.digestCeiling),
  items: z.array(BriefItemSchema).max(BRIEF_LIMITS.items),
});

export type MorningBrief = z.infer<typeof MorningBriefSchema>;

/** The answer's outer shape. Each item is checked on its own, so one bad item cannot refuse the rest. */
const BriefAnswerSchema = MorningBriefSchema.extend({ items: z.array(z.unknown()) });

/** A brief ready to show, and how many items in the answer were left out because they did not fit the shape. */
export interface ReadBrief {
  brief: MorningBrief;
  omittedCount: number;
}

/**
 * The most of an answer that is read for JSON. The longest valid brief is far shorter, so this only bounds the
 * work a huge or hostile answer can cost.
 */
const SCAN_LIMIT = BRIEF_LIMITS.digestCeiling * 64;

/** A stretch of an answer that is JSON. `parsed` is null when it was cut off or broken. */
interface JsonSpan {
  start: number;
  end: number;
  parsed: { value: unknown } | null;
}

interface TextRange {
  start: number;
  end: number;
}

/** A bare `{` still waiting for its `}`, with the objects already closed inside it. */
interface OpenObject {
  start: number;
  children: TextRange[];
}

/** The value of text that is a JSON object or list, or null when it is anything else, such as "[Note] hello". */
function parseJsonContainer(text: string): { value: unknown } | null {
  if (!/^\s*[{[]/.test(text)) {
    return null;
  }
  try {
    return { value: JSON.parse(text) };
  } catch {
    return null;
  }
}

function backtickRun({ text, from }: { text: string; from: number }): number {
  let end = from;
  while (text.charAt(end) === '`') {
    end += 1;
  }
  return end - from;
}

function skipBlanks({ text, from }: { text: string; from: number }): number {
  let end = from;
  while (text.charAt(end) === ' ' || text.charAt(end) === '\t') {
    end += 1;
  }
  return end;
}

/** What follows the opening bracket of a block that is JSON, or JSON that broke off, and not a note in brackets. */
const JSON_START = /^\s*[{[]\s*(?:["\-\d{[\]}]|true\b|false\b|null\b)/;

/** Whether a run of backticks at `at` is followed by a tag and a line break, so it opens a fence instead of closing one. */
function opensFence({ text, at, limit }: { text: string; at: number; limit: number }): boolean {
  let index = at;
  while (/[A-Za-z0-9_-]/.test(text.charAt(index))) {
    index += 1;
  }
  if (index === at) {
    return false;
  }
  index = skipBlanks({ text, from: index });
  return index >= limit || text.charAt(index) === '\n' || text.charAt(index) === '\r';
}

/**
 * Reads the code fence that opens at `start` and returns where reading goes on. The span is set only for a block
 * that parses as JSON or is clearly JSON that broke off: an untagged or json block that opens like JSON, so notes
 * in brackets and code in another language stay text. A backtick inside a JSON string never closes the fence, an
 * unclosed fence runs to the end as in markdown, and a run of backticks that is followed by a tag opens the next
 * fence instead of closing this one.
 */
function readFence({
  text,
  start,
  ticks,
  limit,
  spanLimit,
}: {
  text: string;
  start: number;
  ticks: number;
  limit: number;
  spanLimit: number;
}): { end: number; span: JsonSpan | null } {
  let index = skipBlanks({ text, from: start + ticks });
  const tagStart = index;
  while (/[A-Za-z0-9_-]/.test(text.charAt(index))) {
    index += 1;
  }
  const tag = text.slice(tagStart, index).toLowerCase();
  index = skipBlanks({ text, from: index });
  if (text.charAt(index) === '\r') {
    index += 1;
  }
  if (text.charAt(index) === '\n') {
    index += 1;
  }
  const contentStart = Math.min(index, limit);
  let probe = contentStart;
  while (/\s/.test(text.charAt(probe))) {
    probe += 1;
  }
  const looksJson = JSON_START.test(text.slice(probe, probe + 64));

  let inString = false;
  let closeStart = -1;
  let closeEnd = limit;
  let reopened = false;
  while (index < limit) {
    const char = text.charAt(index);
    if (inString) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      // A JSON string never holds a raw line break, so one means the string was cut off.
      if (char === '"' || char === '\n') {
        inString = false;
      }
    } else if (char === '"' && looksJson) {
      inString = true;
    } else if (char === '`') {
      const run = backtickRun({ text, from: index });
      if (run >= ticks) {
        closeStart = index;
        reopened = opensFence({ text, at: index + run, limit });
        closeEnd = reopened ? index : index + run;
        break;
      }
      index += run;
      continue;
    }
    index += 1;
  }

  const closed = closeStart !== -1 && !reopened;
  const parsed = looksJson
    ? parseJsonContainer(text.slice(contentStart, closeStart === -1 ? limit : closeStart))
    : null;
  const plainTag = tag === '' || tag === 'json';
  const brokenJson = closed ? plainTag && looksJson : tag === 'json' || (tag === '' && looksJson);
  const spanEnd = closeStart === -1 ? spanLimit : closeEnd;
  return { end: closeEnd, span: parsed !== null || brokenJson ? { start, end: spanEnd, parsed } : null };
}

/**
 * Every piece of `text` before `limit` that is JSON: fenced blocks of any tag, and a bare JSON object written after
 * prose. It reads left to right once, so a hostile answer cannot make it slow. Text counts only if it really parses
 * (or is clearly cut off), so words that merely begin with "[" or "{" stay words. A cut-off start is read once more
 * from its last open brace, so a full brief written right after it is still found.
 */
function scanJson({
  text,
  from,
  limit,
  spanLimit,
  canRescan,
}: {
  text: string;
  from: number;
  limit: number;
  spanLimit: number;
  canRescan: boolean;
}): JsonSpan[] {
  const spans: JsonSpan[] = [];
  const open: OpenObject[] = [];
  let inString = false;

  const addIfJson = (range: TextRange) => {
    const parsed = parseJsonContainer(text.slice(range.start, range.end));
    if (parsed !== null) {
      spans.push({ ...range, parsed });
    }
  };

  // An object that will not close is cut-off JSON when it opens like a brief. Otherwise it is prose. Either way
  // the objects that did close inside it are looked at, so a full brief after a broken start is still found.
  const abandon = (end: number) => {
    const deepest = open.at(-1);
    let cutOff = false;
    for (const entry of open) {
      entry.children.forEach(addIfJson);
      if (/^\{\s*"/.test(text.slice(entry.start, entry.start + 32))) {
        spans.push({ start: entry.start, end, parsed: null });
        cutOff = true;
        break;
      }
    }
    if (cutOff && canRescan && deepest !== undefined) {
      spans.push(...scanJson({ text, from: deepest.start + 1, limit: end, spanLimit: end, canRescan: false }));
    }
    open.length = 0;
    inString = false;
  };

  let index = from;
  while (index < limit) {
    const char = text.charAt(index);
    if (inString) {
      if (char === '\\') {
        index += 2;
        continue;
      }
      if (char === '"') {
        inString = false;
      } else if (char === '\n') {
        // A JSON string never holds a raw line break, so this object was cut off here.
        abandon(index);
      }
    } else if (char === '`') {
      // JSON has no backticks outside strings, so an object still open here was cut off.
      abandon(index);
      const run = backtickRun({ text, from: index });
      if (run >= 3) {
        const fence = readFence({ text, start: index, ticks: run, limit, spanLimit });
        if (fence.span !== null) {
          spans.push(fence.span);
        }
        index = fence.end;
      } else {
        index += run;
      }
      continue;
    } else if (char === '{') {
      open.push({ start: index, children: [] });
    } else if (open.length > 0 && char === '"') {
      inString = true;
    } else if (open.length > 0 && char === '}') {
      const entry = open.pop();
      const parent = open.at(-1);
      if (entry !== undefined) {
        const range = { start: entry.start, end: index + 1 };
        if (parent !== undefined) {
          parent.children.push(range);
        } else {
          const parsed = parseJsonContainer(text.slice(range.start, range.end));
          if (parsed === null) {
            entry.children.forEach(addIfJson);
          } else {
            spans.push({ ...range, parsed });
          }
        }
      }
    }
    index += 1;
  }
  abandon(spanLimit);
  return spans.sort((first, second) => first.start - second.start);
}

function findJsonSpans(answer: string): JsonSpan[] {
  const text = answer.slice(0, SCAN_LIMIT);
  return scanJson({ text, from: 0, limit: text.length, spanLimit: answer.length, canRescan: true });
}

/** Sources the model sometimes writes as a bare subtitle part (often in italics) instead of the source field. */
const SOURCE_WORDS = new Set(['email', 'mail', 'gmail', 'calendar', 'web', 'memory', 'space', 'spaces', 'notes']);

/**
 * Links and brackets removed in one left-to-right pass: "[text](url)" and "![text](url)" become the text, and so
 * does "[text]". Looking up the next closing bracket is remembered, so a long line of brackets stays fast.
 */
function stripBrackets(text: string): string {
  const parts: string[] = [];
  // Text before `copied` is already in `parts`; the rest is copied in whole runs when a bracket is replaced.
  let copied = 0;
  let index = 0;
  let nextClose = text.indexOf(']');
  let nextParen = text.indexOf(')');
  const replace = ({ from, inner, to }: { from: number; inner: string; to: number }) => {
    parts.push(text.slice(copied, from), inner);
    copied = to;
    index = to;
  };
  while (index < text.length) {
    const char = text.charAt(index);
    const isImage = char === '!' && text.charAt(index + 1) === '[';
    if (char !== '[' && !isImage) {
      index += 1;
      continue;
    }
    const open = isImage ? index + 1 : index;
    if (nextClose !== -1 && nextClose < open) {
      nextClose = text.indexOf(']', open);
    }
    if (nextClose === -1) {
      index += 1;
      continue;
    }
    const inner = text.slice(open + 1, nextClose);
    const after = nextClose + 1;
    if (text.charAt(after) === '(') {
      if (nextParen !== -1 && nextParen < after) {
        nextParen = text.indexOf(')', after);
      }
      if (nextParen !== -1) {
        replace({ from: index, inner, to: nextParen + 1 });
        continue;
      }
    }
    if (!isImage && inner !== '') {
      replace({ from: index, inner, to: after });
      continue;
    }
    index += 1;
  }
  parts.push(text.slice(copied));
  return parts.join('');
}

/**
 * Inline markdown removed from one line of brief text, so no `**`, `*`, `_`, backticks or link brackets show.
 * Rows have no room for emphasis, so stripping is simpler and steadier than rendering it.
 */
export function plainBriefText(text: string): string {
  return stripBrackets(text)
    .replace(/`([^`]*)`/g, '$1')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|[^\w*])\*(?!\s)([^*]+?)\*(?![\w*])/g, '$1$2')
    .replace(/(^|[^\w])_(?!\s)([^_]+?)_(?!\w)/g, '$1$2')
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|>\s*)/, '')
    .replace(/[*`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The item with markdown stripped from every shown field, and a bare source word in the subtitle moved to `source`. Null when a shown field is only markdown. */
function plainItem(item: BriefItem): BriefItem | null {
  const title = plainBriefText(item.title);
  const label = plainBriefText(item.action.label);
  if (title === '' || label === '') {
    return null;
  }
  let source = item.source === undefined ? undefined : plainBriefText(item.source).toLowerCase() || undefined;
  const subtitle: string[] = [];
  for (const part of item.subtitle) {
    const plain = plainBriefText(part);
    if (plain === '') {
      continue;
    }
    if (source === undefined && SOURCE_WORDS.has(plain.toLowerCase())) {
      source = plain.toLowerCase();
      continue;
    }
    subtitle.push(plain);
  }
  const cleaned = { ...item, title, subtitle, action: { ...item.action, label } };
  if (source === undefined) {
    delete cleaned.source;
  } else {
    cleaned.source = source;
  }
  return cleaned;
}

/** The text cut at a word to fit `max` characters, with "…" after it. Text that already fits is returned as it is. */
function cutAtWord({ text, max }: { text: string; max: number }): string {
  if (text.length <= max) {
    return text;
  }
  // The cut must not split a two-unit character such as an emoji, which would leave half of it before the "…".
  const room = text.slice(0, max - 1).replace(/[\uD800-\uDBFF]$/, '');
  let space = room.length - 1;
  while (space >= 0 && !/\s/.test(room.charAt(space))) {
    space -= 1;
  }
  let end = space > 0 ? space : room.length;
  while (end > 0 && /[\s,;:-]/.test(room.charAt(end - 1))) {
    end -= 1;
  }
  return `${room.slice(0, end)}…`;
}

const SENTENCE_END = /[.!?]["')\]]?(?=\s|$)/g;

/** A common abbreviation before a full stop, such as "Dr." or "e.g.", which does not end a sentence. */
const ABBREVIATION_BEFORE = /(?:^|[\s(])(?:Dr|Mr|Mrs|Ms|St|Jr|Sr|e\.g|i\.e|etc)$/;

/**
 * A digest cut to the display length at the end of a sentence, or else at a word with "…" after it. The digest is
 * a summary line, so a long one is shortened rather than refused: refusing it would hide the whole brief.
 */
function shortenDigest(digest: string): string {
  const max = BRIEF_LIMITS.digest;
  if (digest.length <= max) {
    return digest;
  }
  // One more character is read so a sentence that ends exactly at the limit is seen to end there.
  const window = digest.slice(0, max + 1);
  let sentenceEnd = 0;
  for (const match of window.matchAll(SENTENCE_END)) {
    const end = match.index + match[0].length;
    const isAbbreviation = match[0].startsWith('.') && ABBREVIATION_BEFORE.test(window.slice(0, match.index));
    if (end <= max && !isAbbreviation) {
      sentenceEnd = end;
    }
  }
  if (sentenceEnd >= max / 2) {
    return digest.slice(0, sentenceEnd);
  }
  return cutAtWord({ text: digest, max });
}

/** The brief in one parsed JSON value, or null when its outer shape or digest is unusable. */
function readBriefFrom(raw: unknown): ReadBrief | null {
  const answerShape = BriefAnswerSchema.safeParse(raw);
  if (!answerShape.success) {
    return null;
  }
  const digest = shortenDigest(plainBriefText(answerShape.data.digest));
  if (digest === '') {
    return null;
  }
  const items: BriefItem[] = [];
  for (const candidate of answerShape.data.items.slice(0, BRIEF_LIMITS.items)) {
    const parsed = BriefItemSchema.safeParse(candidate);
    const item = parsed.success ? plainItem(parsed.data) : null;
    if (item !== null) {
      items.push(item);
    }
  }
  return { brief: { digest, items }, omittedCount: answerShape.data.items.length - items.length };
}

/**
 * The brief in an answer, with markdown stripped from what shows. It tries each piece of JSON in the answer, last
 * first, and takes the first that is a brief. Each item is checked on its own: one that does not fit the shape is
 * left out and counted in `omittedCount`, and a digest over the display length is shortened. Null when no piece is
 * a usable brief (none, cut off, or not JSON), so the caller shows the answer as plain text instead.
 */
export function parseMorningBrief(answer: string): ReadBrief | null {
  for (const span of findJsonSpans(answer).reverse()) {
    const read = span.parsed === null ? null : readBriefFrom(span.parsed.value);
    if (read !== null) {
      return read;
    }
  }
  return null;
}

/**
 * The words of an answer that holds a brief that could not be drawn, with every piece of JSON removed and markdown
 * stripped, so a person never reads raw JSON. At most `BRIEF_LIMITS.digestCeiling` characters are kept, cut at a
 * word. Null when the answer holds no JSON, which the caller shows as it is.
 */
export function unreadableBriefText(answer: string): string | null {
  const spans = findJsonSpans(answer);
  if (spans.length === 0) {
    return null;
  }
  let words = '';
  let from = 0;
  for (const span of spans) {
    // A piece found inside a cut-off piece starts before `from`, and its words were already left out.
    if (span.start > from) {
      words += `${answer.slice(from, span.start)}\n`;
    }
    from = Math.max(from, span.end);
  }
  words += answer.slice(from);
  const limit = BRIEF_LIMITS.digestCeiling;
  const lines = words
    .slice(0, limit * 2)
    .replace(/[\uD800-\uDBFF]$/, '')
    .split('\n')
    .map(plainBriefText)
    .filter(line => line !== '');
  return cutAtWord({ text: lines.join('\n'), max: limit });
}

/**
 * The stable key for one brief item, so a completed item stays completed in later briefs. Based on its section
 * and title only: a changed subtitle or time keeps the same key.
 */
export function briefItemKey({ section, title }: { section: BriefSection; title: string }): string {
  const source = `${section}\n${title.trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `bi_${hash.toString(16).padStart(8, '0')}`;
}
