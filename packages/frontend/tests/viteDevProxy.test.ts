import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { UserConfig } from 'vite';
import viteConfig from '../vite.config';

describe('vite dev server proxy', () => {
  it('forwards the API and the catalog logos to the server', async () => {
    const config: UserConfig =
      typeof viteConfig === 'function'
        ? await viteConfig({ command: 'serve', mode: 'development', isSsrBuild: false, isPreview: false })
        : await viteConfig;
    const proxy = config.server?.proxy ?? {};
    assert.deepEqual(Object.keys(proxy).sort(), ['/api', '/catalog-logos']);
  });
});
