import type { Delivery } from '../../schemas/deliveries';
import { isPlainWords } from '../texts/textWords';
import { CALL_LINES } from './callTurns';

/** The most of a delivery's words a call carries; anything longer stays in the app. */
const CALL_WORDS_MAX = 300;

/**
 * A delivery's words as a call may carry them: said aloud after a yes, or given to the call model. Whoever answers
 * hears them, and a model steered by a mail or a page can write a reminder, so they pass the texts' one check for
 * plain words: no number to call, no site and no address. Undefined when they do not, or are too long to say.
 */
export function callWords(text: string): string | undefined {
  const words = text.replace(/\s+/g, ' ').trim();
  return words !== '' && words.length <= CALL_WORDS_MAX && isPlainWords(words) ? words : undefined;
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
