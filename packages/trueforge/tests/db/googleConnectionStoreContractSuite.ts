/**
 * Backend-agnostic behavioural contract for IGoogleConnectionStore.
 * Runs under jest against a fresh store per test (see backend test files).
 */
import type {
  GoogleConnectionRecord,
  PendingGoogleAuthorization,
} from '@truefoundry/trueforge-core/core/google/connection';
import type { IGoogleConnectionStore } from '../../src/db/googleConnectionStore';

const OWNER = { tenant_id: 'tenant-a', created_by: 'user-a' };
const READ = 'https://www.googleapis.com/auth/gmail.readonly';
const COMPOSE = 'https://www.googleapis.com/auth/gmail.compose';

function connection(overrides: Partial<GoogleConnectionRecord> = {}): GoogleConnectionRecord {
  return {
    ...OWNER,
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'secret-1',
    client_type: 'desktop',
    refresh_token: 'refresh-1',
    granted_scopes: [READ],
    account_email: 'ada@example.com',
    status: 'connected',
    created_at: '2026-10-15T10:00:00.000Z',
    updated_at: '2026-10-15T10:00:00.000Z',
    ...overrides,
  };
}

const VERSION = { refresh_token: 'refresh-1', updated_at: '2026-10-15T10:00:00.000Z' };

