import { namesContactDetail } from '@truefoundry/trueforge-core/core/permissions/provenance';

import type { Delivery, DeliveryKind } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';

/** Said wherever texts are asked for on a server that has no Twilio details. */
export const TEXTS_NOT_SET_UP =
  'Texts are not set up on this server. To set them up, follow the Text messages page in the Aman docs.';

/** Two text segments of plain characters. A longer message is cut at a word and ends with three dots. */
const TEXT_MAX = 306;

/** Characters that would make the phone company send the whole text in its costlier long form, and what stands in. */
const STAND_INS: Record<string, string> = {
  '‘': "'",
  '’': "'",
  '`': "'",
  '“': '"',
  '”': '"',
  '–': '-',
  '—': '-',
  '~': '-',
  '…': '...',
  '{': '(',
  '}': ')',
  '[': '(',
  ']': ')',
  '|': '/',
  '\\': '/',
};

/**
 * The text in characters that each take one place in a text message: accents are dropped, quotes and dashes become
 * plain ones, and anything else outside that set, such as an emoji, is left out.
 */
export function plainText(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .replace(/[‘’`“”–—~…{}[\]|\\]/g, char => STAND_INS[char] ?? '')
    .replace(/[^\x20-\x7E]|\^/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * What a Private text says: only the kind of thing. It never carries a name, an amount or any content, because a
 * text can show on a locked screen and travels through the phone company.
 */
export function privatePhrase(kind: DeliveryKind): string {
  switch (kind) {
    case 'reminder':
      return 'a reminder is due';
    case 'note':
      return 'a note is waiting';
    case 'nudge':
      return 'something needs you';
    case 'approval_waiting':
      return 'something is waiting for your ok';
  }
}

export function privateText({ name, kind }: { name: string; kind: DeliveryKind }): string {
  return `${name}: ${privatePhrase(kind)}. Open the app to see it.`;
}

function cut({ text, room }: { text: string; room: number }): string {
  if (text.length <= room) {
    return text;
  }
  const head = text.slice(0, room - 3);
  const space = head.lastIndexOf(' ');
  return `${(space > room / 2 ? head.slice(0, space) : head).trimEnd()}...`;
}

const MONTH = '(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?';
/** Times and dates written the usual ways, the only places Full words may hold digits. */
const TIME_AND_DATE_SHAPES = [
  /\b\d{1,2}(?::\d{2})?\s?(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi,
  /\b\d{1,2}:\d{2}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/(?:\d{4}|\d{2}))?\b/g,
  new RegExp(`\\b\\d{1,2}(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH}(?:,?\\s+\\d{4})?\\b`, 'gi'),
  new RegExp(`\\b${MONTH}\\s+\\d{1,2}(?:st|nd|rd|th)?(?:,?\\s+\\d{4})?\\b`, 'gi'),
];
/** Words that read out a site or a number: a spoken dot or slash, a web cue, or a number said in words. */
const SPOKEN_DETAIL =
  /\b(?:dot|slash|backslash|www|http|https|url|com|net|org|google|hundred|thousand|(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)(?:[\s,-]+(?:zero|oh|one|two|three|four|five|six|seven|eight|nine)){2,})\b/i;

/**
 * Whether Full words could carry a number to call, a site or an address, judged by whole classes rather than by
 * known spellings: any digit outside a time or a date, a slash or an at sign, a dot or a dash inside a word, single
 * letters in a row, or a site or a number read out in words. Ordinary words pass; a false alarm only costs the
 * reminder's own words, which stay in the app.
 */
function mayCarryContactDetail(plain: string): boolean {
  const rest = TIME_AND_DATE_SHAPES.reduce((text, shape) => text.replace(shape, ' '), plain);
  return (
    /\d/.test(rest) ||
    /[/@]/.test(rest) ||
    /[a-z0-9][.\-_][a-z0-9]/i.test(rest) ||
    /(?<![a-z0-9])[a-z](?:[\s.,_-]+[a-z])+(?![a-z0-9])/i.test(rest) ||
    SPOKEN_DETAIL.test(rest)
  );
}

/** Why a Full text went out in Private words instead, or null when it carried the item's own words. */
export type FullWithheld = 'noticed' | 'contact_detail' | null;

/**
 * Kinds whose words a person or Aman itself wrote: a reminder the person asked for, and a test. What the assistant
 * noticed is worded by the model, and those words stay in the app, so a text names only its kind.
 */
const OWN_WORDS_KINDS: ReadonlySet<DeliveryKind> = new Set(['reminder', 'note']);

/**
 * The text that goes out for a delivery, given the name already made fit for a text. Full carries the item's words
 * only for a reminder or a test; anything noticed goes out in Private words. Words that could hold a link, a site, a
 * phone number or an address also go out in Private words, since a text is where a link or a number to call does the
 * most harm.
 */
export function textBody({ name, delivery, mode }: { name: string; delivery: Delivery; mode: TextMode }): {
  body: string;
  withheld: FullWithheld;
} {
  const privateBody = privateText({ name, kind: delivery.kind });
  if (mode === 'private') {
    return { body: privateBody, withheld: null };
  }
  if (!OWN_WORDS_KINDS.has(delivery.kind)) {
    return { body: privateBody, withheld: 'noticed' };
  }
  const plain = plainText(delivery.text);
  if (mayCarryContactDetail(plain) || namesContactDetail([delivery.text, plain])) {
    return { body: privateBody, withheld: 'contact_detail' };
  }
  const prefix = `${name}: `;
  return { body: `${prefix}${cut({ text: plain, room: TEXT_MAX - prefix.length })}`, withheld: null };
}

/** The code text. It carries no name the person chose, because it goes to a number nobody has proved yet. */
export function codeText(code: string): string {
  return `Your confirmation code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`;
}
