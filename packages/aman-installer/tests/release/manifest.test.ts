import assert from 'node:assert/strict';
import { createPrivateKey, generateKeyPairSync, sign } from 'node:crypto';
import { test } from 'node:test';

import {
  VERIFY_SIGNATURE_BAD,
  VERIFY_SOURCE_IDS_MISMATCH,
  problemText,
  verifyChangedProblem,
  verifyNotListedProblem,
} from '../../src/messages.ts';
import { blake2b512 } from '../../src/release/blake2b.ts';
import { buildManifest, manifestToBytes, parseManifest, type SourceIds } from '../../src/release/manifest.ts';
import {
  minisignPublicKeyBase64,
  minisignPublicKeyText,
  parseMinisignPublicKey,
  signMinisign,
  verifyMinisign,
} from '../../src/release/minisign.ts';
import { RELEASE_PUBLIC_KEY_MINISIGN } from '../../src/release/releasePublicKey.ts';
import { checkDownloadedFile, checkSignedManifest, checkSourceIds } from '../../src/release/verify.ts';
import { TEST_PUBLIC_KEY_MINISIGN, testKeyNum, testPrivateKeyDer } from './testKeys.ts';

const IDS: SourceIds = {
  'aman-app': 'aman-app:0123456789ab',
  'aman-stt': 'aman-stt:0123456789cd',
  'aman-calendar-caldav': 'aman-calendar-caldav:0123456789ef',
};

const FILES = [
  { name: 'aman-linux-x64', data: new TextEncoder().encode('linux build') },
  { name: 'aman-windows-x64.exe', data: new TextEncoder().encode('windows build') },
  { name: 'aman-source.tar.gz', data: new TextEncoder().encode('source archive') },
];

function hexOf(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex');
}

test('blake2b matches the published test vectors', () => {
  assert.equal(
    hexOf(blake2b512(new Uint8Array(0))),
    '786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce',
  );
  assert.equal(
    hexOf(blake2b512(new TextEncoder().encode('abc'))),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
});

test('the compiled-in public key is the release key and parses', () => {
  const parsed = parseMinisignPublicKey(RELEASE_PUBLIC_KEY_MINISIGN);
  assert.ok(parsed !== null);
  assert.equal(minisignPublicKeyBase64(parsed), RELEASE_PUBLIC_KEY_MINISIGN);
  const fromText = parseMinisignPublicKey(minisignPublicKeyText(parsed));
  assert.ok(fromText !== null);
  assert.equal(minisignPublicKeyBase64(fromText), RELEASE_PUBLIC_KEY_MINISIGN);
  // The key number, read little-endian from the key bytes, is the one
  // named in the comment line of the owner's published public key.
  const keyNumber = Buffer.from(parsed.keyNum).readBigUInt64LE(0).toString(16).padStart(16, '0').toUpperCase();
  assert.equal(keyNumber, 'B0DFF7A12F1D697C');
});

test('a built manifest parses back to the same record', () => {
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  const bytes = manifestToBytes(manifest);
  assert.deepEqual(parseManifest(bytes), manifest);
  // The signed bytes are fixed: building again gives the same bytes.
  assert.deepEqual(manifestToBytes(buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS })), bytes);
});

test('a signed manifest checks out against the key that signed it', () => {
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  const bytes = manifestToBytes(manifest);
  const signatureText = signMinisign({ data: bytes, privateKeyDer: testPrivateKeyDer(), keyNum: testKeyNum() });
  const checked = checkSignedManifest({
    manifestBytes: bytes,
    signatureText,
    publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN,
  });
  assert.ok('manifest' in checked);
  assert.deepEqual(checked.manifest, manifest);
});

test('a manifest signed with the test key is refused against the compiled-in key', () => {
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  const bytes = manifestToBytes(manifest);
  const signatureText = signMinisign({ data: bytes, privateKeyDer: testPrivateKeyDer(), keyNum: testKeyNum() });
  // No key is passed in, so the compiled-in release key is the one
  // that counts, and the test key's signature must not check out.
  const checked = checkSignedManifest({ manifestBytes: bytes, signatureText });
  assert.ok('problem' in checked);
  assert.equal(problemText(checked.problem), problemText(VERIFY_SIGNATURE_BAD));
});

