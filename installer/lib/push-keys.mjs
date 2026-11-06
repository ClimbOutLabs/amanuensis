// One key pair for signing push notices (ECDSA P-256, as web push needs), with no dependencies beyond Node.js.
// Run as `node push-keys.mjs`: prints the public key, a space, then the private key, both URL-safe base64 without
// padding. The public key is the 65-byte uncompressed point and the private key the 32-byte scalar.

import { Buffer } from 'node:buffer';
import crypto from 'node:crypto';

export function pushKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = privateKey.export({ format: 'jwk' });
  const point = publicKey.export({ format: 'der', type: 'spki' }).subarray(-65);
  const scalar = Buffer.from(jwk.d ?? '', 'base64url');
  if (point.length !== 65 || point[0] !== 0x04 || scalar.length !== 32) {
    throw new Error('The push key pair came out in an unexpected shape.');
  }
  return { publicKey: point.toString('base64url'), privateKey: scalar.toString('base64url') };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const keys = pushKeyPair();
  process.stdout.write(`${keys.publicKey} ${keys.privateKey}\n`);
}
