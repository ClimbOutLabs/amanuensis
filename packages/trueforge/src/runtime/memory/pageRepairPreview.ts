/**
 * A preview of a repair for pages as they already stand, for the person to read before anything is applied.
 * Older sorting put lines on the wrong pages: a line about a matter sits on a person's page, or the same line
 * stands on two pages. This reads every page and proposes, for each machine-written line, a move to the page
 * the line names as its subject, a consolidation when the same line stands on more than one page, or leaving
 * the line alone, with the reason. It writes nothing. A line the person said, wrote, sent or confirmed is
 * never proposed for a move; an ambiguous line is left alone. Running it twice on the same vault gives the
 * same preview, and because a moved line keeps its fact id and its note is already recorded as handled, the
 * sorter cannot file the line again in its old place afterwards.
 */
import { listMemoryPages, readMemoryPage, unmarkedBulletText, type PageListing } from './memoryPages';
import { statementNamesItsPage } from './pageSortRules';
import { sameText } from './pageStatements';

/** One line proposed to move from the page it stands on to the page it is about. */
export interface RepairMove {
  from: PageListing;
  to: PageListing;
  text: string;
}

/** One line standing on more than one page, proposed to keep in one place. */
export interface RepairConsolidation {
  text: string;
  pages: PageListing[];
}

/** One machine-written line proposed to stay where it is, with the reason in plain words. */
export interface RepairLeftAlone {
  page: PageListing;
  text: string;
  why: string;
}

export interface PageRepairPreview {
  moves: RepairMove[];
  consolidations: RepairConsolidation[];
  leftAlone: RepairLeftAlone[];
  /** Lines that are the person's own words. They are never proposed for a change, only counted. */
  ownLines: number;
}

interface StandingLine {
  page: PageListing;
  text: string;
  /** True when the line is the person's own words: said, written by hand, sent, or typed on the page. */
  own: boolean;
}

const samePage = (a: PageListing, b: PageListing): boolean => a.kind === b.kind && a.slug === b.slug;

/** Every line now standing on a page, outside Earlier: what it says, where, and whose words it is. */
async function standingLines(vaultDir: string): Promise<{
  listings: PageListing[];
  lines: StandingLine[];
  names: Map<string, { title: string; aliases: readonly string[] }>;
}> {
  const listings = await listMemoryPages(vaultDir);
  const lines: StandingLine[] = [];
  const names = new Map<string, { title: string; aliases: readonly string[] }>();
  for (const listing of listings) {
    const page = await readMemoryPage({ vaultDir, ...listing }).catch(() => undefined);
    if (page === undefined) {
      continue;
    }
    names.set(`${listing.kind}/${listing.slug}`, {
      title: page.frontMatter.title,
      aliases: page.frontMatter.aliases,
    });
    for (const section of page.sections) {
      if (section.name === undefined || section.name === 'Earlier') {
        continue;
      }
      for (const line of section.lines) {
        if (line.kind === 'fact') {
          const src = line.fact.marker.src;
          lines.push({
            page: listing,
            text: line.fact.text,
            own: src === 'you_said' || src === 'you_edited' || src === 'sent_mail',
          });
        } else {
          const typed = unmarkedBulletText(line.raw);
          if (typed !== undefined && typed !== '') {
            lines.push({ page: listing, text: typed, own: true });
          }
        }
      }
    }
  }
  return { listings, lines, names };
}

/** The preview of a repair for one vault. Reads the pages; writes nothing. */
export async function previewPageRepair({ vaultDir }: { vaultDir: string }): Promise<PageRepairPreview> {
  const { listings, lines, names } = await standingLines(vaultDir);
  const namesOf = (listing: PageListing): { title: string; aliases: readonly string[] } =>
    names.get(`${listing.kind}/${listing.slug}`) ?? { title: listing.slug.replaceAll('-', ' '), aliases: [] };

  const preview: PageRepairPreview = { moves: [], consolidations: [], leftAlone: [], ownLines: 0 };

  // The same line standing on more than one page is one consolidation, whatever else could be said about it.
  const consolidated = new Set<StandingLine>();
  for (const line of lines) {
    if (consolidated.has(line)) {
      continue;
    }
    const copies = lines.filter(
      candidate => !samePage(candidate.page, line.page) && sameText({ a: candidate.text, b: line.text }),
    );
    if (copies.length > 0) {
      const pages = [line.page, ...copies.map(copy => copy.page)];
      preview.consolidations.push({ text: line.text, pages });
      consolidated.add(line);
      for (const copy of copies) {
        consolidated.add(copy);
      }
    }
  }

  for (const line of lines) {
    if (line.own) {
      preview.ownLines += 1;
      continue;
    }
    if (consolidated.has(line)) {
      continue;
    }
    const named = listings.filter(
      other =>
        !samePage(other, line.page) &&
        statementNamesItsPage({
          text: line.text,
          kind: other.kind,
          title: namesOf(other).title,
          aliases: namesOf(other).aliases,
        }),
    );
    const namesOwnPage = statementNamesItsPage({
      text: line.text,
      kind: line.page.kind,
      title: namesOf(line.page).title,
      aliases: namesOf(line.page).aliases,
    });
    if (named.length === 1 && !namesOwnPage && named[0] !== undefined) {
      preview.moves.push({ from: line.page, to: named[0], text: line.text });
    } else if (named.length === 0) {
      preview.leftAlone.push({ page: line.page, text: line.text, why: 'it names no other page' });
    } else if (namesOwnPage) {
      preview.leftAlone.push({
        page: line.page,
        text: line.text,
        why: 'it names the page it is on as well as another page',
      });
    } else {
      preview.leftAlone.push({ page: line.page, text: line.text, why: 'it names more than one other page' });
    }
  }
  return preview;
}
