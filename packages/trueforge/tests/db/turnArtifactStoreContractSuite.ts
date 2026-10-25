import type { ITurnArtifactStore, TurnArtifactIdentityInput } from '../../src/db/turnArtifactStore';

const OWNER = { tenant_id: 'default', session_id: 's1', turn_id: 't1' };

export interface TurnArtifactContractFixtures {
  getStore: () => ITurnArtifactStore;
  /**
   * Test seam: rewrites created_at on one index row so retention tests can age
   * rows without widening the store API with a test-only timestamp override.
   */
  backdate: (identity: TurnArtifactIdentityInput & { created_at: string }) => Promise<void>;
}

const daysAgo = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

export function runTurnArtifactStoreContractSuite(fixtures: TurnArtifactContractFixtures): void {
  const { getStore, backdate } = fixtures;
  it('stores a blob and index row, content-addressed by sha256 digest', async () => {
    const store = getStore();
    const data = Buffer.from('the finished tribute video');

    const record = await store.recordStoredArtifact({
      ...OWNER,
      path: '/opt/tf/workspace/tribute.mp4',
      name: 'Lily James tribute video',
      data,
      mime: 'application/octet-stream',
    });

    expect(record.status).toBe('stored');
    expect(record.name).toBe('Lily James tribute video');
    expect(record.size).toBe(data.length);
    expect(record.digest).toMatch(/^[0-9a-f]{64}$/);
    expect(record.created_at).toBeTruthy();

    const fetched = await store.getArtifact({ ...OWNER, path: '/opt/tf/workspace/tribute.mp4' });
    expect(fetched).toEqual(record);

    const blob = await store.getBlob({ tenant_id: OWNER.tenant_id, digest: record.digest ?? '' });
    expect(blob).toEqual(data);
  });

  it('deduplicates identical bytes across two different turns into one blob row', async () => {
    const store = getStore();
    const data = Buffer.from('shared content');

    const first = await store.recordStoredArtifact({
      ...OWNER,
      path: '/tmp/a.txt',
      name: 'a.txt',
      data,
      mime: 'application/octet-stream',
    });
    const second = await store.recordStoredArtifact({
      tenant_id: 'default',
      session_id: 's2',
      turn_id: 't2',
      path: '/tmp/b.txt',
      name: 'b.txt',
      data,
      mime: 'application/octet-stream',
    });

    expect(first.digest).toBe(second.digest);
    expect(await store.getBlob({ tenant_id: 'default', digest: first.digest ?? '' })).toEqual(data);
  });

  it('records a skipped-for-size artifact with no blob', async () => {
    const store = getStore();

    const record = await store.recordSkippedArtifact({
      ...OWNER,
      path: '/tmp/huge.bin',
      name: 'huge.bin',
      status: 'skipped_size',
      skip_reason: 'File too large: /tmp/huge.bin (30000000 bytes, max 26214400)',
      size: 30_000_000,
    });

    expect(record.status).toBe('skipped_size');
    expect(record.digest).toBeNull();
    expect(record.mime).toBeNull();
    expect(record.size).toBe(30_000_000);
    expect(record.skip_reason).toContain('too large');

    expect(await store.getArtifact({ ...OWNER, path: '/tmp/huge.bin' })).toEqual(record);
  });

  it('records a skipped-missing artifact with no size', async () => {
    const store = getStore();

    const record = await store.recordSkippedArtifact({
      ...OWNER,
      path: '/tmp/gone.txt',
      name: 'gone.txt',
      status: 'skipped_missing',
      skip_reason: 'File not found: /tmp/gone.txt',
    });

    expect(record.status).toBe('skipped_missing');
    expect(record.size).toBeNull();
    expect(record.digest).toBeNull();
  });

  it('returns undefined for a turn/path with no persisted row', async () => {
    const store = getStore();
    expect(await store.getArtifact({ ...OWNER, path: '/tmp/never-declared.txt' })).toBeUndefined();
  });

  it('returns undefined for a digest with no blob', async () => {
    const store = getStore();
    expect(await store.getBlob({ tenant_id: 'default', digest: 'f'.repeat(64) })).toBeUndefined();
  });

  it('is idempotent: recording the same turn/path twice overwrites the row, not conflicts', async () => {
    const store = getStore();
    await store.recordSkippedArtifact({
      ...OWNER,
      path: '/tmp/retry.bin',
      name: 'retry.bin',
      status: 'skipped_size',
      skip_reason: 'first attempt: too large',
      size: 1,
    });

    const data = Buffer.from('now it fits');
    const record = await store.recordStoredArtifact({
      ...OWNER,
      path: '/tmp/retry.bin',
      name: 'retry.bin',
      data,
      mime: 'application/octet-stream',
    });

    expect(record.status).toBe('stored');
    const fetched = await store.getArtifact({ ...OWNER, path: '/tmp/retry.bin' });
    expect(fetched?.status).toBe('stored');
    expect(fetched?.digest).toBe(record.digest);
  });

  it('scopes artifacts by session and turn: the same path in a different turn is a different row', async () => {
    const store = getStore();
    await store.recordStoredArtifact({
      ...OWNER,
      path: '/tmp/report.pdf',
      name: 'report.pdf',
      data: Buffer.from('turn 1 report'),
      mime: 'application/octet-stream',
    });

    expect(
      await store.getArtifact({ tenant_id: 'default', session_id: 's1', turn_id: 't2', path: '/tmp/report.pdf' }),
    ).toBeUndefined();
  });

  it('retention: keeps rows newer than the cutoff, and their blobs', async () => {
    const store = getStore();
    const data = Buffer.from('still fresh');
    const record = await store.recordStoredArtifact({
      ...OWNER,
      path: '/tmp/fresh.txt',
      name: 'fresh.txt',
      data,
      mime: 'application/octet-stream',
    });
    await backdate({ ...OWNER, path: '/tmp/fresh.txt', created_at: daysAgo(10) });

    const deleted = await store.deleteArtifactsOlderThan({ older_than: daysAgo(30) });

    expect(deleted).toBe(0);
    expect(await store.getArtifact({ ...OWNER, path: '/tmp/fresh.txt' })).toBeDefined();
    expect(await store.getBlob({ tenant_id: OWNER.tenant_id, digest: record.digest ?? '' })).toEqual(data);
  });

  it('retention: deletes rows older than the cutoff, and blobs no row references', async () => {
    const store = getStore();
    const data = Buffer.from('long gone');
    const record = await store.recordStoredArtifact({
      ...OWNER,
      path: '/tmp/old.txt',
      name: 'old.txt',
      data,
      mime: 'application/octet-stream',
    });
    await backdate({ ...OWNER, path: '/tmp/old.txt', created_at: daysAgo(40) });

    const deleted = await store.deleteArtifactsOlderThan({ older_than: daysAgo(30) });

    expect(deleted).toBe(1);
    expect(await store.getArtifact({ ...OWNER, path: '/tmp/old.txt' })).toBeUndefined();
    expect(await store.getBlob({ tenant_id: OWNER.tenant_id, digest: record.digest ?? '' })).toBeUndefined();
  });

  it('retention: keeps a blob still referenced by a surviving row', async () => {
    const store = getStore();
    const data = Buffer.from('shared bytes');
    const oldIdentity = { tenant_id: 'default', session_id: 's1', turn_id: 't1', path: '/tmp/shared-a.txt' };
    const newIdentity = { tenant_id: 'default', session_id: 's1', turn_id: 't2', path: '/tmp/shared-b.txt' };
    await store.recordStoredArtifact({ ...oldIdentity, name: 'shared-a.txt', data, mime: 'application/octet-stream' });
    const survivor = await store.recordStoredArtifact({
      ...newIdentity,
      name: 'shared-b.txt',
      data,
      mime: 'application/octet-stream',
    });
    await backdate({ ...oldIdentity, created_at: daysAgo(40) });

    const deleted = await store.deleteArtifactsOlderThan({ older_than: daysAgo(30) });

    expect(deleted).toBe(1);
    expect(await store.getArtifact(oldIdentity)).toBeUndefined();
    expect(await store.getArtifact(newIdentity)).toBeDefined();
    expect(await store.getBlob({ tenant_id: 'default', digest: survivor.digest ?? '' })).toEqual(data);
  });

  it("deletes one chat's rows and unshared blobs, and leaves another chat's alone", async () => {
    const store = getStore();
    const mine = { tenant_id: 'default', session_id: 'wipe-me', turn_id: 't1', path: '/tmp/mine.txt' };
    const shared = { tenant_id: 'default', session_id: 'wipe-me', turn_id: 't1', path: '/tmp/shared-mine.txt' };
    const other = { tenant_id: 'default', session_id: 'keep-me', turn_id: 't1', path: '/tmp/shared-other.txt' };
    const mineRecord = await store.recordStoredArtifact({
      ...mine,
      name: 'mine.txt',
      data: Buffer.from('only in the wiped chat'),
      mime: 'text/plain',
    });
    const sharedData = Buffer.from('in both chats');
    await store.recordStoredArtifact({ ...shared, name: 'shared-mine.txt', data: sharedData, mime: 'text/plain' });
    const otherRecord = await store.recordStoredArtifact({
      ...other,
      name: 'shared-other.txt',
      data: sharedData,
      mime: 'text/plain',
    });

    const deleted = await store.deleteArtifactsForSession({ tenant_id: 'default', session_id: 'wipe-me' });

    expect(deleted).toBe(2);
    expect(await store.getArtifact(mine)).toBeUndefined();
    expect(await store.getBlob({ tenant_id: 'default', digest: mineRecord.digest ?? '' })).toBeUndefined();
    expect(await store.getArtifact(other)).toBeDefined();
    expect(await store.getBlob({ tenant_id: 'default', digest: otherRecord.digest ?? '' })).toEqual(sharedData);
    expect(await store.deleteArtifactsForSession({ tenant_id: 'default', session_id: 'wipe-me' })).toBe(0);
  });
}
