import { TrueForge } from '@truefoundry/trueforge-sdk';
import assert from 'node:assert/strict';
import { afterEach, describe, it, vi } from 'vitest';

import {
  createSkillCatalog,
  toHarnessManifest,
  toUiCatalogEntry,
  toUiSkill,
} from '@/plugins/trueforge-agent-server-adapter/catalogs/skillCatalog.js';

describe('skillCatalog mappers', () => {
  it('maps catalog presets with id = name and repoURL from url', () => {
    assert.deepEqual(
      toUiCatalogEntry({
        type: 'git',
        name: 'algorithmic-art',
        url: 'https://github.com/anthropics/skills',
        path: 'skills/algorithmic-art',
        ref: 'main',
        description: 'Create algorithmic art',
      }),
      {
        id: 'algorithmic-art',
        name: 'algorithmic-art',
        description: 'Create algorithmic art',
        repoURL: 'https://github.com/anthropics/skills',
        path: 'skills/algorithmic-art',
        ref: 'main',
      },
    );
  });

  it('uses empty path when harness omits path', () => {
    assert.equal(
      toUiCatalogEntry({
        type: 'git',
        name: 'root-skill',
        url: 'https://github.com/example/skills',
        ref: 'main',
        description: 'Root skill',
      }).path,
      '',
    );
  });

  it('omits empty path on harness upsert and maps repoURL to url', () => {
    assert.deepEqual(
      toHarnessManifest({
        name: 'root-skill',
        description: 'Root skill',
        repoURL: 'https://github.com/example/skills',
        path: '  ',
        ref: 'main',
      }),
      {
        type: 'git',
        name: 'root-skill',
        description: 'Root skill',
        url: 'https://github.com/example/skills',
        ref: 'main',
      },
    );
    assert.deepEqual(
      toHarnessManifest({
        name: 'nested',
        description: 'Nested',
        repoURL: 'https://github.com/example/skills',
        path: 'skills/nested',
        ref: 'v1',
      }),
      {
        type: 'git',
        name: 'nested',
        description: 'Nested',
        url: 'https://github.com/example/skills',
        path: 'skills/nested',
        ref: 'v1',
      },
    );
  });

  it('attaches catalogId when configured name and manifest match a catalog preset', () => {
    const catalogByName = new Map([
      ['algorithmic-art', { url: 'https://github.com/anthropics/skills', path: 'skills/algorithmic-art', ref: 'main' }],
    ]);
    assert.deepEqual(
      toUiSkill(
        {
          name: 'algorithmic-art',
          manifest: {
            type: 'git',
            name: 'algorithmic-art',
            url: 'https://github.com/anthropics/skills',
            path: 'skills/algorithmic-art',
            ref: 'main',
            description: 'Create algorithmic art',
          },
        },
        catalogByName,
      ),
      {
        id: 'algorithmic-art',
        name: 'algorithmic-art',
        description: 'Create algorithmic art',
        catalogId: 'algorithmic-art',
      },
    );
    assert.deepEqual(
      toUiSkill(
        {
          name: 'house-style',
          manifest: {
            type: 'git',
            name: 'house-style',
            url: 'https://github.com/example/skills',
            path: 'skills/house-style',
            ref: 'main',
            description: 'House style',
          },
        },
        catalogByName,
      ),
      {
        id: 'house-style',
        name: 'house-style',
        description: 'House style',
      },
    );
  });

  it('omits catalogId when a GitHub import reuses a catalog preset name but points elsewhere', () => {
    const catalogByName = new Map([
      ['algorithmic-art', { url: 'https://github.com/anthropics/skills', path: 'skills/algorithmic-art', ref: 'main' }],
    ]);
    assert.deepEqual(
      toUiSkill(
        {
          name: 'algorithmic-art',
          manifest: {
            type: 'git',
            name: 'algorithmic-art',
            url: 'https://github.com/example/my-fork',
            path: 'skills/algorithmic-art',
            ref: 'main',
            description: 'A different repo reusing the same name',
          },
        },
        catalogByName,
      ),
      {
        id: 'algorithmic-art',
        name: 'algorithmic-art',
        description: 'A different repo reusing the same name',
      },
    );
  });
});

describe('skillCatalog delete', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  function catalogWithFetch(fetchImpl: typeof fetch) {
    const client = new TrueForge({ baseUrl: 'http://harness.test', maxRetries: 0, fetch: fetchImpl });
    return createSkillCatalog(client);
  }

  it('issues a DELETE against the server row and resolves once it succeeds', async () => {
    const calls: { url: string; method: string | undefined }[] = [];
    const catalog = catalogWithFetch(async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      return new Response(JSON.stringify({}), { status: 200, headers: { 'content-type': 'application/json' } });
    });

    await catalog.deleteSkill?.({ id: 'house-style' });

    assert.deepEqual(calls, [{ url: 'http://harness.test/api/v1/settings/skills/house-style', method: 'DELETE' }]);
  });

  // A delete that never gets an answer must still give up well inside the SDK's 60s default, so
  // a slow/unreachable Harness server cannot hold the Settings UI in a "deleting…" state long
  // enough to read as a frozen tab.
  it('aborts the request well before the SDK default 60s timeout when the server never answers', async () => {
    let observedSignal: AbortSignal | null | undefined;
    const catalog = catalogWithFetch(
      async (_input, init) =>
        new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal;
          observedSignal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'AbortError'));
          });
        }),
    );

    vi.useFakeTimers();
    const pending = catalog.deleteSkill?.({ id: 'house-style' });
    assert.ok(pending, 'deleteSkill should be present on the catalog');
    const rejection = assert.rejects(pending);

    // Well under the SDK's 60s default, but past the delete-specific 15s timeout.
    await vi.advanceTimersByTimeAsync(20_000);

    assert.equal(observedSignal?.aborted, true);
    await rejection;
  });

  // The delete-specific timeout bounds a single attempt; it means nothing if the SDK's default
  // retries (up to two more, with delays as long as 60s between them) still run underneath it.
  it('does not retry a retryable response, so the deadline stays a real bound rather than a per-attempt one', async () => {
    // No client-level maxRetries override here (unlike catalogWithFetch above): this exercises
    // the SDK's actual default of two retries, so the assertion below only passes if
    // deleteSkill's own request-level `maxRetries: 0` is what suppresses them.
    const calls: { url: string; method: string | undefined }[] = [];
    const client = new TrueForge({
      baseUrl: 'http://harness.test',
      fetch: async (input, init) => {
        calls.push({ url: String(input), method: init?.method });
        return new Response(JSON.stringify({ error: { message: 'temporarily unavailable' } }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      },
    });
    const catalog = createSkillCatalog(client);

    await assert.rejects(catalog.deleteSkill?.({ id: 'house-style' }) as Promise<unknown>);

    assert.equal(calls.length, 1);
  });
});
