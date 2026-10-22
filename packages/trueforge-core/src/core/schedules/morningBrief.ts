import { z } from 'zod';

/**
 * The morning brief prompt and its answer format. The tour card, the demo seed and any schedule the chat
 * creates as a brief all send this text, so every brief asks for the same things in the same order.
 */
export const MORNING_BRIEF_PROMPT =
  'Give me my morning brief. 1. Read everything new since my last brief, or the last 24 hours: all of it, page by page, not just the first few. Then today\'s and the next 7 days\' calendar, the lists in my spaces, and what you remember about me. 2. Write one plain-words digest sentence, then the items, most urgent first. Each item is one thing I can act on. Put anything that may be wrong (a conflict, a likely typo, a date or time that does not match) under check_first. Put replies and choices waiting on me under decision. Put calendar items under coming_up, with their start time. Put a due date under deadline only when it is not already a decision. Each item gets one next step: a label and a target, where the target is a prompt for me to send or an https link. 3. Give the answer as one JSON object in a ```json code block, shaped as {"digest": string, "items": [{"section": "check_first" | "decision" | "coming_up" | "deadline", "title": string, "subtitle": [string, ...], "when": ISO 8601 time with offset (coming_up only), "action": {"label": string, "target": {"kind": "prompt", "text": string} | {"kind": "link", "url": string}}}]}. Keep titles and subtitle parts short. Say where each item came from in its subtitle. Offer next steps, but do not send or save anything without asking me. 4. If something could not be read, leave it out and say so in the digest instead of guessing.';

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
  text: z.string().min(1).max(1000),
});

const BriefLinkTargetSchema = z.object({
  kind: z.literal('link'),
  url: z.url({ protocol: /^https$/ }).max(2000),
});

export const BriefTargetSchema = z.discriminatedUnion('kind', [BriefPromptTargetSchema, BriefLinkTargetSchema]);

export type BriefTarget = z.infer<typeof BriefTargetSchema>;

export const BriefActionSchema = z.object({
  label: z.string().min(1).max(40),
  target: BriefTargetSchema,
});

export type BriefAction = z.infer<typeof BriefActionSchema>;

const BriefItemBaseSchema = z.object({
  title: z.string().min(1).max(160),
  /** Parts joined with " · " when shown, such as an address and a person. */
  subtitle: z.array(z.string().min(1).max(120)).max(4),
  action: BriefActionSchema,
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

const JSON_BLOCK = /```json\s*\n([\s\S]*?)\n```/g;

/**
 * The brief in an answer, from its last ```json block. Null when the block is missing, is not JSON, or does not
 * match the brief shape, so the caller shows the answer as plain text instead.
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
  return parsed.success ? parsed.data : null;
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
