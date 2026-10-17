/**
 * Backend-agnostic behavioural contract for IChatImageStore. Sessions `s1` and `s2` exist before each
 * test; `deleteSession` removes one through the session store, as deleting a chat does.
 */
import type { IChatImageStore, PutChatImageInput } from '../../src/db/chatImageStore';

const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function image(overrides: Partial<PutChatImageInput> = {}): PutChatImageInput {
  return {
    tenant_id: 'default',
    created_by: 'user-a',
    session_id: 's1',
    turn_id: 't1',
    image_id: 'a'.repeat(32),
    source_key: 'upload:0',
    origin: 'local',
    mime: 'image/png',
    width: 4,
    height: 3,
    data: Buffer.from('invented-png-bytes'),
    user_max_bytes: 1024 * 1024,
    ...overrides,
  };
}

export function runChatImageStoreContractSuite(
  getEnv: () => { store: IChatImageStore; deleteSession: (sessionId: string) => Promise<void> },
): void {
  it('stores an image and reads it back with its bytes', async () => {
    const { store } = getEnv();
    const stored = await store.putImage(image());
    expect(stored).toMatchObject({ session_id: 's1', image_id: 'a'.repeat(32), size: 18, mime: 'image/png' });
    expect(stored.created_at).toMatch(ISO_UTC);
    const read = await store.getImage({ tenant_id: 'default', session_id: 's1', image_id: 'a'.repeat(32) });
    expect(read?.data.toString()).toBe('invented-png-bytes');
    expect(read?.width).toBe(4);
  });

  it('does not serve an image to another chat or tenant', async () => {
    const { store } = getEnv();
    await store.putImage(image());
    expect(await store.getImage({ tenant_id: 'default', session_id: 's2', image_id: 'a'.repeat(32) })).toBeUndefined();
    expect(await store.getImage({ tenant_id: 'other', session_id: 's1', image_id: 'a'.repeat(32) })).toBeUndefined();
  });

  it('returns the image already stored for the same source', async () => {
    const { store } = getEnv();
    const first = await store.putImage(image());
    const second = await store.putImage(image({ image_id: 'b'.repeat(32), data: Buffer.from('other') }));
    expect(second.image_id).toBe(first.image_id);
    expect(await store.findBySource({ tenant_id: 'default', session_id: 's1', source_key: 'upload:0' })).toEqual(first);
  });

  it('takes silent attempts up to the limit, per turn, even when asked concurrently', async () => {
    const { store } = getEnv();
    const turn = { tenant_id: 'default', session_id: 's1', turn_id: 't1' };
    const taken = await Promise.all(
      Array.from({ length: 30 }, () => store.reserveSilentAttempt({ ...turn, limit: 20 })),
    );
    expect(taken.filter(Boolean)).toHaveLength(20);
    expect(await store.countSilentAttempts(turn)).toBe(20);
    expect(await store.reserveSilentAttempt({ ...turn, limit: 20 })).toBe(false);
    expect(await store.countSilentAttempts({ ...turn, turn_id: 't2' })).toBe(0);
    expect(await store.reserveSilentAttempt({ ...turn, turn_id: 't2', limit: 20 })).toBe(true);
    expect(await store.reserveSilentAttempt({ ...turn, session_id: 's2', limit: 0 })).toBe(false);
    expect(await store.countSilentAttempts({ ...turn, session_id: 's2' })).toBe(0);
  });

  it('removes the user oldest images past the size cap, never the new one', async () => {
    const { store } = getEnv();
    const ten = Buffer.alloc(10, 1);
    await store.putImage(image({ image_id: '1'.repeat(32), source_key: 'k1', data: ten, user_max_bytes: 25 }));
    await new Promise(resolve => setTimeout(resolve, 5));
    await store.putImage(image({ image_id: '2'.repeat(32), source_key: 'k2', data: ten, user_max_bytes: 25 }));
    await new Promise(resolve => setTimeout(resolve, 5));
    // Another user's images never count against this user.
    await store.putImage(
      image({ created_by: 'user-b', session_id: 's2', image_id: '9'.repeat(32), data: ten, user_max_bytes: 25 }),
    );
    await store.putImage(image({ image_id: '3'.repeat(32), source_key: 'k3', data: ten, user_max_bytes: 25 }));
    const has = async (sessionId: string, id: string) =>
      (await store.getImage({ tenant_id: 'default', session_id: sessionId, image_id: id.repeat(32) })) !== undefined;
    expect(await has('s1', '1')).toBe(false);
    expect(await has('s1', '2')).toBe(true);
    expect(await has('s1', '3')).toBe(true);
    expect(await has('s2', '9')).toBe(true);
  });

  it('deletes images and silent attempts with their chat', async () => {
    const { store, deleteSession } = getEnv();
    await store.putImage(image());
    await store.reserveSilentAttempt({ tenant_id: 'default', session_id: 's1', turn_id: 't1', limit: 20 });
    await deleteSession('s1');
    expect(await store.getImage({ tenant_id: 'default', session_id: 's1', image_id: 'a'.repeat(32) })).toBeUndefined();
    expect(await store.countSilentAttempts({ tenant_id: 'default', session_id: 's1', turn_id: 't1' })).toBe(0);
  });

  it('expires images older than the retention cut-off', async () => {
    const { store } = getEnv();
    await store.putImage(image());
    expect(await store.deleteImagesOlderThan({ older_than: '2000-01-01T00:00:00.000Z' })).toBe(0);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await store.deleteImagesOlderThan({ older_than: future })).toBe(1);
    expect(await store.getImage({ tenant_id: 'default', session_id: 's1', image_id: 'a'.repeat(32) })).toBeUndefined();
  });
}
