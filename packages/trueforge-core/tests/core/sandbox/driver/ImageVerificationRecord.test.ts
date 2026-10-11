import { generateKeyPairSync, type KeyObject } from 'node:crypto';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cosignKeyFingerprint,
  imageVerificationRecordPath,
  readImageVerificationRecord,
  recordVouchesForSubject,
  writeImageVerificationRecord,
  type ImageVerificationRecord,
} from '../../../../src/core/sandbox/driver/ImageVerificationRecord';

const HEX = 'a'.repeat(64);
const RECORD: ImageVerificationRecord = {
  image_ref: `registry.example/sandbox:1@sha256:${HEX}`,
  image_digest: `sha256:${HEX}`,
  image_id: `sha256:${'1'.repeat(64)}`,
  key_fingerprint: `sha256:${'2'.repeat(64)}`,
  verified_at: '2026-01-02T03:04:05.000Z',
};

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-verification-record-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('verification record storage', () => {
  test('round-trips through a state dir that does not exist yet', async () => {
    const stateDir = join(dir, 'nested', 'state');
    await writeImageVerificationRecord({ stateDir, record: RECORD });
    await expect(readImageVerificationRecord({ stateDir })).resolves.toEqual(RECORD);
  });

  test('the record is private to the owner', async () => {
    await writeImageVerificationRecord({ stateDir: dir, record: RECORD });
    const { mode } = await stat(imageVerificationRecordPath({ stateDir: dir }));
    expect(mode & 0o077).toBe(0);
  });

  test('a later write replaces the earlier record', async () => {
    await writeImageVerificationRecord({ stateDir: dir, record: RECORD });
    const next = { ...RECORD, image_id: `sha256:${'3'.repeat(64)}` };
    await writeImageVerificationRecord({ stateDir: dir, record: next });
    await expect(readImageVerificationRecord({ stateDir: dir })).resolves.toEqual(next);
  });

  test.each([
    ['missing', undefined],
    ['not JSON', 'oops'],
    ['an array', '[]'],
    ['missing a field', JSON.stringify({ ...RECORD, key_fingerprint: undefined })],
    ['a malformed digest', JSON.stringify({ ...RECORD, image_digest: 'sha256:short' })],
    ['an unparseable timestamp', JSON.stringify({ ...RECORD, verified_at: 'yesterday' })],
  ])('a record that is %s reads as absent', async (_name, contents) => {
    if (contents !== undefined) {
      await writeFile(imageVerificationRecordPath({ stateDir: dir }), contents);
    }
    await expect(readImageVerificationRecord({ stateDir: dir })).resolves.toBeUndefined();
  });
});

describe('recordVouchesForSubject', () => {
  const subject = {
    image_ref: RECORD.image_ref,
    image_digest: RECORD.image_digest,
    image_id: RECORD.image_id,
    key_fingerprint: RECORD.key_fingerprint,
  };

  test('vouches only when every subject field matches', () => {
    expect(recordVouchesForSubject({ record: RECORD, subject })).toBe(true);
  });

  test.each(['image_ref', 'image_digest', 'image_id', 'key_fingerprint'] as const)(
    'does not vouch when %s differs',
    field => {
      expect(recordVouchesForSubject({ record: RECORD, subject: { ...subject, [field]: 'changed' } })).toBe(false);
    },
  );

  test('does not vouch without a record', () => {
    expect(recordVouchesForSubject({ record: undefined, subject })).toBe(false);
  });
});

describe('cosignKeyFingerprint', () => {
  function pemOf(key: KeyObject): string {
    return key.export({ type: 'spki', format: 'pem' }).toString();
  }

  test('is stable across PEM whitespace and line endings, and differs per key', async () => {
    const first = pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey);
    const second = pemOf(generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey);
    const firstPath = join(dir, 'first.pub');
    const reformattedPath = join(dir, 'reformatted.pub');
    const secondPath = join(dir, 'second.pub');
    await writeFile(firstPath, first);
    await writeFile(reformattedPath, `\n${first.replace(/\n/g, '\r\n')}\n\n`);
    await writeFile(secondPath, second);
    const fingerprint = await cosignKeyFingerprint({ keyPath: firstPath });
    expect(fingerprint).toMatch(/^sha256:[0-9a-f]{64}$/);
    await expect(cosignKeyFingerprint({ keyPath: reformattedPath })).resolves.toBe(fingerprint);
    await expect(cosignKeyFingerprint({ keyPath: secondPath })).resolves.not.toBe(fingerprint);
  });

  test('is undefined for a missing or unparseable key', async () => {
    const garbagePath = join(dir, 'garbage.pub');
    await writeFile(garbagePath, 'not a key');
    await expect(cosignKeyFingerprint({ keyPath: join(dir, 'missing.pub') })).resolves.toBeUndefined();
    await expect(cosignKeyFingerprint({ keyPath: garbagePath })).resolves.toBeUndefined();
  });
});
