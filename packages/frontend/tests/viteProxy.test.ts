import assert from 'node:assert/strict';
import { test } from 'node:test';

import { apiProxy } from '../vite.config';

test('the dev server passes WebSockets through to the API, so voice mode can connect', () => {
  assert.equal(apiProxy.ws, true);
});
