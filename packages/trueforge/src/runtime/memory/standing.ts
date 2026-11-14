/**
 * How clearly a message is about one remembered item (a page statement or a daily-log note). Each item is
 * measured against a fixed list of ordinary messages; its standing for a message is how many spreads that
 * message sits above the ordinary messages' usual closeness. Statements and notes share these numbers.
 */
import { COMPARISON_MESSAGES } from './comparisonMessages';
import type { EmbeddingModel } from './embeddingModel';

/** Higher shows fewer items: how many spreads above its usual closeness to ordinary messages an item must score. */
export const STANDING_ABOVE = 3;
/** Higher shows memory for fewer messages: the share of ordinary messages whose best item a message must beat. */
const MESSAGE_PERCENTILE = 0.95;
/** How many ordinary messages every item is measured against. */
const COMPARISON_COUNT = 460;
/** Keeps an item that sits at the same closeness to every ordinary message from dividing by zero. */
const MIN_SPREAD = 1e-6;
const EMBED_BATCH = 16;

/** An ordinary message as a unit-length query vector. */
type ComparisonVector = Float32Array;

const comparisonByModel = new WeakMap<EmbeddingModel, Promise<ComparisonVector[]>>();

/** The length of a vector; zero for a vector of zeros. */
function lengthOf(vector: ArrayLike<number>): number {
  return Math.sqrt(Array.from(vector).reduce((sum, value) => sum + value * value, 0));
}

/** The vector scaled to length one, so closeness is a plain dot product. */
export function unitVector(vector: ArrayLike<number>): Float32Array {
  const length = lengthOf(vector);
  const unit = new Float32Array(vector.length);
  if (length === 0) {
    return unit;
  }
  for (let i = 0; i < vector.length; i += 1) {
    unit[i] = (vector[i] ?? 0) / length;
  }
  return unit;
}

/** The comparison messages as unit query vectors, worked out once per model for the whole process. */
export function comparisonVectors(model: EmbeddingModel): Promise<ComparisonVector[]> {
  const cached = comparisonByModel.get(model);
  if (cached !== undefined) {
    return cached;
  }
  const work = (async (): Promise<ComparisonVector[]> => {
    const vectors: ComparisonVector[] = [];
    for (let i = 0; i < COMPARISON_MESSAGES.length; i += EMBED_BATCH) {
      const rows = await model.embedQueries(COMPARISON_MESSAGES.slice(i, i + EMBED_BATCH));
      vectors.push(...rows.map(unitVector));
      // Yield between batches so the first search never starves the event loop.
      await new Promise(resolve => setImmediate(resolve));
    }
    return vectors;
  })();
  comparisonByModel.set(model, work);
  work.catch(() => comparisonByModel.delete(model));
  return work;
}

/** Closeness (cosine) of two unit vectors. */
export function closenessOf({ a, b }: { a: Float32Array; b: Float32Array }): number {
  let dot = 0;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    dot += (a[i] ?? 0) * (b[i] ?? 0);
  }
  return dot;
}

/** An item's closeness to each comparison message, with their mean and spread: all its standing needs. */
export interface ItemNumbers {
  sims: Float32Array;
  mean: number;
  spread: number;
}

function numbersOf(sims: Float32Array): ItemNumbers {
  const mean = sims.reduce((sum, value) => sum + value, 0) / sims.length;
  const variance = sims.reduce((sum, value) => sum + (value - mean) ** 2, 0) / sims.length;
  return { sims, mean, spread: Math.max(Math.sqrt(variance), MIN_SPREAD) };
}

/** The numbers of one item from its vector. */
export function itemNumbers({
  vector,
  comparison,
}: {
  vector: ArrayLike<number>;
  comparison: readonly ComparisonVector[];
}): ItemNumbers {
  const unit = unitVector(vector);
  return numbersOf(Float32Array.from(comparison.map(query => closenessOf({ a: query, b: unit }))));
}

/** How many spreads above the item's usual closeness a closeness sits. */
export function standingOf({ closeness, item }: { closeness: number; item: ItemNumbers }): number {
  return (closeness - item.mean) / item.spread;
}

/** A fresh list of best standings, one per comparison message, before any item has been counted. */
export function emptyBest(): Float64Array {
  return new Float64Array(COMPARISON_COUNT).fill(-Infinity);
}

/** Raises each comparison message's best standing to the best any of `items` gives it. */
export function raiseBest({ best, items }: { best: Float64Array; items: Iterable<ItemNumbers> }): void {
  for (const item of items) {
    for (let m = 0; m < COMPARISON_COUNT; m += 1) {
      const standing = standingOf({ closeness: item.sims[m] ?? 0, item });
      if (standing > (best[m] ?? -Infinity)) {
        best[m] = standing;
      }
    }
  }
}

/** The value a message's best standing must beat: the 95th percentile of the comparison messages' own best standings. */
export function percentileBar(best: Float64Array): number {
  const sorted = Float64Array.from(best).sort();
  // The small allowance keeps 460 x 0.95 from rounding up to the next position.
  return sorted[Math.ceil(sorted.length * MESSAGE_PERCENTILE - 1e-9) - 1] ?? Infinity;
}
