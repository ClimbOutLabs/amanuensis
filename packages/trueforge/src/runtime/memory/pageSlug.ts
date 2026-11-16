/** Longest page file stem in characters (what a person sees as one letter); longer slugs are cut. */
const PAGE_SLUG_MAX_LENGTH = 64;

/** Longest page file stem in UTF-8 bytes, so the file name plus `.md` stays under the 255 bytes file systems allow. */
const PAGE_SLUG_MAX_BYTES = 200;

/** The stem of a page with no usable title characters. */
export const UNTITLED_PAGE_SLUG = 'untitled';

const MAX_FOLD_PASSES = 4;

function foldOnce(text: string): string {
  return (
    text
      .normalize('NFD')
      .toLowerCase()
      // Accents are dropped on Latin and Greek letters, and the dots on Cyrillic е (ё is е); the same marks
      // are part of the letter in Hangul, kana, Thai and Indic scripts, and й, ї and і stay their own letters.
      .replace(/([\p{Script=Latin}\p{Script=Greek}])\p{M}+/gu, '$1')
      .replace(/е\u0308/gu, 'е')
      // A Greek sigma written at the end of a word is the same letter as the one inside it.
      .replace(/ς/gu, 'σ')
      // Composing again turns Hangul, kana with voicing marks and Indic clusters back into the letters people typed.
      .normalize('NFKC')
  );
}

/**
 * Text as names are compared and filed: lowercase, accents dropped from Latin and Greek letters
 * (and Cyrillic ё written as е), and every other script kept in its composed form, so `José` equals `Jose` while `민수` stays apart
 * from `민숙` and `ハル` from `バル`. Repeated until stable so the result folds to itself.
 */
export function foldName(text: string): string {
  let current = text;
  for (let pass = 0; pass < MAX_FOLD_PASSES; pass++) {
    const next = foldOnce(current);
    if (next === current) {
      break;
    }
    current = next;
  }
  return current;
}

const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The text cut at whole letters, within the character and byte limits; a mark is never left without its letter. */
function cutAtLetters(text: string): string {
  let kept = '';
  let count = 0;
  for (const { segment } of graphemes.segment(text)) {
    if (count + 1 > PAGE_SLUG_MAX_LENGTH || Buffer.byteLength(kept + segment, 'utf8') > PAGE_SLUG_MAX_BYTES) {
      break;
    }
    kept += segment;
    count += 1;
  }
  return kept;
}

/**
 * The file stem for a page title: lowercase, Latin accents folded away, every other run of
 * characters that are not letters, marks or digits turned into one dash. Letters in other
 * scripts stay as written, so `東京` and `김민수` keep their names and `people/김민수.md` loads.
 * Lowercase keeps `Nora` and `nora` one file on case-insensitive disks. Never `sanitizeNamespace`,
 * which drops every non-ASCII letter.
 */
export function pageSlug(title: string): string {
  const folded = foldName(title)
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const cut = cutAtLetters(folded).replace(/-+$/g, '');
  return cut.length > 0 ? cut : UNTITLED_PAGE_SLUG;
}

/** Whether a string is a slug `pageSlug` could have produced, so a path segment from outside can be trusted. */
export function isPageSlug(value: string): boolean {
  return value.length > 0 && pageSlug(value) === value;
}
