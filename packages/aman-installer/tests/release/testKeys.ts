// The TEST key pair for this package's release tests. It is a test
// fixture only: the key compiled into the executable is the owner's
// real release public key (see src/release/releasePublicKey.ts), and
// tests that need a signature to check out pass this public part in
// as the stand-in key. The private part lives only here, in the
// tests, and signs nothing real. The real release key's private part
// never enters this repository.

export const TEST_PUBLIC_KEY_MINISIGN = 'RWS0Gj0C7C8Rs61nm8GmQwQmvsvt0yXPzlrvVDJqgVoKq9/xrzdWCIHR';
export const TEST_KEY_NUM_HEX = 'b41a3d02ec2f11b3';
export const TEST_PRIVATE_KEY_PKCS8_BASE64 = 'MC4CAQAwBQYDK2VwBCIEIDsHVA/TzWONEbCDEi1Sky8syG6VFTJq8rx2azwd7+Nc';

export function testPrivateKeyDer(): Uint8Array {
  return new Uint8Array(Buffer.from(TEST_PRIVATE_KEY_PKCS8_BASE64, 'base64'));
}

export function testKeyNum(): Uint8Array {
  return new Uint8Array(Buffer.from(TEST_KEY_NUM_HEX, 'hex'));
}
