/**
 * Finds single page statements by meaning. Each vault folder keeps one vector per statement; a statement
 * is shown only when a message comes clearly closer to it than ordinary, unrelated messages do.
 */
import { EMBEDDING_DIMENSIONS, type EmbeddingModel } from './embeddingModel';
import { EmbeddingStore, hashEntryText } from './embeddingStore';
import type { MeaningGate } from './meaningGate';
import {
  listMemoryPages,
  pageSummary,
  readMemoryPage,
  unmarkedBulletText,
  type MemoryPage,
  type PageKind,
  type PageListing,
  type PageSection,
} from './memoryPages';
import {
  closenessOf,
  comparisonVectors,
  emptyBest,
  itemNumbers,
  raiseBest,
  STANDING_ABOVE,
  standingOf,
  unitVector,
  type ItemNumbers,
} from './standing';
import { asksAboutPast, endedBefore, endedRecently } from './statementDates';

/** The most statements one message is shown. */
const MAX_FOUND = 6;
const EMBED_BATCH = 16;

/** The statement vectors sit beside the daily log's, in their own file. */
const STATEMENT_VECTORS_FILE = '.statement-embeddings.json';

const INDEXED_SECTIONS: ReadonlySet<PageSection> = new Set<PageSection>([
  'Now',
  'Decided',
  'Open',
  'Unconfirmed',
  'Earlier',
]);

/** One statement that may be found, as read from a page. */
interface StatementLine {
  id: string;
  /** What is embedded: the page title, its summary and the statement. */
  text: string;
  /** The statement as the page words it. */
  statement: string;
  sectionIndex: number;
  lineIndex: number;
  until: string | undefined;
  inEarlier: boolean;
}

export interface IndexedStatement extends StatementLine, ItemNumbers {
  hash: string;
  /** The vector scaled to length one. */
  unit: Float32Array;
  pageKey: string;
}

export interface IndexedPage {
  kind: PageKind;
  slug: string;
  title: string;
  page: MemoryPage;
}

function pageKeyOf({ kind, slug }: { kind: PageKind; slug: string }): string {
  return `${kind}/${slug}`;
}

/** The text a statement is embedded as: `Title (summary): statement`, or `Title: statement` when the statement is the summary or there is none. */
export function statementEmbedText({
  title,
  summary,
  statement,
}: {
  title: string;
  summary: string | undefined;
  statement: string;
}): string {
  return summary === undefined || summary === statement
    ? `${title}: ${statement}`
    : `${title} (${summary}): ${statement}`;
}

/** Every statement of a page that may be found, with an id that stays the same across runs. */
function statementLines({ key, page }: { key: string; page: MemoryPage }): StatementLine[] {
  const title = page.frontMatter.title;
  const summary = pageSummary(page);
  const used = new Set<string>();
  const lines: StatementLine[] = [];
  for (const [sectionIndex, section] of page.sections.entries()) {
    if (section.name === undefined || !INDEXED_SECTIONS.has(section.name)) {
      continue;
    }
    for (const [lineIndex, line] of section.lines.entries()) {
      const typed = line.kind === 'other' ? unmarkedBulletText(line.raw) : undefined;
      const statement = line.kind === 'fact' ? line.fact.text : typed;
      if (statement === undefined || statement === '') {
        continue;
      }
      const own = line.kind === 'fact' ? line.fact.marker.id : `t:${hashEntryText(statement).slice(0, 16)}`;
      // Ids repeat when a page is edited by hand; a counter keeps each line its own.
      let id = `${key}#${own}`;
      for (let n = 2; used.has(id); n += 1) {
        id = `${key}#${own}~${String(n)}`;
      }
      used.add(id);
      lines.push({
        id,
        text: statementEmbedText({ title, summary, statement }),
        statement,
        sectionIndex,
        lineIndex,
        until: line.kind === 'fact' ? line.fact.marker.until : undefined,
        inEarlier: section.name === 'Earlier',
      });
    }
  }
  return lines;
}

