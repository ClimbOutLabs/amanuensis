import {
  actionIdFor,
  hashCanonicalParams,
  InMemoryApprovalTokenStore,
  stableStringify,
  verifyApprovalToken,
} from '../../../src/core/permissions/approvalTokens';

describe('stableStringify', () => {
  test('sorts object keys recursively and drops undefined', () => {
    expect(stableStringify({ b: 1, a: 2, c: undefined })).toBe('{"a":2,"b":1}');
    expect(stableStringify({ z: { b: 1, a: 2 } })).toBe('{"z":{"a":2,"b":1}}');
    expect(stableStringify([3, 1])).toBe('[3,1]');
    expect(stableStringify(null)).toBe('null');
  });
});

describe('hashCanonicalParams', () => {
  test('is key-order insensitive but value sensitive', () => {
    expect(hashCanonicalParams({ a: 1, b: 2 })).toBe(hashCanonicalParams({ b: 2, a: 1 }));
    expect(hashCanonicalParams({ a: 1 })).not.toBe(hashCanonicalParams({ a: 2 }));
  });
});

describe('InMemoryApprovalTokenStore', () => {
  test('redeem is single-use', () => {
    const store = new InMemoryApprovalTokenStore();
    const token = store.mint({ action_id: 'act-1', canonical_params: { a: 1 } });
    expect(store.redeem({ token_id: token.token_id })).toBeDefined();
    expect(store.redeem({ token_id: token.token_id })).toBeUndefined();
    expect(store.peek({ token_id: 'missing' })).toBeUndefined();
  });

  test('pruneBefore drops old tokens', () => {
    const store = new InMemoryApprovalTokenStore();
    const token = store.mint({ action_id: 'act-1', canonical_params: {} });
    store.pruneBefore({ cutoff_iso: '2999-01-01T00:00:00.000Z' });
    expect(store.peek({ token_id: token.token_id })).toBeUndefined();
  });
});

describe('verifyApprovalToken', () => {
  test('accepts byte-identical params', () => {
    const store = new InMemoryApprovalTokenStore();
    const params = { command: 'ls -la', cwd: '/tmp' };
    const token = store.mint({ action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }), canonical_params: params });
    const redeemed = store.redeem({ token_id: token.token_id });
    expect(redeemed).toBeDefined();
    if (redeemed === undefined) {
      return;
    }
    const result = verifyApprovalToken({
      token: redeemed,
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    expect(result).toEqual({ valid: true });
  });

  test('rejects changed params and changed action identity', () => {
    const store = new InMemoryApprovalTokenStore();
    const params = { command: 'ls -la' };
    const token = store.mint({ action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }), canonical_params: params });
    const redeemed = store.redeem({ token_id: token.token_id });
    expect(redeemed).toBeDefined();
    if (redeemed === undefined) {
      return;
    }
    const changed = verifyApprovalToken({
      token: redeemed,
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: { command: 'ls -la /etc' },
    });
    expect(changed.valid).toBe(false);

    const wrongAction = verifyApprovalToken({
      token: redeemed,
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: { command: 'rm -rf /' } }),
      canonical_params: params,
    });
    expect(wrongAction.valid).toBe(false);
  });
});
