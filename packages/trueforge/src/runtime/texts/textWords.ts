import type { Delivery, DeliveryKind } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';

/** Said wherever texts are asked for on a server that has no Twilio details. */
export const TEXTS_NOT_SET_UP =
  'Texts are not set up on this server. To set them up, add the Twilio details to the settings file and restart Aman.';

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

/** The text that goes out for a delivery, given the name already made fit for a text. */
export function textBody({ name, delivery, mode }: { name: string; delivery: Delivery; mode: TextMode }): string {
  if (mode === 'private') {
    return privateText({ name, kind: delivery.kind });
  }
  const prefix = `${name}: `;
  return `${prefix}${cut({ text: plainText(delivery.text), room: TEXT_MAX - prefix.length })}`;
}

/** The code text. It carries no name the person chose, because it goes to a number nobody has proved yet. */
export function codeText(code: string): string {
  return `Your confirmation code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`;
}
