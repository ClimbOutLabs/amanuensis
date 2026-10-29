import { FACT_STOPWORDS } from './stopWords';

/**
 * Capitalized words that are not people: the pronoun, calendar words, and common sentence openers.
 * The assistant's own display name is not known at the recall call sites, so it is not excluded here.
 */
const CAPITALIZED_COMMON_WORDS: ReadonlySet<string> = new Set([
  'i',
  'ok',
  'okay',
  'hi',
  'hey',
  'hello',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'mon',
  'tue',
  'tues',
  'wed',
  'thu',
  'thur',
  'thurs',
  'fri',
  'sat',
  'sun',
  'today',
  'tomorrow',
  'yesterday',
]);

/** Names past this many are ignored, so one long message cannot make every candidate expensive to check. */
const MAX_NAMED_PEOPLE = 15;

/**
 * Names of people the message mentions: capitalized words that do not open a sentence and are not
 * common words. "Hi June, remember Wendy's is coming up" yields Wendy: "Hi" opens the sentence
 * and June is a month, like "I", other months and weekdays.
 */
export function namedPeopleInMessage(message: string): string[] {
  const names: string[] = [];
  for (const match of message.matchAll(/[A-Z][a-z]+(?![A-Za-z])/g)) {
    const word = match[0];
    const index = match.index;
    const previous = index === 0 ? '' : message.slice(index - 1, index);
    const insideWord = /[A-Za-z'’]/.test(previous);
    const before = message.slice(0, index).replace(/[ \t]+$/, '');
    const opensSentence = before === '' || /[.!?\n]$/.test(before);
    if (insideWord || opensSentence) {
      continue;
    }
    const lower = word.toLowerCase();
    if (CAPITALIZED_COMMON_WORDS.has(lower) || FACT_STOPWORDS.has(lower)) {
      continue;
    }
    if (!names.includes(word)) {
      names.push(word);
      if (names.length === MAX_NAMED_PEOPLE) {
        break;
      }
    }
  }
  return names;
}

/** One pattern for all names; they are letters only, so none needs escaping. */
function namesPattern(names: readonly string[]): RegExp {
  return new RegExp(`(^|[^A-Za-z])(?:${names.join('|')})(?=[^a-z]|$)`);
}

/**
 * Moves every candidate that names a person from `message` ahead of those that do not, keeping
 * each group's order. A short note about the exact person asked about must not lose to long
 * background notes that happen to share more words with the question.
 */
export function rankNamedPeopleFirst<T extends { text: string }>({
  candidates,
  message,
}: {
  candidates: readonly T[];
  message: string;
}): T[] {
  const names = namedPeopleInMessage(message);
  if (names.length === 0) {
    return [...candidates];
  }
  const pattern = namesPattern(names);
  const named: T[] = [];
  const rest: T[] = [];
  for (const candidate of candidates) {
    (pattern.test(candidate.text) ? named : rest).push(candidate);
  }
  return [...named, ...rest];
}
