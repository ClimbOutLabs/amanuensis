/**
 * Finds single page statements by meaning. Each vault folder keeps one vector per statement; a statement
 * is shown only when a message comes clearly closer to it than ordinary, unrelated messages do.
 */
import { withTimeout } from '@truefoundry/trueforge-core/core';

import { COMPARISON_MESSAGES } from './comparisonMessages';
import { EMBEDDING_DIMENSIONS, type EmbeddingModel } from './embeddingModel';
import { cosineSimilarity } from './embeddingRetrieval';
import { EmbeddingStore, hashEntryText } from './embeddingStore';
import {
  listMemoryPages,
  pageSummary,
  readMemoryPage,
  unmarkedBulletText,
  type MemoryPage,
  type PageKind,
  type PageSection,
} from './memoryPages';
import { asksAboutPast, endedBefore, endedRecently } from './statementDates';

/** Higher shows fewer statements: how many spreads above its usual closeness to ordinary messages a statement must score. */
const STANDING_ABOVE = 3;
/** Higher shows memory for fewer messages: the share of ordinary messages whose best statement a message must beat. */
const MESSAGE_PERCENTILE = 0.95;
/** How many ordinary messages every statement is measured against. */
const COMPARISON_COUNT = 460;
/** With fewer statements than this, the numbers say too little to trust, so nothing is found by meaning. */
const MIN_STATEMENTS = 5;
/** The most statements one message is shown. */
const MAX_FOUND = 6;
/** Keeps a statement that sits at the same closeness to every ordinary message from dividing by zero. */
const MIN_SPREAD = 1e-6;
/** The longest a reply waits for the index and the query vector; the work carries on for the next message. */
const SEARCH_TIMEOUT_MS = 10_000;
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

const comparisonByModel = new WeakMap<EmbeddingModel, Promise<Float32Array[]>>();

/** The comparison messages as query vectors, worked out once per model for the whole process. */
function comparisonVectors(model: EmbeddingModel): Promise<Float32Array[]> {
  const cached = comparisonByModel.get(model);
  if (cached !== undefined) {
    return cached;
  }
  const work = (async (): Promise<Float32Array[]> => {
    const vectors: Float32Array[] = [];
    for (let i = 0; i < COMPARISON_MESSAGES.length; i += EMBED_BATCH) {
      const rows = await model.embedQueries(COMPARISON_MESSAGES.slice(i, i + EMBED_BATCH));
      vectors.push(...rows.map(row => Float32Array.from(row)));
      // Yield between batches so the first search never starves the event loop.
      await new Promise(resolve => setImmediate(resolve));
    }
    return vectors;
  })();
  comparisonByModel.set(model, work);
  work.catch(() => comparisonByModel.delete(model));
  return work;
}

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

interface IndexedStatement extends StatementLine {
  hash: string;
  vector: Float32Array;
  /** Closeness to each comparison message. */
  sims: Float32Array;
  mean: number;
  spread: number;
  pageKey: string;
}

