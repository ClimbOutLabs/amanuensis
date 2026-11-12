/**
 * Backend-agnostic behavioural contract for ApprovalTokenStore.
 * Runs under jest against fresh state per test (see backend test files).
 */
import type { ApprovalTokenStore, ShellApprovalBinding } from '@truefoundry/trueforge-core/core';
import {
  actionIdFor,
  verifyApprovalToken,
  type ApprovalTokenScope,
} from '@truefoundry/trueforge-core/core/permissions/approvalTokens';

export interface ApprovalTokenStoreHarness {
  /** The store under test. */
  store: () => ApprovalTokenStore;
  /** A second store over the same data on its own connection; the store itself when it has none. */
  peer: () => ApprovalTokenStore;
  /** Rows currently held, spent ones included. */
  countRows: () => Promise<number>;
}

const alice: ApprovalTokenScope = { tenant_id: 't1', created_by: 'alice' };
const params = { command: 'git commit -m x', cwd: '/work' };
const action_id = actionIdFor({ tool_name: 'exec', canonical_params: params });
const PAST = '2000-01-01T00:00:00.000Z';

function future(): string {
  return new Date(Date.now() + 60_000).toISOString();
}

function mintInput(overrides?: Partial<ApprovalTokenScope & { expires_at: string; shell: ShellApprovalBinding }>) {
  return { ...alice, expires_at: future(), action_id, canonical_params: params, ...overrides };
}

const shellBinding: ShellApprovalBinding = {
  commands: [{ argv: ['git', 'commit', '-m', 'x'], argv0_resolved: '/usr/bin/git' }],
  redirections: [{ target: '/tmp/out', body: null }],
  cwd_resolved: '/work',
  env_overrides: { LANG: 'C' },
  file_hashes: { '/usr/bin/git': 'abc' },
  workspace_cwd: '/work',
  path_resolution: 'host',
};

export function runApprovalTokenStoreContractSuite(harness: () => ApprovalTokenStoreHarness): void {
  it('mints a token that redeems once and carries what was minted', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput({ shell: shellBinding }));

    const redeemed = await store().redeem({ ...alice, token_id: minted.token_id });
    expect(redeemed).toEqual(minted);
    expect(redeemed?.action_id).toBe(action_id);
    expect(redeemed?.shell).toEqual(shellBinding);
  });

  it('stores no shell binding for a plain token', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput());
    expect((await store().redeem({ ...alice, token_id: minted.token_id }))?.shell).toBeNull();
  });

  it('peek reads a live token without consuming it', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput());

    expect(await store().peek({ ...alice, token_id: minted.token_id })).toEqual(minted);
    expect(await store().redeem({ ...alice, token_id: minted.token_id })).toEqual(minted);
    expect(await store().peek({ ...alice, token_id: minted.token_id })).toBeUndefined();
  });

  it('a second redeem fails', async () => {
    const { store, peer } = harness();
    const minted = await store().mint(mintInput());

    expect(await store().redeem({ ...alice, token_id: minted.token_id })).toBeDefined();
    expect(await store().redeem({ ...alice, token_id: minted.token_id })).toBeUndefined();
    expect(await peer().redeem({ ...alice, token_id: minted.token_id })).toBeUndefined();
  });

  it('an unknown token does not redeem', async () => {
    const { store } = harness();
    expect(await store().redeem({ ...alice, token_id: 'f'.repeat(32) })).toBeUndefined();
  });

  it('binds the token to the exact arguments, including the parsed shell binding', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput({ shell: shellBinding }));
    const redeemed = await store().redeem({ ...alice, token_id: minted.token_id });
    if (redeemed === undefined) {
      throw new Error('expected the token to redeem');
    }

    expect(verifyApprovalToken({ token: redeemed, action_id, canonical_params: params })).toEqual({ valid: true });
    expect(
      verifyApprovalToken({ token: redeemed, action_id, canonical_params: { ...params, command: 'git commit -m y' } }),
    ).toEqual({ valid: false, reason: 'parameters changed since approval' });
    expect(
      verifyApprovalToken({
        token: redeemed,
        action_id: actionIdFor({ tool_name: 'exec', canonical_params: { command: 'rm -rf /' } }),
        canonical_params: params,
      }),
    ).toEqual({ valid: false, reason: 'action identity changed since approval' });
    expect(redeemed.shell).toEqual(shellBinding);
    expect(redeemed.shell).not.toEqual({ ...shellBinding, cwd_resolved: '/elsewhere' });
  });

  it('an expired token fails', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput({ expires_at: PAST }));

    expect(await store().peek({ ...alice, token_id: minted.token_id })).toBeUndefined();
    expect(await store().redeem({ ...alice, token_id: minted.token_id })).toBeUndefined();
  });

  it('rejects an expiry that is not a date', async () => {
    const { store } = harness();
    await expect(store().mint(mintInput({ expires_at: 'tomorrow-ish' }))).rejects.toThrow(/expiry/i);
  });

  it('another user or tenant cannot redeem, and the owner still can', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput());

    expect(await store().redeem({ tenant_id: 't1', created_by: 'bob', token_id: minted.token_id })).toBeUndefined();
    expect(await store().redeem({ tenant_id: 't2', created_by: 'alice', token_id: minted.token_id })).toBeUndefined();
    expect(await store().peek({ tenant_id: 't2', created_by: 'alice', token_id: minted.token_id })).toBeUndefined();

    expect(await store().redeem({ ...alice, token_id: minted.token_id })).toEqual(minted);
  });

  it('a missing scope never matches', async () => {
    const { store } = harness();
    const minted = await store().mint(mintInput());

    for (const scope of [
      { tenant_id: '', created_by: '' },
      { tenant_id: '', created_by: 'alice' },
      { tenant_id: 't1', created_by: '' },
    ]) {
      expect(await store().redeem({ ...scope, token_id: minted.token_id })).toBeUndefined();
      expect(await store().peek({ ...scope, token_id: minted.token_id })).toBeUndefined();
    }
    expect(await store().redeem({ ...alice, token_id: minted.token_id })).toEqual(minted);
  });

  it('refuses to mint a token without a tenant or a user', async () => {
    const { store, countRows } = harness();

    await expect(store().mint(mintInput({ tenant_id: '' }))).rejects.toThrow(/tenant/i);
    await expect(store().mint(mintInput({ created_by: '' }))).rejects.toThrow(/user/i);
    expect(await countRows()).toBe(0);
  });

  it('exactly one of many parallel redeems of one token succeeds', async () => {
    const { store, peer } = harness();
    const minted = await store().mint(mintInput());

    const results = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 === 0 ? store() : peer()).redeem({ ...alice, token_id: minted.token_id }),
      ),
    );

    expect(results.filter(result => result !== undefined)).toHaveLength(1);
  });

  it('minting drops used and expired tokens and keeps live ones', async () => {
    const { store, countRows } = harness();
    const used = await store().mint(mintInput());
    await store().redeem({ ...alice, token_id: used.token_id });
    await store().mint(mintInput({ expires_at: PAST }));
    expect(await countRows()).toBeGreaterThan(0);

    const live = await store().mint(mintInput());

    expect(await countRows()).toBe(1);
    expect(await store().peek({ ...alice, token_id: live.token_id })).toEqual(live);
  });
}
