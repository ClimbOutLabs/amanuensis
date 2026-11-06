import { namesContactDetail } from '@truefoundry/trueforge-core/core/permissions/provenance';

import type { DeliveryKind } from '../../schemas/deliveries';
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
function privatePhrase(kind: DeliveryKind): string {
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

/**
 * The text that goes out for a delivery, given the name already made fit for a text, and the words it was sent in.
 * Full carries the delivery's notice words, never the model's own wording, which only the feed shows. Those words can
 * still quote mail someone else wrote, such as a subject, so a message that names a link, a site, a phone number or
 * an address, in any spelling, goes out in Private words, since a text is where a link or a number to call does the
 * most harm.
 */
export function textBody({
  name,
  kind,
  notice_text,
  mode,
}: {
  name: string;
  kind: DeliveryKind;
  notice_text: string;
  mode: TextMode;
}): { body: string; sent_as: TextMode } {
  const plain = plainText(notice_text);
  if (mode === 'private' || namesContactDetail([notice_text, plain])) {
    return { body: privateText({ name, kind }), sent_as: 'private' };
  }
  const prefix = `${name}: `;
  return { body: `${prefix}${cut({ text: plain, room: TEXT_MAX - prefix.length })}`, sent_as: 'full' };
}

/** The code text. It carries no name the person chose, because it goes to a number nobody has proved yet. */
export function codeText(code: string): string {
  return `Your confirmation code is ${code}. It works for 10 minutes. If you did not ask for it, ignore this text.`;
}
