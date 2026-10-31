import { z } from 'zod';

/**
 * The morning brief prompt and its answer format. The demo seed and any schedule the chat creates as a
 * brief send this text, so every scheduled brief asks for the same things in the same order. The tour card
 * sends MORNING_BRIEF_CARD_PROMPT instead: the same asks in plain words, with no format in it.
 */
export const MORNING_BRIEF_PROMPT =
  'Give me my morning brief. 1. Read everything new since my last brief, or the last 24 hours: all of it, page by page, not just the first few. Then today\'s and the next 7 days\' calendar, the lists in my spaces, and what you remember about me. 2. Write one plain-words digest sentence, then the items, most urgent first. Each item is one thing I can act on. Put anything that may be wrong (a conflict, a likely typo, a date or time that does not match) under check_first. Put replies and choices waiting on me under decision. Put calendar items under coming_up, with their start time. Put a due date under deadline only when it is not already a decision. Each item gets one next step: a label and a target, where the target is a prompt for me to send. 3. Give the answer as one JSON object in a ```json code block, shaped as {"digest": string, "items": [{"section": "check_first" | "decision" | "coming_up" | "deadline", "title": string, "subtitle": [string, ...], "source": "email" | "calendar" | "web" | "memory" | "space", "when": ISO 8601 time with offset (coming_up only), "action": {"label": string, "target": {"kind": "prompt", "text": string}}}]}. Keep titles and subtitle parts short, in plain text with no markdown. Say where each item came from in its source. Offer next steps, but do not send or save anything without asking me. 4. If something could not be read, leave it out and say so in the digest instead of guessing.';

const MORNING_BRIEF_OPENING = 'Give me my morning brief.';

/** Whether a user message is a morning brief request, by the opening that every brief prompt shares. */
export function isMorningBriefPrompt(text: string): boolean {
  return text.startsWith(MORNING_BRIEF_OPENING);
}

/** The name the seeded brief schedule goes by; resource names are lowercase and hyphenated. */
export const MORNING_BRIEF_SCHEDULE_NAME = 'morning-brief';

/** Whether a schedule is the owner's daily brief: it carries the brief name, or its task is a brief request. */
export function isMorningBriefSchedule({ name, task }: { name: string; task: string }): boolean {
  return name === MORNING_BRIEF_SCHEDULE_NAME || isMorningBriefPrompt(task);
}

/**
 * What the home's morning brief card sends: the contract's asks in the plain words a person would say,
 * with no output format in it. It shares the contract's opening, so the chat still treats it as a brief;
 * the answer shows as plain text when it comes back as prose instead of the contract's JSON.
 */
export const MORNING_BRIEF_CARD_PROMPT =
  `${MORNING_BRIEF_OPENING} Read everything new since my last brief, or from the last 24 hours: my email, ` +
  `today's and the next 7 days' calendar, the lists in my spaces, and what you remember about me. Start ` +
  `with one sentence that sums up the morning, then the items, most urgent first, each one a single thing ` +
  `I can act on. Point out anything that may be wrong, like a clash, a likely typo, or a date or time that ` +
  `does not match. Show the replies and choices waiting on me, the start time of anything on my calendar, ` +
  `and anything that has a due date. If something could not be read, say so in the first sentence instead ` +
  `of guessing. Offer next steps, but do not send or save anything without asking me.`;

export const BRIEF_SECTION_VALUES = ['check_first', 'decision', 'coming_up', 'deadline'] as const;

export const BriefSectionSchema = z.enum(BRIEF_SECTION_VALUES);

export type BriefSection = z.infer<typeof BriefSectionSchema>;

const BriefPromptTargetSchema = z.object({
  kind: z.literal('prompt'),
  text: z.string().min(1).max(1000),
});

const BriefLinkTargetSchema = z.object({
  kind: z.literal('link'),
  url: z.url({ protocol: /^https$/ }).max(2000),
});

const BriefTargetSchema = z.discriminatedUnion('kind', [BriefPromptTargetSchema, BriefLinkTargetSchema]);

const BriefActionSchema = z.object({
  label: z.string().min(1).max(40),
  target: BriefTargetSchema,
});

const BriefItemBaseSchema = z.object({
  title: z.string().min(1).max(160),
  /** Parts joined with " · " when shown, such as an address and a person. */
  subtitle: z.array(z.string().min(1).max(120)).max(4),
  action: BriefActionSchema,
  /** Where the item came from, shown as a small label: email, calendar, web. */
  source: z.string().min(1).max(24).optional(),
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
  digest: z.string().min(1).max(240),
  items: z.array(BriefItemSchema).max(40),
});

export type MorningBrief = z.infer<typeof MorningBriefSchema>;

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

/** The brief with markdown stripped from every shown field, and a bare source word in the subtitle moved to `source`. */
function plainBrief(brief: MorningBrief): MorningBrief | null {
  const items: BriefItem[] = [];
  for (const item of brief.items) {
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
    items.push(cleaned);
  }
  const digest = plainBriefText(brief.digest);
  return digest === '' ? null : { digest, items };
}

/**
 * The brief in an answer, from its last complete ```json block, with markdown stripped from what shows. Null when
 * the block is missing or unfinished, is not JSON, or does not match the brief shape, so the caller shows the
 * answer as plain text instead.
 */
export function parseMorningBrief(answer: string): MorningBrief | null {
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
  const parsed = MorningBriefSchema.safeParse(raw);
  return parsed.success ? plainBrief(parsed.data) : null;
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
