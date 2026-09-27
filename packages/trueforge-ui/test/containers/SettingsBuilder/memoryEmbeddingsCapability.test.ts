// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readMemoryEmbeddingsStatus } from '@/containers/SettingsBuilder/memoryEmbeddingsCapability.js';

describe('readMemoryEmbeddingsStatus', () => {
  it('reads the SDK-normalized camelCase shape', () => {
    expect(
      readMemoryEmbeddingsStatus({
        memoryEmbeddings: {
          enabled: true,
          state: 'ready',
          detail: 'Smart search is on.',
          indexedEntries: 42,
        },
      }),
    ).toEqual({ enabled: true, state: 'ready', detail: 'Smart search is on.', indexedEntries: 42 });
  });

  it('reads the snake_case wire shape', () => {
    expect(
      readMemoryEmbeddingsStatus({
        memory_embeddings: {
          enabled: true,
          state: 'downloading',
          detail: 'Downloading the model.',
          indexed_entries: 0,
        },
      }),
    ).toEqual({
      enabled: true,
      state: 'downloading',
      detail: 'Downloading the model.',
      indexedEntries: 0,
    });
  });

  it('accepts every lifecycle state', () => {
    for (const state of ['starting', 'downloading', 'backfilling', 'ready', 'unavailable']) {
      expect(
        readMemoryEmbeddingsStatus({
          memoryEmbeddings: { enabled: true, state, detail: 'd', indexedEntries: 0 },
        }),
      ).toMatchObject({ state });
    }
  });

  it('returns null when the capability is missing or malformed', () => {
    expect(readMemoryEmbeddingsStatus(null)).toBeNull();
    expect(readMemoryEmbeddingsStatus({})).toBeNull();
    expect(readMemoryEmbeddingsStatus({ memoryEmbeddings: { enabled: true } })).toBeNull();
    expect(
      readMemoryEmbeddingsStatus({
        memoryEmbeddings: { enabled: true, state: 'exploding', detail: 'd', indexedEntries: 0 },
      }),
    ).toBeNull();
    expect(
      readMemoryEmbeddingsStatus({
        memoryEmbeddings: { enabled: true, state: 'ready', detail: 'd', indexedEntries: -1 },
      }),
    ).toBeNull();
    expect(
      readMemoryEmbeddingsStatus({
        memoryEmbeddings: { enabled: 'yes', state: 'ready', detail: 'd', indexedEntries: 0 },
      }),
    ).toBeNull();
  });
});
