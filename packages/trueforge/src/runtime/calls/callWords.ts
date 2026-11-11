import type { Delivery } from '../../schemas/deliveries';
import { checkedWords } from '../texts/textWords';
import { CALL_LINES } from './callTurns';

/** The most of a delivery's words a call carries; anything longer stays in the app. */
const CALL_WORDS_MAX = 300;

/**
 * Words that would sound like the call's own lines, a greeting, a farewell or the call's opening, so the words cannot
 * pose as the assistant starting or ending the call. A greeting anywhere counts: the lead-in is the one line between
 * the call's words and a delivery's.
 */
const IMITATES_CALL =
  /\b(?:hi|hiya|hello|hey|heya|howdy|greetings|good[\s-]?(?:morning|afternoon|evening|day)|farewell|good[\s-]?bye|bye|so long|take care|this is|calling (?:for|you)|good time)\b/;

/** The long phrases again with every space and mark taken out, so "g o o d - b y e" is the same as "goodbye". */
const IMITATES_CALL_SQUASHED = /goodbye|farewell|greetings|thisis|callingfor|callingyou|goodtime|takecare|solong/;

/** Letters from other alphabets that look like a Latin one, which a spoken word would not tell apart. */
const LOOKALIKES: Record<string, string> = {
  Η: 'h',
  Ι: 'i',
  Α: 'a',
  Β: 'b',
  Ε: 'e',
  Κ: 'k',
  Μ: 'm',
  Ν: 'n',
  Ο: 'o',
  Ρ: 'p',
  Τ: 't',
  Χ: 'x',
  Υ: 'y',
  Ζ: 'z',
  ι: 'i',
  ο: 'o',
  α: 'a',
  ν: 'v',
  ρ: 'p',
  х: 'x',
  а: 'a',
  е: 'e',
  о: 'o',
  р: 'p',
  с: 'c',
  у: 'y',
  і: 'i',
  ј: 'j',
  һ: 'h',
  н: 'h',
  к: 'k',
  т: 't',
  м: 'm',
  в: 'b',
  Н: 'h',
  Е: 'e',
  О: 'o',
  Р: 'p',
  С: 'c',
  А: 'a',
  В: 'b',
  К: 'k',
  М: 'm',
  Т: 't',
  Х: 'x',
  І: 'i',
};

/** Decided on the words as sent: as they are, with look-alike letters and accents folded away, and squashed. */
function soundsLikeTheCall(text: string): boolean {
  const lowered = text.toLowerCase();
  const folded = text
    .normalize('NFKD')
    .replace(/[\u0300-\u036f\u00ad\u200b-\u200f\u2060\ufeff]/g, '')
    .replace(/./gu, letter => LOOKALIKES[letter] ?? letter)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ');
  const squashed = folded.replace(/[^a-z]/g, '');
  return IMITATES_CALL.test(lowered) || IMITATES_CALL.test(folded) || IMITATES_CALL_SQUASHED.test(squashed);
}

/**
 * A delivery's words as a call may carry them: said aloud after a yes, or given to the call model. Whoever answers
 * hears them, and a model steered by a mail or a page can write a reminder, so they pass the texts' one check for
 * plain words: no number to call, no site and no address. They also must not sound like the call's own greeting,
 * opening or goodbye. Undefined when they do not, or are too long to say.
 */
export function callWords(text: string): string | undefined {
  if (soundsLikeTheCall(text)) {
    return undefined;
  }
  // The words are checked as the call will say them: as given, and again after the texts' cleaning, which drops
  // accents and signs a voice could say differently. What is returned is that cleaned form.
  const words = checkedWords({ text: text.replace(/\s+/g, ' ').trim(), room: Number.MAX_SAFE_INTEGER });
  return words !== undefined && words !== '' && words.length <= CALL_WORDS_MAX && !soundsLikeTheCall(words)
    ? words
    : undefined;
}

/** The line said once the person said yes: what the call is about, or why it is not read out. */
export function messageLine(delivery: Pick<Delivery, 'kind' | 'text'>): string {
  const words = callWords(delivery.text);
  const reminder = delivery.kind === 'reminder';
  if (words === undefined) {
    return `Your ${reminder ? 'reminder' : 'message'} is not something I read out on the phone. It is in the app.`;
  }
  // A lead-in marks where the delivery's own words start, apart from the call's lines.
  return CALL_LINES.message(`${reminder ? 'Here is your reminder' : 'Here is what I called about'}: ${words}`);
}
