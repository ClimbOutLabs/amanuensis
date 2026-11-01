/** Longest page file stem; longer slugs are cut. */
const PAGE_SLUG_MAX_LENGTH = 64;

/** The stem of a page with no usable title characters. */
export const UNTITLED_PAGE_SLUG = 'untitled';

/**
 * The file stem for a page title: lowercase, accents folded away, every other run of
 * non-letters to one dash. Letters outside Latin stay as they are, so `東京` keeps its name,
 * while `José` and `Jose` share one page. Lowercase keeps `Wendy` and `wendy` one file on
 * case-insensitive disks. Never `sanitizeNamespace`, which drops every non-ASCII letter.
 */
export function pageSlug(title: string): string {
  const folded = title
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const cut = folded.slice(0, PAGE_SLUG_MAX_LENGTH).replace(/-+$/g, '');
  return cut.length > 0 ? cut : UNTITLED_PAGE_SLUG;
}

/** Whether a string is a slug `pageSlug` could have produced, so a path segment from outside can be trusted. */
export function isPageSlug(value: string): boolean {
  return value.length > 0 && value.length <= PAGE_SLUG_MAX_LENGTH && pageSlug(value) === value;
}
