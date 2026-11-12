import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isBrowserLivePath } from '../src/browserLivePath';

describe('isBrowserLivePath', () => {
  it('knows the live browser page at the root, with or without a trailing slash', () => {
    assert.equal(isBrowserLivePath('/browser-live', '/'), true);
    assert.equal(isBrowserLivePath('/browser-live/', '/'), true);
  });

  it('knows it under a public base path', () => {
    assert.equal(isBrowserLivePath('/aman/browser-live', '/aman/'), true);
    assert.equal(isBrowserLivePath('/browser-live', '/aman/'), false);
  });

  it('leaves every other page to the app', () => {
    for (const pathname of ['/', '/settings', '/browser-live-x', '/browser-live/extra', '/sessions/browser-live']) {
      assert.equal(isBrowserLivePath(pathname, '/'), false, pathname);
    }
  });
});
