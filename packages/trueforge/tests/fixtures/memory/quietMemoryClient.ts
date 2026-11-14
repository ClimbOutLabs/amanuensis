import type {
  DeleteMemoryVaultEntryOutcome,
  ListMemoryVaultEntriesOutcome,
  MemoryClient,
  RecallOutcome,
  UpdateMemoryVaultEntryOutcome,
} from '../../../src/runtime/memory/memoryClient';

/**
 * A memory that holds nothing and touches no files. Tests script the one call they care about with
 * `jest.spyOn`, so the method signatures stay the real ones.
 */
export class QuietMemoryClient implements MemoryClient {
  recall(): Promise<RecallOutcome> {
    return Promise.resolve({ ok: true, results: [] });
  }

  retain: MemoryClient['retain'] = () => Promise.resolve({ ok: true });

  deleteDocument: MemoryClient['deleteDocument'] = () => Promise.resolve({ ok: true });

  getOperation: MemoryClient['getOperation'] = () => Promise.resolve({ ok: true, status: 'completed' });

  retryOperation: MemoryClient['retryOperation'] = () => Promise.resolve({ ok: true });

  listEntries(): Promise<ListMemoryVaultEntriesOutcome> {
    return Promise.resolve({ ok: true, entries: [] });
  }

  updateEntry(): Promise<UpdateMemoryVaultEntryOutcome> {
    return Promise.resolve({ ok: false, code: 'not_found', reason: 'This memory holds no entries.' });
  }

  deleteEntry(): Promise<DeleteMemoryVaultEntryOutcome> {
    return Promise.resolve({ ok: true });
  }
}