/** One vault folder's statements by meaning. Never throws; answers "not ready" instead. */
export class StatementIndex {
  private statements = new Map<string, IndexedStatement>();
  private pages = new Map<string, IndexedPage>();
  private bestStandings = emptyBest();
  private store: EmbeddingStore | undefined;
  private running: Promise<boolean> | undefined;

  constructor(
    readonly vaultDir: string,
    private readonly model: EmbeddingModel,
  ) {}

  get size(): number {
    return this.statements.size;
  }

  /** For each comparison message, the best standing of any statement in this index. */
  get comparisonBest(): Float64Array {
    return this.bestStandings;
  }

  /** Brings the index up to date with the pages. False when the model is not ready or the pages could not be indexed. */
  refresh(): Promise<boolean> {
    if (this.model.currentPhase !== 'ready') {
      return Promise.resolve(false);
    }
    this.running ??= this.update().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async update(): Promise<boolean> {
    try {
      const comparison = await comparisonVectors(this.model);
      this.store ??= await EmbeddingStore.load({ namespaceDir: this.vaultDir, fileName: STATEMENT_VECTORS_FILE });
      const store = this.store;

      const pages = new Map<string, IndexedPage>();
      const lines: (StatementLine & { pageKey: string })[] = [];
      for (const listing of await listMemoryPages(this.vaultDir)) {
        const page = await readMemoryPage({ vaultDir: this.vaultDir, ...listing }).catch(() => undefined);
        if (page === undefined) {
          continue;
        }
        const pageKey = pageKeyOf(listing);
        pages.set(pageKey, { ...listing, title: page.frontMatter.title, page });
        lines.push(...statementLines({ key: pageKey, page }).map(line => ({ ...line, pageKey })));
      }

      const live = new Set(lines.map(line => line.id));
      const removed = [...this.statements.keys()].some(id => !live.has(id));
      let changed = removed;
      const pending = lines.filter(line => store.get(line.id)?.hash !== hashEntryText(line.text));
      for (let i = 0; i < pending.length; i += EMBED_BATCH) {
        const batch = pending.slice(i, i + EMBED_BATCH);
        const vectors = await this.model.embedPassages(batch.map(line => line.text));
        batch.forEach((line, k) => {
          const vector = vectors[k];
          if (vector !== undefined) {
            store.set({ id: line.id, text: line.text, vector });
          }
        });
      }
      if (store.reconcile(live) || pending.length > 0) {
        await store.save();
      }

      const next = new Map<string, IndexedStatement>();
      const added: IndexedStatement[] = [];
      for (const line of lines) {
        const stored = store.get(line.id);
        if (stored?.vector.length !== EMBEDDING_DIMENSIONS) {
          continue;
        }
        const before = this.statements.get(line.id);
        if (before?.hash === stored.hash) {
          next.set(line.id, {
            ...line,
            hash: stored.hash,
            unit: before.unit,
            sims: before.sims,
            mean: before.mean,
            spread: before.spread,
          });
          continue;
        }
        const fresh: IndexedStatement = {
          ...line,
          hash: stored.hash,
          unit: unitVector(stored.vector),
          ...itemNumbers({ vector: stored.vector, comparison }),
        };
        next.set(line.id, fresh);
        added.push(fresh);
        changed ||= before !== undefined;
      }

      this.statements = next;
      this.pages = pages;
      if (changed) {
        this.bestStandings = emptyBest();
        raiseBest({ best: this.bestStandings, items: next.values() });
      } else {
        raiseBest({ best: this.bestStandings, items: added });
      }
      return true;
    } catch {
      return false;
    }
  }

  /** Every statement's standing for a message vector of length one. */
  standings(query: Float32Array): StatementStanding[] {
    return [...this.statements.values()].map(statement => ({
      vaultDir: this.vaultDir,
      statement,
      page: this.pages.get(statement.pageKey),
      standing: standingOf({ closeness: closenessOf({ a: query, b: statement.unit }), item: statement }),
    }));
  }
}

/** One statement's standing for a message, with the page it sits on. */
export interface StatementStanding {
  vaultDir: string;
  statement: IndexedStatement;
  page: IndexedPage | undefined;
  standing: number;
}

const indexesByModel = new WeakMap<EmbeddingModel, Map<string, StatementIndex>>();

/** The one index of a vault folder for a model, so every turn in the process shares what it has embedded. */
export function statementIndexFor({ vaultDir, model }: { vaultDir: string; model: EmbeddingModel }): StatementIndex {
  const byVault = indexesByModel.get(model) ?? new Map<string, StatementIndex>();
  indexesByModel.set(model, byVault);
  const existing = byVault.get(vaultDir);
  if (existing !== undefined) {
    return existing;
  }
  const index = new StatementIndex(vaultDir, model);
  byVault.set(vaultDir, index);
  return index;
}

/** A statement found by meaning, with where it sits on its page. */
export interface StatementHit {
  vaultDir: string;
  kind: PageKind;
  slug: string;
  title: string;
  page: MemoryPage;
  sectionIndex: number;
  lineIndex: number;
  standing: number;
  /** The statement as the page words it. */
  text: string;
}

/** The same words on the same page, wherever it sits: shown once. */
function sameStatement(a: StatementHit, b: StatementHit): boolean {
  return a.vaultDir === b.vaultDir && a.kind === b.kind && a.slug === b.slug && a.text === b.text;
}

function mayShow({ statement, today, past }: { statement: IndexedStatement; today: string; past: boolean }): boolean {
  const { until } = statement;
  const ended = statement.inEarlier || (until !== undefined && endedBefore({ until, today }));
  if (!ended || past) {
    return true;
  }
  return until !== undefined && endedRecently({ until, today });
}

/**
 * The statements the message is about, best first, at most six. Empty unless the gate judged the message and
 * found it clearly about something remembered. `skip` holds `kind/slug` of pages already shown whole.
 */
export function statementHits({
  gate,
  today,
  message,
  skip,
}: {
  gate: MeaningGate;
  today: string;
  message: string;
  skip: ReadonlySet<string>;
}): StatementHit[] {
  if (gate.state !== 'judged' || !gate.open) {
    return [];
  }
  const past = asksAboutPast(message);
  return gate.statements
    .flatMap(({ vaultDir, statement, page, standing }): StatementHit[] =>
      page !== undefined &&
      standing > STANDING_ABOVE &&
      !skip.has(statement.pageKey) &&
      mayShow({ statement, today, past })
        ? [
            {
              vaultDir,
              kind: page.kind,
              slug: page.slug,
              title: page.title,
              page: page.page,
              sectionIndex: statement.sectionIndex,
              lineIndex: statement.lineIndex,
              standing,
              text: statement.statement,
            },
          ]
        : [],
    )
    .sort((a, b) => b.standing - a.standing)
    .filter((hit, i, all) => all.findIndex(other => sameStatement(other, hit)) === i)
    .slice(0, MAX_FOUND);
}

/**
 * The pages whose statements are closest in meaning to a text, nearest first, each once. Empty when the meaning
 * search is not ready.
 */
export async function pagesNearText({
  index,
  model,
  text,
  limit,
}: {
  index: StatementIndex;
  model: EmbeddingModel;
  text: string;
  limit: number;
}): Promise<PageListing[]> {
  if (!(await index.refresh())) {
    return [];
  }
  const [row] = await model.embedQueries([text]);
  if (row?.length !== EMBEDDING_DIMENSIONS) {
    return [];
  }
  const nearest = index
    .standings(unitVector(row))
    .sort((a, b) => b.standing - a.standing)
    .flatMap(({ page }) => (page === undefined ? [] : [{ kind: page.kind, slug: page.slug }]));
  const seen = new Set<string>();
  const pages: PageListing[] = [];
  for (const listing of nearest) {
    const key = pageKeyOf(listing);
    if (!seen.has(key) && pages.length < limit) {
      seen.add(key);
      pages.push(listing);
    }
  }
  return pages;
}
