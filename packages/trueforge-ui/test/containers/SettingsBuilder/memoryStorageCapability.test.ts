// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readMemoryStorageDir } from '@/containers/SettingsBuilder/memoryStorageCapability.js';

describe('readMemoryStorageDir', () => {
  it('reads the SDK-normalized camelCase shape', () => {
    expect(readMemoryStorageDir({ memoryDefaults: { markdownDir: '/srv/aman/data/memory' } })).toBe(
      '/srv/aman/data/memory',
    );
  });

  it('reads the snake_case wire shape', () => {
    expect(readMemoryStorageDir({ memory_defaults: { markdown_dir: '/var/lib/aman/memory' } })).toBe(
      '/var/lib/aman/memory',
    );
  });

  it('prefers camelCase when both shapes are present', () => {
    expect(
      readMemoryStorageDir({
        memoryDefaults: { markdownDir: '/camel' },
        memory_defaults: { markdown_dir: '/snake' },
      }),
    ).toBe('/camel');
  });

  it('fails closed to null on a missing or unusable directory', () => {
    expect(readMemoryStorageDir(null)).toBeNull();
    expect(readMemoryStorageDir(undefined)).toBeNull();
    expect(readMemoryStorageDir({})).toBeNull();
    expect(readMemoryStorageDir({ memoryDefaults: {} })).toBeNull();
    expect(readMemoryStorageDir({ memoryDefaults: { markdownDir: '' } })).toBeNull();
    expect(readMemoryStorageDir({ memoryDefaults: { markdownDir: 42 } })).toBeNull();
    expect(readMemoryStorageDir({ memoryDefaults: { markdownDir: { path: '/x' } } })).toBeNull();
  });

  it('does not fall through to snake_case when camelCase is present but null', () => {
    expect(
      readMemoryStorageDir({
        memoryDefaults: { markdownDir: null },
        memory_defaults: { markdown_dir: '/snake' },
      }),
    ).toBeNull();
  });
});