interface IndexedPage {
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

function closenessStats(sims: Float32Array): { mean: number; spread: number } {
  const mean = sims.reduce((sum, value) => sum + value, 0) / sims.length;
  const variance = sims.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sims.length;
  return { mean, spread: Math.max(Math.sqrt(variance), MIN_SPREAD) };
}

function standingOf({ closeness, statement }: { closeness: number; statement: IndexedStatement }): number {
  return (closeness - statement.mean) / statement.spread;
}

/** One vault folder's statements by meaning. Never throws; answers "not ready" instead. */
export class StatementIndex {
  private statements = new Map<string, IndexedStatement>();
  private pages = new Map<string, IndexedPage>();
  private bestStandings = new Float64Array(COMPARISON_COUNT).fill(-Infinity);
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
            vector: before.vector,
            sims: before.sims,
            mean: before.mean,
            spread: before.spread,
          });
          continue;
        }
        const sims = Float32Array.from(comparison.map(query => cosineSimilarity({ a: query, b: stored.vector })));
        const fresh: IndexedStatement = {
          ...line,
          hash: stored.hash,
          vector: stored.vector,
          sims,
          ...closenessStats(sims),
        };
        next.set(line.id, fresh);
        added.push(fresh);
        changed ||= before !== undefined;
      }

      this.statements = next;
      this.pages = pages;
      if (changed) {
        this.bestStandings.fill(-Infinity);
        this.raiseBest([...next.values()]);
      } else {
        this.raiseBest(added);
      }
      return true;
    } catch {
      return false;
    }
  }

  private raiseBest(statements: readonly IndexedStatement[]): void {
    for (const statement of statements) {
      for (let m = 0; m < COMPARISON_COUNT; m += 1) {
        const standing = standingOf({ closeness: statement.sims[m] ?? 0, statement });
        if (standing > (this.bestStandings[m] ?? -Infinity)) {
          this.bestStandings[m] = standing;
        }
      }
    }
  }

  async embedQuery(message: string): Promise<number[] | undefined> {
    const [row] = await this.model.embedQueries([message]);
    return row;
  }

  /** Every statement's standing for a query vector. */
  standings(query: ArrayLike<number>): {
    vaultDir: string;
    statement: IndexedStatement;
    page: IndexedPage | undefined;
    standing: number;
  }[] {
    return [...this.statements.values()].map(statement => ({
      vaultDir: this.vaultDir,
      statement,
      page: this.pages.get(statement.pageKey),
      standing: standingOf({ closeness: cosineSimilarity({ a: query, b: statement.vector }), statement }),
    }));
  }
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

/** The value a message's best standing must beat: the 95th percentile of the comparison messages' own best standings. */
function percentileBar(best: Float64Array): number {
  const sorted = Float64Array.from(best).sort();
  // The small allowance keeps 460 x 0.95 from rounding up to the next position.
  return sorted[Math.ceil(sorted.length * MESSAGE_PERCENTILE - 1e-9) - 1] ?? Infinity;
}

function mayShow({ statement, today, past }: { statement: IndexedStatement; today: string; past: boolean }): boolean {
  const { until } = statement;
  const ended = statement.inEarlier || (until !== undefined && endedBefore({ until, today }));
  if (!ended || past) {
    return true;
  }
  return until !== undefined && endedRecently({ until, today });
}

async function search({
  indexes,
  message,
  today,
  skip,
}: {
  indexes: readonly StatementIndex[];
  message: string;
  today: string;
  skip: ReadonlySet<string>;
}): Promise<StatementHit[]> {
  const ready: StatementIndex[] = [];
  for (const index of indexes) {
    if (await index.refresh()) {
      ready.push(index);
    }
  }
  const [first] = ready;
  if (
    first === undefined ||
    message.trim() === '' ||
    ready.reduce((sum, index) => sum + index.size, 0) < MIN_STATEMENTS
  ) {
    return [];
  }
  const query = await first.embedQuery(message);
  if (query?.length !== EMBEDDING_DIMENSIONS) {
    return [];
  }
  const scored = ready.flatMap(index => index.standings(query));
  // Rule 2: the message must stand out against the best the ordinary messages reach over every vault.
  const comparisonBest = new Float64Array(COMPARISON_COUNT).fill(-Infinity);
  for (const index of ready) {
    index.comparisonBest.forEach((standing, m) => {
      comparisonBest[m] = Math.max(comparisonBest[m] ?? -Infinity, standing);
    });
  }
  const messageBest = scored.reduce((best, { standing }) => Math.max(best, standing), -Infinity);
  if (!(messageBest > percentileBar(comparisonBest))) {
    return [];
  }
  const past = asksAboutPast(message);
  return scored
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
 * The statements the message is about, best first, at most six. Empty when the model is not ready, when the
 * index is too small, when the message is not clearly about anything remembered, when it takes too long, and on any
 * failure. `skip` holds `kind/slug` of pages already shown whole.
 */
export async function findStatements(input: {
  indexes: readonly StatementIndex[];
  message: string;
  today: string;
  skip: ReadonlySet<string>;
}): Promise<StatementHit[]> {
  try {
    return await withTimeout(search(input), SEARCH_TIMEOUT_MS, 'memory statement search');
  } catch {
    return [];
  }
}
