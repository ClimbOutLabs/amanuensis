/**
 * The one place that decides whether a stored note may be recalled at all: it must not come from the
 * chat being answered, and it must match the question well enough to be worth the model's attention.
 * Ranking (which of the qualifying notes come first) stays with each backend.
 */

import { SESSION_ID_METADATA_KEY } from './markdownMemoryFiles';

/**
 * Whether a recalled note was written in the given chat. The chat's full history is already in the
 * conversation, so an older copy can only mislead. A note with no recorded chat (written before notes
 * recorded one) is judged to be from another chat: a chat title is not unique, so it is never used to guess.
 */
export function isFromSession({
  metadata,
  sessionId,
}: {
  metadata: Readonly<Record<string, string>> | undefined;
  sessionId: string | undefined;
}): boolean {
  return sessionId !== undefined && sessionId !== '' && metadata?.[SESSION_ID_METADATA_KEY] === sessionId;
}

/** Short filler words that match almost any note, so matching them says nothing about relevance. */
const FILLER_WORDS = new Set([
  'the',
  'and',
  'for',
  'are',
  'but',
  'not',
  'you',
  'all',
  'any',
  'can',
  'had',
  'her',
  'was',
  'one',
  'our',
  'out',
  'has',
  'him',
  'his',
  'how',
  'its',
  'may',
  'now',
  'see',
  'who',
  'did',
  'get',
  'let',
  'say',
  'she',
  'too',
  'use',
  'this',
  'that',
  'with',
  'have',
  'from',
  'they',
  'will',
  'would',
  'there',
  'their',
  'what',
  'when',
  'where',
  'which',
  'about',
  'been',
  'were',
  'your',
  'just',
  'like',
  'then',
  'than',
  'them',
  'some',
  'into',
  'also',
  'does',
  'only',
  'over',
  'such',
  'here',
  'more',
  'most',
  'much',
  'very',
  'should',
  'could',
  'while',
  'these',
  'those',
  'yes',
  'yep',
  'yup',
  'yeah',
  'nope',
  'okay',
  'sure',
  'thanks',
  'thank',
  'please',
  'again',
  'anything',
]);

/**
 * A note qualifies by keywords when it shares this many distinct question words. A single shared
 * word is what lets a reply like "Yup" or "This week" pull in unrelated notes just to fill the budget.
 */
const MIN_SHARED_WORDS = 2;

/**
 * A single shared word still qualifies when it is rare: found in at most this share of the notes
 * (always at least one note). "dentist" in 2 of 200 notes is a real lead; "week" in 40 of 200 is not.
 */
const RARE_WORD_SHARE = 0.1;

/** The distinct words of a question that can say something about relevance. */
export function queryWords(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter(word => word.length > 2 && !FILLER_WORDS.has(word)),
    ),
  ];
}

/**
 * The notes worth recalling for a question, each with how many distinct question words it shares
 * (more is better). Notes that clear no floor are left out, so a question with nothing to match
 * recalls nothing instead of the closest weak notes.
 */
export function keywordMatches<T extends { text: string }>({
  query,
  notes,
}: {
  query: string;
  notes: readonly T[];
}): { note: T; shared: number }[] {
  const words = queryWords(query);
  // Matched at the start of a word, so "sent" finds "sent" but not "present".
  const patterns = words.map(word => new RegExp(`(?<![a-z0-9])${word}`));
  const found = notes.map(note => {
    const lower = note.text.toLowerCase();
    return patterns.map(pattern => pattern.test(lower));
  });
  const rareLimit = Math.max(1, Math.floor(notes.length * RARE_WORD_SHARE));
  const rare = words.map((_, index) => found.filter(hits => hits[index] === true).length <= rareLimit);
  const matches: { note: T; shared: number }[] = [];
  notes.forEach((note, noteIndex) => {
    const hits = found[noteIndex] ?? [];
    const shared = hits.filter(Boolean).length;
    const hasRareWord = hits.some((hit, index) => hit && rare[index] === true);
    if (shared >= MIN_SHARED_WORDS || (shared === 1 && hasRareWord)) {
      matches.push({ note, shared });
    }
  });
  return matches;
}
