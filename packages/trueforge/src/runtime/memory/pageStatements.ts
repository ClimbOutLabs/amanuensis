/**
 * The small pieces every writer of page statements shares: cleaning a line, comparing two lines, finding the
 * current statements that say something, and making a statement with a new id. The chat tools and the note
 * sorter both write through them, so a statement looks the same whoever wrote it.
 */
import { FactMarkerSchema, type FactMarker, type FactSource } from './memoryNotes';
import { neutralizeReservedText, singleLine } from './memoryPageLoader';
import { hasLineBreak, pageFacts, type FactLocation, type MemoryPage, type PageSection } from './memoryPages';
import { foldName } from './pageSlug';

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
}: {
  text: string;
  id: string;
  src: FactSource;
  since?: FactMarker['since'];
  until?: FactMarker['until'];
  seen?: FactMarker['seen'];
}): { text: string; marker: FactMarker } {
  return {
    text,
    marker: FactMarkerSchema.parse({
      kind: 'fact',
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
