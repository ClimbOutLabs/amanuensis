import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { TRUST_PAGE_URL } from '../src/trustPageUrl';

describe('trustPageUrl (no address set)', () => {
  it('is empty when the shell carries no trust page address', () => {
    assert.equal(TRUST_PAGE_URL, '');
  });
});
