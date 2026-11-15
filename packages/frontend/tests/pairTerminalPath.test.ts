import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isPairTerminalPath } from '../src/pairTerminalPath';

describe('isPairTerminalPath', () => {
  it('knows the pair-a-terminal page at the root, with or without a trailing slash', () => {
    assert.equal(isPairTerminalPath('/pair-terminal', '/'), true);
    assert.equal(isPairTerminalPath('/pair-terminal/', '/'), true);
  });

  it('knows it under a public base path', () => {
    assert.equal(isPairTerminalPath('/aman/pair-terminal', '/aman/'), true);
    assert.equal(isPairTerminalPath('/pair-terminal', '/aman/'), false);
  });

  it('leaves every other page to the app', () => {
    for (const pathname of ['/', '/settings', '/pair-terminal-x', '/pair-terminal/extra', '/sessions/pair-terminal']) {
      assert.equal(isPairTerminalPath(pathname, '/'), false, pathname);
    }
  });
});
