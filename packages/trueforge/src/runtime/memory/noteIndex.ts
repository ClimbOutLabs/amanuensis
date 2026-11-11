/**
 * The standing numbers of a vault's daily-log notes. The vectors are the ones the log's own vector store
 * already holds; this keeps each note's closeness to the comparison messages in memory and works it out
 * again only for notes that were added or changed.
 */
import { EMBEDDING_DIMENSIONS, type EmbeddingModel } from './embeddingModel';
import { indexedText, type RankedMemory } from './embeddingRetrieval';
import type { EmbeddingStore } from './embeddingStore';
import { hashEntryText } from './embeddingStore';
import { closenessOf, comparisonVectors, itemNumbers, standingOf, unitVector, type ItemNumbers } from './standing';

/** How many notes are worked out before the event loop gets a turn. */
const YIELD_EVERY = 100;

interface IndexedNote extends ItemNumbers {
  hash: string;
  unit: Float32Array;
}

/** One vault's notes by meaning. */
export class NoteIndex {
  private notes = new Map<string, IndexedNote>();

  constructor(private readonly model: EmbeddingModel) {}

  /**
   * Brings the numbers up to date with the notes on disk: new and changed notes are measured, removed ones
   * are dropped. A note with no vector in the store yet, or a vector for older text, is left out.
   */
  async update({ entries, store }: { entries: readonly RankedMemory[]; store: EmbeddingStore }): Promise<void> {
    const comparison = await comparisonVectors(this.model);
    const next = new Map<string, IndexedNote>();
    let measured = 0;
    for (const entry of entries) {
      const stored = store.get(entry.id);
      if (stored?.vector.length !== EMBEDDING_DIMENSIONS || stored.hash !== hashEntryText(indexedText(entry))) {
        continue;
      }
      const before = this.notes.get(entry.id);
      if (before?.hash === stored.hash) {
        next.set(entry.id, before);
        continue;
      }
      next.set(entry.id, {
        hash: stored.hash,
        unit: unitVector(stored.vector),
        ...itemNumbers({ vector: stored.vector, comparison }),
      });
      measured += 1;
      if (measured % YIELD_EVERY === 0) {
        // The first search of a large log must not starve the event loop.
        await new Promise(resolve => setImmediate(resolve));
      }
    }
    this.notes = next;
  }

  /** The numbers of the given notes, those the index holds. */
  numbersFor(ids: Iterable<string>): { id: string; numbers: ItemNumbers }[] {
    const found: { id: string; numbers: ItemNumbers }[] = [];
    for (const id of ids) {
      const note = this.notes.get(id);
      if (note !== undefined) {
        found.push({ id, numbers: note });
      }
    }
    return found;
  }

  /** The standing of each given note for a message vector of length one. */
  standings({ query, ids }: { query: Float32Array; ids: Iterable<string> }): { id: string; standing: number }[] {
    return this.numbersFor(ids).map(({ id, numbers }) => {
      const note = this.notes.get(id);
      return {
        id,
        standing: standingOf({
          closeness: closenessOf({ a: query, b: note?.unit ?? new Float32Array(0) }),
          item: numbers,
        }),
      };
    });
  }
}

const indexesByModel = new WeakMap<EmbeddingModel, Map<string, NoteIndex>>();

/** The one note index of a vault folder for a model, so every turn in the process shares what it has measured. */
export function noteIndexFor({ vaultDir, model }: { vaultDir: string; model: EmbeddingModel }): NoteIndex {
  const byVault = indexesByModel.get(model) ?? new Map<string, NoteIndex>();
  indexesByModel.set(model, byVault);
  const existing = byVault.get(vaultDir);
  if (existing !== undefined) {
    return existing;
  }
  const index = new NoteIndex(model);
  byVault.set(vaultDir, index);
  return index;
}
