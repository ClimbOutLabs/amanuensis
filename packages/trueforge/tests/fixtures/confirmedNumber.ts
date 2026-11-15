import type { ITextContactStore } from '../../src/db/textContactStore';

/**
 * Leaves the person with `phone` confirmed, the way the code flow does, and optionally a new number still waiting
 * for its code beside it.
 */
export async function confirmNumber({
  store,
  owner,
  phone,
  pending,
  now,
}: {
  store: Pick<ITextContactStore, 'startCode' | 'confirmCode'>;
  owner: { tenant_id: string; created_by: string };
  phone: string;
  pending?: string;
  now: Date;
}): Promise<void> {
  const code = {
    hash: 'a'.repeat(64),
    salt: 'b'.repeat(32),
    key_id: 'test-key',
    expires_at: new Date(now.getTime() + 600_000).toISOString(),
  };
  await store.startCode({ ...owner, phone, as: 'number', code, now });
  await store.confirmCode({ ...owner, code_hash: code.hash, now });
  if (pending !== undefined) {
    await store.startCode({ ...owner, phone: pending, as: 'new_number', code: { ...code, hash: 'c'.repeat(64) }, now });
  }
}
