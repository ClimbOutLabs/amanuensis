/**
 * The small pieces every writer of page statements shares: cleaning a line, comparing two lines, finding the
 * current statements that say something, and making a statement with a new id. The chat tools and the note
 * sorter both write through them, so a statement looks the same whoever wrote it.
 */
import { FactMarkerSchema, type FactMarker, type FactSource } from './memoryNotes';
import { neutralizeReservedText, singleLine } from './memoryPageLoader';
import { hasLineBreak, pageFacts, type FactLocation, type MemoryPage, type PageSection } from './memoryPages';
import { foldName } from './pageSlug';
import { FACT_STOPWORDS } from './stopWords';

/** The longest fact or name a writer accepts, in characters. A page line is one short thought. */
export const MAX_FACT_CHARS = 500;
export const MAX_NAME_CHARS = 120;

export type CleanedLine = { ok: true; text: string } | { ok: false; message: string };

/**
 * One line of plain text that can stand as a fact or a name. Line breaks and hidden-comment marks are refused,
 * invisible characters are dropped, and the host's reserved drafting lines are refused rather than changed, so
 * a saved line is exactly what was said.
 */
export function cleanLine({ raw, what, limit }: { raw: string; what: string; limit: number }): CleanedLine {
  if (hasLineBreak(raw)) {
    return {
      ok: false,
      message: `Nothing was saved. The ${what} must be one line. Remove the line breaks and try again.`,
    };
  }
  const text = singleLine(raw.replace(/\t/g, ' ')).replace(/ {2,}/g, ' ');
  if (text === '') {
    return { ok: false, message: `Nothing was saved. The ${what} was empty. Write a few words and try again.` };
  }
  if (text.includes('<!--') || text.includes('-->')) {
    return {
      ok: false,
      message: `Nothing was saved. The ${what} cannot contain "<!--" or "-->". Remove them and try again.`,
    };
  }
  if (neutralizeReservedText(text) !== text) {
    return {
      ok: false,
      message: `Nothing was saved. The ${what} contains words the host keeps for itself. Say it in other words and try again.`,
    };
  }
  if (text.length > limit) {
    return {
      ok: false,
      message: `Nothing was saved. The ${what} is too long. Shorten it to one short line and try again.`,
    };
  }
  return { ok: true, text };
}

/** Two lines of text are the same fact when only case, accents and spacing differ. */
export function sameText({ a, b }: { a: string; b: string }): boolean {
  return foldName(a).replace(/\s+/g, ' ').trim() === foldName(b).replace(/\s+/g, ' ').trim();
}

/** A line as its folded words, split the way names are compared: punctuation is spacing. */
function foldedWords(text: string): string[] {
  return foldName(text)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .split(' ')
    .filter(token => token !== '');
}

/** Numbers a line states as words; a line also states its digits. Two lines that disagree on a number differ. */
const NUMBER_WORDS: ReadonlySet<string> = new Set([
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
  'hundred',
  'thousand',
  'million',
  'dozen',
]);

function numbersIn(words: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const word of words) {
    if (/^\d+$/.test(word) || NUMBER_WORDS.has(word)) {
      found.add(word);
    }
  }
  return found;
}

function sameMembers({ a, b }: { a: ReadonlySet<string>; b: ReadonlySet<string> }): boolean {
  return a.size === b.size && [...a].every(member => b.has(member));
}

/**
 * Whether two lines say the same fact in nearly the same words, not only in identical ones. The content words
 * of the two lines, the words that are left once the grammar words are dropped, must largely be the same set:
 * at least three shared, nearly all of the smaller line's words in the other, and at least half of the words
 * of the two together shared. The shared words must also come in the same order in both lines: one fact
 * phrased for two pages, with its subject and its setting swapped around, is two lines about one fact, not
 * one line copied. A line that states a number the other does not, as a digit or as a word, is a different
 * fact however close the rest is, so a changed fee or a moved date is never read as a copy.
 */
export function nearlySameText({ a, b }: { a: string; b: string }): boolean {
  if (sameText({ a, b })) {
    return true;
  }
  const wordsA = foldedWords(a);
  const wordsB = foldedWords(b);
  const numbersA = numbersIn(wordsA);
  const numbersB = numbersIn(wordsB);
  if (numbersA.size > 0 && numbersB.size > 0 && !sameMembers({ a: numbersA, b: numbersB })) {
    return false;
  }
  const contentA = new Set(wordsA.filter(word => !FACT_STOPWORDS.has(word)));
  const contentB = new Set(wordsB.filter(word => !FACT_STOPWORDS.has(word)));
  if (contentA.size === 0 || contentB.size === 0) {
    return false;
  }
  let shared = 0;
  for (const word of contentA) {
    if (contentB.has(word)) {
      shared += 1;
    }
  }
  const together = contentA.size + contentB.size - shared;
  if (shared < 3 || shared / Math.min(contentA.size, contentB.size) < 0.85 || shared / together < 0.5) {
    return false;
  }
  const inOrderA = wordsA.filter(word => !FACT_STOPWORDS.has(word) && contentB.has(word));
  const inOrderB = wordsB.filter(word => !FACT_STOPWORDS.has(word) && contentA.has(word));
  return inOrderA.length === inOrderB.length && inOrderA.every((word, index) => word === inOrderB[index]);
}

/** The current facts on a page (anything not already under Earlier) whose text is this text. */
export function currentFactsSaying({ page, text }: { page: MemoryPage; text: string }): FactLocation[] {
  return pageFacts(page).filter(at => at.section.name !== 'Earlier' && sameText({ a: at.fact.text, b: text }));
}

/** A fact id no fact on the page uses yet. */
export function uniqueFactId({ page, newId }: { page: MemoryPage; newId: () => string }): string {
  const taken = new Set(pageFacts(page).map(({ fact }) => fact.marker.id));
  let id = newId();
  while (taken.has(id)) {
    id = newId();
  }
  return id;
}

/** A statement ready to add: its text and a marker with its source and days. */
export function statementWith({
  text,
  id,
  src,
  since,
  until,
  seen,
  receipt,
}: {
  text: string;
  id: string;
  src: FactSource;
  since?: FactMarker['since'];
  until?: FactMarker['until'];
  seen?: FactMarker['seen'];
  receipt?: FactMarker['receipt'];
}): { text: string; marker: FactMarker } {
  return {
    text,
    marker: FactMarkerSchema.parse({
      kind: 'fact',
      ...(receipt === undefined ? {} : { receipt }),
      id,
      src,
      ...(since === undefined ? {} : { since }),
      ...(until === undefined ? {} : { until }),
      ...(seen === undefined ? {} : { seen }),
    }),
  };
}

/** The section a fact that is being replaced goes back to: its own, except where a confirmed fact does not belong. */
export function sectionAfterChange(at: FactLocation): PageSection {
  const { name } = at.section;
  return name === undefined || name === 'Unconfirmed' ? 'Now' : name;
}
