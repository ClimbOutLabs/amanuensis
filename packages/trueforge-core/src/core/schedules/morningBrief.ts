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

const JSON_BLOCK = /```json[^\S\n]*\n?([\s\S]*?)```/g;

/** Sources the model sometimes writes as a bare subtitle part (often in italics) instead of the source field. */
const SOURCE_WORDS = new Set(['email', 'mail', 'gmail', 'calendar', 'web', 'memory', 'space', 'spaces', 'notes']);

/**
 * Inline markdown removed from one line of brief text, so no `**`, `*`, `_`, backticks or link brackets show.
 * Rows have no room for emphasis, so stripping is simpler and steadier than rendering it.
 */
export function plainBriefText(text: string): string {
  return text
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]/g, '$1')
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

const SENTENCE_END = /[.!?]["')\]]?(?=\s|$)/g;

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
    if (end <= max) {
      sentenceEnd = end;
    }
  }
  if (sentenceEnd >= max / 2) {
    return digest.slice(0, sentenceEnd);
  }
  const room = digest.slice(0, max - 1);
  const lastSpace = room.search(/\s\S*$/);
  const cut = lastSpace > 0 ? room.slice(0, lastSpace) : room;
  return `${cut.replace(/[\s,;:-]+$/, '')}…`;
}

/**
 * The brief in an answer, from its last complete ```json block, with markdown stripped from what shows. Each item
 * is checked on its own: one that does not fit the shape is left out and counted in `omittedCount`, and a digest
 * over the display length is shortened. Null when the block is missing or unfinished, is not JSON, or has no usable
 * digest, so the caller shows the answer as plain text instead.
 */
export function parseMorningBrief(answer: string): ReadBrief | null {
  const blocks = [...answer.matchAll(JSON_BLOCK)];
  const last = blocks.at(-1)?.[1];
  if (last === undefined) {
    return null;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(last);
  } catch {
    return null;
  }
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
 * The words of an answer that holds a brief that could not be drawn, with the JSON removed and markdown stripped,
 * so a person never reads raw JSON. Null when the answer holds no JSON, which the caller shows as it is.
 */
export function unreadableBriefText(answer: string): string | null {
  const withoutBlocks = answer.replace(JSON_BLOCK, '').replace(/```json[\s\S]*$/, '');
  const bare = /^\s*[{[]/.test(withoutBlocks);
  if (withoutBlocks === answer && !bare) {
    return null;
  }
  const lines = bare ? [] : withoutBlocks.split('\n').map(plainBriefText);
  return lines.filter(line => line !== '').join('\n');
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
