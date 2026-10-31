import { createPrivateKey, createPublicKey, sign, verify, type KeyObject } from 'node:crypto';

import { blake2b512 } from './blake2b.ts';

// The minisign signature format, read and written with Node's built-in
// crypto only: a comment line, then one base64 line holding a two byte
// algorithm mark, an eight byte key number and the Ed25519 material.
// The algorithm mark is Ed for a signature over the file itself and ED
// for a signature over the file's Blake2b hash, the two forms the
// minisign tool writes.

const ALGORITHM_PLAIN = 'Ed';
const ALGORITHM_PREHASHED = 'ED';
const PUBLIC_KEY_BYTES = 42;
const SIGNATURE_BYTES = 74;

export interface MinisignPublicKey {
  keyNum: Uint8Array;
  key: Uint8Array;
}

export interface MinisignSignature {
  algorithm: string;
  keyNum: Uint8Array;
  signature: Uint8Array;
}

function base64Line(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (/^[A-Za-z0-9+/]+={0,2}$/.test(trimmed) && trimmed.length >= 8) {
      return trimmed;
    }
  }
  return null;
}

function decodeBase64(text: string): Uint8Array | null {
  const line = base64Line(text);
  if (line === null) {
    return null;
  }
  const bytes = Buffer.from(line, 'base64');
  // Buffer.from tolerates stray characters, so the round trip is what
  // proves the line was clean base64.
  if (bytes.toString('base64').replace(/=+$/, '') !== line.replace(/=+$/, '')) {
    return null;
  }
  return new Uint8Array(bytes);
}

function markOf(bytes: Uint8Array): string {
  const first = bytes[0];
  const second = bytes[1];
  if (first === undefined || second === undefined) {
    return '';
  }
  return String.fromCharCode(first, second);
}

export function parseMinisignPublicKey(text: string): MinisignPublicKey | null {
  const bytes = decodeBase64(text);
  if (bytes === null) {
    return null;
  }
  if (bytes.length !== PUBLIC_KEY_BYTES || markOf(bytes) !== ALGORITHM_PLAIN) {
    return null;
  }
  return { keyNum: bytes.subarray(2, 10), key: bytes.subarray(10, PUBLIC_KEY_BYTES) };
}

export function minisignPublicKeyBase64(publicKey: MinisignPublicKey): string {
  const bytes = new Uint8Array(PUBLIC_KEY_BYTES);
  bytes.set(new TextEncoder().encode(ALGORITHM_PLAIN), 0);
  bytes.set(publicKey.keyNum, 2);
  bytes.set(publicKey.key, 10);
  return Buffer.from(bytes).toString('base64');
}

export function parseMinisignSignature(text: string): MinisignSignature | null {
  const bytes = decodeBase64(text);
  if (bytes === null) {
    return null;
  }
  if (bytes.length !== SIGNATURE_BYTES) {
    return null;
  }
  const algorithm = markOf(bytes);
  if (algorithm !== ALGORITHM_PLAIN && algorithm !== ALGORITHM_PREHASHED) {
    return null;
  }
  return { algorithm, keyNum: bytes.subarray(2, 10), signature: bytes.subarray(10, SIGNATURE_BYTES) };
}

function publicKeyObject(key: Uint8Array): KeyObject {
  const jwk = { kty: 'OKP', crv: 'Ed25519', x: Buffer.from(key).toString('base64url') };
  return createPublicKey({ key: jwk, format: 'jwk' });
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

export function verifyMinisign({
  data,
  signatureText,
  publicKey,
}: {
  data: Uint8Array;
  signatureText: string;
  publicKey: MinisignPublicKey;
}): boolean {
  const parsed = parseMinisignSignature(signatureText);
  if (parsed === null || !sameBytes(parsed.keyNum, publicKey.keyNum)) {
    return false;
  }
  const signed = parsed.algorithm === ALGORITHM_PREHASHED ? blake2b512(data) : data;
  try {
    return verify(null, signed, publicKeyObject(publicKey.key), parsed.signature);
  } catch {
    return false;
  }
}

// Signs in the plain Ed form. The private key is a PKCS#8 Ed25519 key,
// the form a raw key file holds; the minisign tool's own secret key
// files stay the owner's, and either tool's output verifies the same.
export function signMinisign({
  data,
  privateKeyDer,
  keyNum,
}: {
  data: Uint8Array;
  privateKeyDer: Uint8Array;
  keyNum: Uint8Array;
}): string {
  const key = createPrivateKey({ key: Buffer.from(privateKeyDer), format: 'der', type: 'pkcs8' });
  const signature = sign(null, data, key);
  const bytes = new Uint8Array(SIGNATURE_BYTES);
  bytes.set(new TextEncoder().encode(ALGORITHM_PLAIN), 0);
  bytes.set(keyNum, 2);
  bytes.set(new Uint8Array(signature), 10);
  const encoded = Buffer.from(bytes).toString('base64');
  return `untrusted comment: signature from minisign secret key\n${encoded}\n`;
}

export function minisignPublicKeyText(publicKey: MinisignPublicKey): string {
  return `untrusted comment: minisign public key\n${minisignPublicKeyBase64(publicKey)}\n`;
}
