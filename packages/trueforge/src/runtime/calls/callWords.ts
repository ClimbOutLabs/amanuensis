import type { Delivery } from '../../schemas/deliveries';
import { isPlainWords } from '../texts/textWords';
import { CALL_LINES } from './callTurns';

/** The most of a delivery's words a call carries; anything longer stays in the app. */
const CALL_WORDS_MAX = 300;

/**
 * Words that would sound like the call's own lines, a second opening or a closing, so the words cannot pose as the
 * assistant starting or ending the call.
 */
const IMITATES_CALL =
  /\b(good[\s-]?bye|bye|this is|calling (?:for|you)|good time)\b|(?:^|[.!?]\s+)(?:hi|hello|hey|good (?:morning|afternoon|evening))\b/i;

/**
 * A delivery's words as a call may carry them: said aloud after a yes, or given to the call model. Whoever answers
 * hears them, and a model steered by a mail or a page can write a reminder, so they pass the texts' one check for
 * plain words: no number to call, no site and no address. They also must not sound like the call's own opening or
 * goodbye. Undefined when they do not, or are too long to say.
 */
export function callWords(text: string): string | undefined {
  const words = text.replace(/\s+/g, ' ').trim();
  return words !== '' && words.length <= CALL_WORDS_MAX && isPlainWords(words) && !IMITATES_CALL.test(words)
    ? words
    : undefined;
}

/** The line said once the person said yes: what the call is about, or why it is not read out. */
export function messageLine(delivery: Pick<Delivery, 'kind' | 'text'>): string {
  const words = callWords(delivery.text);
  const reminder = delivery.kind === 'reminder';
  if (words === undefined) {
    return `Your ${reminder ? 'reminder' : 'message'} has a number or a link, or is too long, so I will not read it out. It is in the app.`;
  }
  // A lead-in marks where the delivery's own words start, apart from the call's lines.
  return CALL_LINES.message(`${reminder ? 'Here is your reminder' : 'Here is what I called about'}: ${words}`);
}
