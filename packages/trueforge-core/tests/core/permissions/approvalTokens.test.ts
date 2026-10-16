import {
  actionIdFor,
  hashCanonicalParams,
  InMemoryApprovalTokenStore,
  stableStringify,
  toJsonSafeParams,
  verifyApprovalToken,
} from '../../../src/core/permissions/approvalTokens';
import { TEST_TOKEN_SCOPE, testApprovalOwner } from './approvalTokenFixtures';

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

describe('toJsonSafeParams', () => {
  test('round-trips Dates to ISO strings like the verify path JSON.parse does', () => {
    const at = new Date('2026-01-02T03:04:05.006Z');
    const normalized = toJsonSafeParams({ at, path: '/tmp/f' });
    expect(normalized).toEqual({ at: '2026-01-02T03:04:05.006Z', path: '/tmp/f' });
  });

  test('drops undefined values, matching JSON.stringify', () => {
    const normalized = toJsonSafeParams({ keep: 1, drop: undefined });
    expect(normalized).toEqual({ keep: 1 });
    expect('drop' in normalized).toBe(false);
  });

  test('converts class instances to plain data', () => {
    class Params {
      readonly command = 'ls';
      method(): string {
        return this.command;
      }
    }
    const nested: Record<string, unknown> = { nested: new Params() };
    const normalized = toJsonSafeParams(nested);
    expect(normalized).toEqual({ nested: { command: 'ls' } });
  });

  test('handles nested structures and preserves JSON-safe values', () => {
    const params = {
      command: 'git status',
      argv: ['git', 'status'],
      nested: { depth: 2, flag: true, nothing: null },
    };
    expect(toJsonSafeParams(params)).toEqual(params);
  });

  test('hashes identically to the verify-path JSON round-trip', () => {
    const params = {
      command: 'ls',
      at: new Date('2026-01-02T03:04:05.006Z'),
      extra: undefined,
      nested: { list: [1, 'two', null] },
    };
    const fromMint = hashCanonicalParams(toJsonSafeParams(params));
    const verifyForm: Record<string, unknown> = JSON.parse(JSON.stringify(params));
    const fromVerify = hashCanonicalParams(verifyForm);
    expect(fromMint).toBe(fromVerify);
  });

  test('minting over normalized params verifies against JSON-parsed args', async () => {
    const store = new InMemoryApprovalTokenStore();
    const liveParams = { command: 'ls', at: new Date('2026-01-02T03:04:05.006Z') };
    const normalized = toJsonSafeParams(liveParams);
    const token = await store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: normalized }),
      canonical_params: normalized,
    });
    const redeemed = await store.redeem({ ...TEST_TOKEN_SCOPE, token_id: token.token_id });
    expect(redeemed).toBeDefined();
    if (redeemed === undefined) {
      return;
    }
    // The verify path rebuilds params via JSON.parse of the serialized
    // arguments string; the token must validate against that form.
    const verifyParams: Record<string, unknown> = JSON.parse(JSON.stringify(liveParams));
    const result = verifyApprovalToken({
      token: redeemed,
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: verifyParams }),
      canonical_params: verifyParams,
    });
    expect(result).toEqual({ valid: true });
  });
});

describe('InMemoryApprovalTokenStore', () => {
  test('redeem is single-use', async () => {
    const store = new InMemoryApprovalTokenStore();
    const token = await store.mint({ ...testApprovalOwner(), action_id: 'act-1', canonical_params: { a: 1 } });
    expect(await store.redeem({ ...TEST_TOKEN_SCOPE, token_id: token.token_id })).toBeDefined();
    expect(await store.redeem({ ...TEST_TOKEN_SCOPE, token_id: token.token_id })).toBeUndefined();
    expect(await store.peek({ ...TEST_TOKEN_SCOPE, token_id: 'missing' })).toBeUndefined();
  });
});

describe('verifyApprovalToken', () => {
  test('accepts byte-identical params', async () => {
    const store = new InMemoryApprovalTokenStore();
    const params = { command: 'ls -la', cwd: '/tmp' };
    const token = await store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const redeemed = await store.redeem({ ...TEST_TOKEN_SCOPE, token_id: token.token_id });
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

  test('rejects changed params and changed action identity', async () => {
    const store = new InMemoryApprovalTokenStore();
    const params = { command: 'ls -la' };
    const token = await store.mint({
      ...testApprovalOwner(),
      action_id: actionIdFor({ tool_name: 'exec', canonical_params: params }),
      canonical_params: params,
    });
    const redeemed = await store.redeem({ ...TEST_TOKEN_SCOPE, token_id: token.token_id });
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

describe('actionIdFor connector binding', () => {
  const base = { tool_name: 'web_search', canonical_params: { query: 'q' } };

  test('is unchanged for a call with no connector', () => {
    expect(actionIdFor({ ...base, connector: undefined })).toBe(actionIdFor(base));
  });

  test('differs when the connector server or its host differs', () => {
    const exa = actionIdFor({ ...base, connector: { server_id: 'exa', destination_host: 'mcp.exa.ai' } });
    expect(actionIdFor({ ...base, connector: { server_id: 'exa', destination_host: 'mcp.exa.ai' } })).toBe(exa);
    expect(actionIdFor({ ...base, connector: { server_id: 'exa', destination_host: 'evil.example' } })).not.toBe(exa);
    expect(actionIdFor({ ...base, connector: { server_id: 'other', destination_host: 'mcp.exa.ai' } })).not.toBe(exa);
    expect(actionIdFor({ ...base, connector: { server_id: 'exa', destination_host: null } })).not.toBe(exa);
    expect(exa).not.toBe(actionIdFor(base));
  });
});