function pending(overrides: Partial<PendingGoogleAuthorization> = {}): PendingGoogleAuthorization {
  return {
    ...OWNER,
    state_hash: 'hash-1',
    pkce_verifier: 'verifier-1',
    client_id: '123456789-abcdefghij.apps.googleusercontent.com',
    client_secret: 'secret-1',
    client_type: 'desktop',
    redirect_uri: 'http://127.0.0.1:53682/callback',
    scopes: [READ, COMPOSE],
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

export function runGoogleConnectionStoreContractSuite(getStore: () => IGoogleConnectionStore): void {
  describe('connection', () => {
    it('has no login until one is saved, and returns exactly what was saved', async () => {
      const store = getStore();
      expect(await store.get(OWNER)).toBeNull();

      await store.save(connection({ granted_scopes: [READ, COMPOSE] }));

      expect(await store.get(OWNER)).toEqual(connection({ granted_scopes: [READ, COMPOSE] }));
    });

    it('replaces the login on a second save and keeps when it was first made', async () => {
      const store = getStore();
      await store.save(connection());
      await store.save(
        connection({
          refresh_token: 'refresh-2',
          granted_scopes: [READ, COMPOSE],
          account_email: null,
          created_at: '2026-10-16T10:00:00.000Z',
          updated_at: '2026-10-16T10:00:00.000Z',
        }),
      );

      expect(await store.get(OWNER)).toEqual(
        connection({
          refresh_token: 'refresh-2',
          granted_scopes: [READ, COMPOSE],
          account_email: null,
          created_at: '2026-10-15T10:00:00.000Z',
          updated_at: '2026-10-16T10:00:00.000Z',
        }),
      );
    });

    it('flags only that user as needing to reconnect', async () => {
      const store = getStore();
      const other = { tenant_id: 'tenant-a', created_by: 'user-b' };
      await store.save(connection());
      await store.save(connection({ ...other }));

      expect(await store.markNeedsReconnect({ owner: OWNER, expected: VERSION })).toBe(true);

      expect((await store.get(OWNER))?.status).toBe('needs_reconnect');
      expect((await store.get(other))?.status).toBe('connected');
    });

    it('does not invent a login when marking a user who has none', async () => {
      const store = getStore();
      expect(await store.markNeedsReconnect({ owner: OWNER, expected: VERSION })).toBe(false);
      expect(await store.get(OWNER)).toBeNull();
    });

    it('leaves a login alone that was replaced after it was read', async () => {
      const store = getStore();
      await store.save(connection());
      const replaced = connection({ refresh_token: 'refresh-2', updated_at: '2026-10-16T10:00:00.000Z' });
      await store.save(replaced);

      expect(await store.markNeedsReconnect({ owner: OWNER, expected: VERSION })).toBe(false);
      expect(await store.get(OWNER)).toEqual(replaced);
    });

    it('records the account address only on the login that was read', async () => {
      const store = getStore();
      await store.save(connection({ account_email: 'old@example.com' }));

      expect(
        await store.setAccountEmail({
          owner: OWNER,
          expected: VERSION,
          account_email: 'new@example.com',
          updated_at: '2026-10-17T10:00:00.000Z',
        }),
      ).toBe(true);
      expect(await store.get(OWNER)).toMatchObject({
        account_email: 'new@example.com',
        updated_at: '2026-10-17T10:00:00.000Z',
      });

      expect(
        await store.setAccountEmail({
          owner: OWNER,
          expected: VERSION,
          account_email: 'stale@example.com',
          updated_at: '2026-10-18T10:00:00.000Z',
        }),
      ).toBe(false);
      expect((await store.get(OWNER))?.account_email).toBe('new@example.com');
    });

    it('does not bring back a login that was deleted after it was read', async () => {
      const store = getStore();
      await store.save(connection());
      await store.delete(OWNER);

      expect(
        await store.setAccountEmail({
          owner: OWNER,
          expected: VERSION,
          account_email: 'new@example.com',
          updated_at: '2026-10-17T10:00:00.000Z',
        }),
      ).toBe(false);
      expect(await store.get(OWNER)).toBeNull();
    });

    it('never lets a login cross users or tenants', async () => {
      const store = getStore();
      await store.save(connection());
      expect(await store.get({ tenant_id: 'tenant-a', created_by: 'user-b' })).toBeNull();
      expect(await store.get({ tenant_id: 'tenant-b', created_by: 'user-a' })).toBeNull();
    });

    it('deletes only that user login', async () => {
      const store = getStore();
      const other = { tenant_id: 'tenant-a', created_by: 'user-b' };
      await store.save(connection());
      await store.save(connection({ ...other }));

      await store.delete(OWNER);

      expect(await store.get(OWNER)).toBeNull();
      expect(await store.get(other)).not.toBeNull();
    });
  });

  describe('consent in flight', () => {
    it('hands the consent back once and then forgets it', async () => {
      const store = getStore();
      const saved = pending();
      await store.savePending(saved);

      expect(await store.takePending({ ...OWNER, state_hash: 'hash-1' })).toEqual(saved);
      expect(await store.takePending({ ...OWNER, state_hash: 'hash-1' })).toBeNull();
    });

    it('keeps one consent per user, the newest', async () => {
      const store = getStore();
      await store.savePending(pending({ state_hash: 'old' }));
      await store.savePending(pending({ state_hash: 'new' }));

      expect(await store.takePending({ ...OWNER, state_hash: 'old' })).toBeNull();
      expect((await store.takePending({ ...OWNER, state_hash: 'new' }))?.state_hash).toBe('new');
    });

    it('never hands one user the consent of another', async () => {
      const store = getStore();
      await store.savePending(pending());
      expect(await store.takePending({ tenant_id: 'tenant-a', created_by: 'user-b', state_hash: 'hash-1' })).toBeNull();
      expect(await store.takePending({ ...OWNER, state_hash: 'hash-1' })).not.toBeNull();
    });

    it('drops abandoned consents so their client secrets do not linger', async () => {
      const store = getStore();
      const other = { tenant_id: 'tenant-a', created_by: 'user-b' };
      await store.savePending(pending({ ...other, created_at: '2020-01-01T00:00:00.000Z' }));

      await store.savePending(pending());

      expect(await store.takePending({ ...other, state_hash: 'hash-1' })).toBeNull();
    });

    it('drops an expired consent on any read, not only when someone begins', async () => {
      const store = getStore();
      await store.savePending(pending({ created_at: '2020-01-01T00:00:00.000Z' }));
      expect(await store.hasPending(OWNER)).toBe(false);

      await store.savePending(pending({ created_at: '2020-01-01T00:00:00.000Z' }));
      expect(await store.takePending({ ...OWNER, state_hash: 'hash-1' })).toBeNull();
    });

    it('keeps a fresh consent through a sweep', async () => {
      const store = getStore();
      await store.savePending(pending());
      await store.purgeExpiredPending();
      expect(await store.hasPending(OWNER)).toBe(true);
    });

    it('keeps the consent when the wrong state is offered, so the real attempt can still finish', async () => {
      const store = getStore();
      await store.savePending(pending());

      expect(await store.takePending({ ...OWNER, state_hash: 'forged' })).toBeNull();
      expect(await store.hasPending(OWNER)).toBe(true);
      expect(await store.takePending({ ...OWNER, state_hash: 'hash-1' })).not.toBeNull();
      expect(await store.hasPending(OWNER)).toBe(false);
    });

    it('clears a consent in flight whatever its state', async () => {
      const store = getStore();
      await store.savePending(pending());
      await store.clearPending(OWNER);
      expect(await store.hasPending(OWNER)).toBe(false);
    });
  });
}
