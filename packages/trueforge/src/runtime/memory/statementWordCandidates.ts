/**
 * Finds single page statements by their words, for a message that named no page and that meaning
 * search could not judge or found nothing for. A match here is a weak signal: it can offer a page as
 * a candidate, or support asking the person which page they mean. It never by itself authorizes
 * writing to that page.
 */
import type { MemoryPage, PageKind, PageLine } from './memoryPages';
import { foldName } from './pageSlug';
import { asksAboutPast } from './statementDates';
import { collectPageStatements, statementMayShow, type PageStatement } from './statementIndex';
import { FACT_STOPWORDS, QUERY_STOPWORDS } from './stopWords';

/** A statement whose words match the message, with the page it sits on and the words that matched. */
export interface StatementCandidate {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  title: string;
  page: MemoryPage;
  sectionIndex: number;
  lineIndex: number;
  /** The matching statement, as the page words it. */
  excerpt: string;
  /** The marked fact's id when the statement is a marked fact; a hand-typed bullet has none. */
  factId: string | undefined;
  /** The message words the statement matched, most distinctive first. */
  matchedTerms: string[];
  score: number;
}

/**
 * The words of a text that can carry a topic: folded as names are folded, split on anything that is
 * not a letter or a digit, longer than two letters, and not one of the words the memory code already
 * treats as carrying no topic (the function words recall queries skip, and the words that add nothing
 * to a saved fact).
 */
function topicTerms(text: string): string[] {
  return [
    ...new Set(
      foldName(text)
        .split(/[^\p{L}\p{N}]+/u)
        .filter(term => term.length > 2 && !QUERY_STOPWORDS.has(term) && !FACT_STOPWORDS.has(term)),
    ),
  ];
}

function compareCandidates(
  a: { candidate: StatementCandidate; vaultIndex: number },
  b: { candidate: StatementCandidate; vaultIndex: number },
): number {
  if (a.candidate.score !== b.candidate.score) {
    return b.candidate.score - a.candidate.score;
  }
  if (a.candidate.matchedTerms.length !== b.candidate.matchedTerms.length) {
    return b.candidate.matchedTerms.length - a.candidate.matchedTerms.length;
  }
  if (a.vaultIndex !== b.vaultIndex) {
    return a.vaultIndex - b.vaultIndex;
  }
  if (a.candidate.kind !== b.candidate.kind) {
    return a.candidate.kind === 'person' ? -1 : 1;
  }
  if (a.candidate.slug !== b.candidate.slug) {
    return a.candidate.slug < b.candidate.slug ? -1 : 1;
  }
  if (a.candidate.sectionIndex !== b.candidate.sectionIndex) {
    return a.candidate.sectionIndex - b.candidate.sectionIndex;
  }
  return a.candidate.lineIndex - b.candidate.lineIndex;
}

/**
 * The statements a message may be about, judged by shared words alone, best first, at most `limit`.
 * Only statements that may be shown today are eligible (the same rule the meaning search uses), and
 * lines the chat left out are left out here too. A word counts only when it is not in most of the
 * eligible statements: a word nearly every statement holds says nothing about which one the message
 * means, however often it matches. Among the words that count, the rarer one weighs more, so a
 * statement matched by a distinctive word stands above one matched by a common one. The same words
 * on the same page are returned once. Never throws.
 */
export async function statementWordCandidates(input: {
  /** The vaults to search, in read-priority order (own vault first). */
  vaultDirs: readonly string[];
  message: string;
  /** The calendar day `YYYY-MM-DD` in the person's time zone; it decides which statements have ended. */
  today: string;
  limit: number;
  /** Lines this chat left out; they are not offered. Left out, every line is offered. */
  skipLine?: ((line: PageLine) => boolean) | undefined;
}): Promise<StatementCandidate[]> {
  const wanted = topicTerms(input.message);
  if (wanted.length === 0 || input.limit <= 0) {
    return [];
  }
  const past = asksAboutPast(input.message);
  const eligible: { statement: PageStatement; vaultIndex: number; terms: ReadonlySet<string> }[] = [];
  const perVault = await Promise.all(
    input.vaultDirs.map(async (vaultDir, vaultIndex) => ({
      vaultIndex,
      statements: await collectPageStatements({ vaultDir }),
    })),
  );
  for (const { vaultIndex, statements } of perVault) {
    for (const statement of statements) {
      if (!statementMayShow({ until: statement.until, inEarlier: statement.inEarlier, today: input.today, past })) {
        continue;
      }
      const line = statement.page.sections[statement.sectionIndex]?.lines[statement.lineIndex];
      if (line !== undefined && input.skipLine?.(line)) {
        continue;
      }
      eligible.push({ statement, vaultIndex, terms: new Set(topicTerms(statement.statement)) });
    }
  }
  if (eligible.length === 0) {
    return [];
  }
  // How many eligible statements hold each word, so a word's weight comes from this vault, not a list.
  const holders = new Map<string, number>();
  for (const { terms } of eligible) {
    for (const term of terms) {
      holders.set(term, (holders.get(term) ?? 0) + 1);
    }
  }
  const total = eligible.length;
  const counts = (term: string): boolean => (holders.get(term) ?? 0) <= Math.max(1, Math.floor(total / 2));
  const weight = (term: string): number => Math.log(1 + total / (holders.get(term) ?? total));

  const scored: { candidate: StatementCandidate; vaultIndex: number }[] = [];
  for (const { statement, vaultIndex, terms } of eligible) {
    const matched = wanted
      .filter(term => terms.has(term) && counts(term))
      .sort((a, b) => weight(b) - weight(a) || (a < b ? -1 : 1));
    if (matched.length === 0) {
      continue;
    }
    scored.push({
      vaultIndex,
      candidate: {
        vaultDir: statement.vaultDir,
        kind: statement.kind,
        slug: statement.slug,
        title: statement.title,
        page: statement.page,
        sectionIndex: statement.sectionIndex,
        lineIndex: statement.lineIndex,
        excerpt: statement.statement,
        factId: statement.factId,
        matchedTerms: matched,
        score: matched.reduce((sum, term) => sum + weight(term), 0),
      },
    });
  }
  return scored
    .sort(compareCandidates)
    .filter(
      (entry, i, all) =>
        all.findIndex(
          other =>
            other.candidate.vaultDir === entry.candidate.vaultDir &&
            other.candidate.kind === entry.candidate.kind &&
            other.candidate.slug === entry.candidate.slug &&
            other.candidate.excerpt === entry.candidate.excerpt,
        ) === i,
    )
    .slice(0, input.limit)
    .map(({ candidate }) => candidate);
}