test('a changed source id in the signed bytes is refused as a bad signature', () => {
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  const bytes = manifestToBytes(manifest);
  const signatureText = signMinisign({ data: bytes, privateKeyDer: testPrivateKeyDer(), keyNum: testKeyNum() });
  const tampered = buildManifest({
    release: 'v1.2.3',
    files: FILES,
    sourceIds: { ...IDS, 'aman-app': 'aman-app:ffffffffffff' },
  });
  const checked = checkSignedManifest({
    manifestBytes: manifestToBytes(tampered),
    signatureText,
    publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN,
  });
  assert.ok('problem' in checked);
  assert.equal(problemText(checked.problem), problemText(VERIFY_SIGNATURE_BAD));
});

test('a signature from another key is refused', () => {
  const other = generateKeyPairSync('ed25519');
  const der = new Uint8Array(other.privateKey.export({ format: 'der', type: 'pkcs8' }));
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  const bytes = manifestToBytes(manifest);
  const signatureText = signMinisign({ data: bytes, privateKeyDer: der, keyNum: testKeyNum() });
  const checked = checkSignedManifest({
    manifestBytes: bytes,
    signatureText,
    publicKeyBase64: TEST_PUBLIC_KEY_MINISIGN,
  });
  assert.ok('problem' in checked);
  assert.equal(problemText(checked.problem), problemText(VERIFY_SIGNATURE_BAD));
});

test('a changed download is refused, and an unlisted one is refused', () => {
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  const good = FILES[0];
  assert.ok(good !== undefined);
  assert.equal(checkDownloadedFile({ manifest, fileName: good.name, data: good.data }), null);
  const changed = checkDownloadedFile({
    manifest,
    fileName: good.name,
    data: new TextEncoder().encode('windows build'),
  });
  assert.ok(changed !== null);
  assert.equal(problemText(changed), problemText(verifyChangedProblem(good.name)));
  const unlisted = checkDownloadedFile({ manifest, fileName: 'aman-darwin-arm64', data: good.data });
  assert.ok(unlisted !== null);
  assert.equal(problemText(unlisted), problemText(verifyNotListedProblem('aman-darwin-arm64')));
});

test('source ids that differ from the checkout are refused', () => {
  const manifest = buildManifest({ release: 'v1.2.3', files: FILES, sourceIds: IDS });
  assert.equal(checkSourceIds({ manifest, expected: IDS }), null);
  const problem = checkSourceIds({
    manifest,
    expected: { ...IDS, 'aman-stt': 'aman-stt:ffffffffffff' },
  });
  assert.ok(problem !== null);
  assert.equal(problemText(problem), problemText(VERIFY_SOURCE_IDS_MISMATCH));
});

test('a pre-hashed (ED) minisign signature verifies', () => {
  const parsed = parseMinisignPublicKey(TEST_PUBLIC_KEY_MINISIGN);
  assert.ok(parsed !== null);
  const data = new TextEncoder().encode('a release record');
  // Sign the Blake2b hash with the test key and mark the format ED,
  // the shape the minisign tool writes for a pre-hashed signature.
  const key = createPrivateKey({ key: Buffer.from(testPrivateKeyDer()), format: 'der', type: 'pkcs8' });
  const signature = sign(null, blake2b512(data), key);
  const bytes = new Uint8Array(74);
  bytes.set(new TextEncoder().encode('ED'), 0);
  bytes.set(testKeyNum(), 2);
  bytes.set(new Uint8Array(signature), 10);
  const text = `untrusted comment: signature from minisign secret key\n${Buffer.from(bytes).toString('base64')}\n`;
  assert.equal(verifyMinisign({ data, signatureText: text, publicKey: parsed }), true);
  assert.equal(
    verifyMinisign({ data: new TextEncoder().encode('other bytes'), signatureText: text, publicKey: parsed }),
    false,
  );
});
