import { randomBytes } from 'node:crypto';

import {
  SecretDecryptError,
  SecretKeyMismatchError,
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  masterKeyId,
  type SecretContext,
} from '../../../src/secrets/secretCipher';

const key = randomBytes(32);
const context: SecretContext = { table: 'model_provider', primary_key: 't1/openai', field: 'api_key' };
const plaintext = 'sk-canary-0123456789abcdef';

function flipByte(value: string, index: number): string {
  const prefix = 'enc:v1:';
  const body = Buffer.from(value.slice(prefix.length), 'base64url');
  body[index] = (body[index] ?? 0) ^ 0x01;
  return `${prefix}${body.toString('base64url')}`;
}

describe('secretCipher', () => {
  it('round-trips a value and marks it as encrypted', () => {
    const value = encryptSecret({ key, plaintext, context });
    expect(isEncryptedSecret(value)).toBe(true);
    expect(value).not.toContain(plaintext);
    expect(decryptSecret({ key, value, context })).toBe(plaintext);
  });

  it('does not treat plain text as encrypted', () => {
    expect(isEncryptedSecret(plaintext)).toBe(false);
    expect(() => decryptSecret({ key, value: plaintext, context })).toThrow(SecretDecryptError);
  });

  it.each([
    ['nonce', 8],
    ['ciphertext', 8 + 12],
    ['tag', -1],
  ])('rejects a changed %s byte', (_part, offset) => {
    const value = encryptSecret({ key, plaintext, context });
    const length = Buffer.from(value.slice('enc:v1:'.length), 'base64url').length;
    const index = offset < 0 ? length + offset : offset;
    expect(() => decryptSecret({ key, value: flipByte(value, index), context })).toThrow(SecretDecryptError);
  });

  it.each([
    ['another row', { ...context, primary_key: 't1/anthropic' }],
    ['another field', { ...context, field: 'client_secret' }],
    ['another table', { ...context, table: 'mcp_server' }],
  ])('refuses a value moved to %s', (_case, moved: SecretContext) => {
    const value = encryptSecret({ key, plaintext, context });
    expect(() => decryptSecret({ key, value, context: moved })).toThrow(SecretDecryptError);
  });

  it('reports a different key separately from damage', () => {
    const value = encryptSecret({ key, plaintext, context });
    expect(() => decryptSecret({ key: randomBytes(32), value, context })).toThrow(SecretKeyMismatchError);
  });

  it('never repeats a nonce across 10,000 encryptions', () => {
    const nonces = new Set<string>();
    for (let i = 0; i < 10_000; i += 1) {
      const body = Buffer.from(encryptSecret({ key, plaintext, context }).slice('enc:v1:'.length), 'base64url');
      nonces.add(body.subarray(8, 20).toString('hex'));
    }
    expect(nonces.size).toBe(10_000);
  });

  it('keeps plaintext and key bytes out of error messages', () => {
    const value = encryptSecret({ key, plaintext, context });
    const errors: unknown[] = [];
    for (const attempt of [
      () => decryptSecret({ key, value: flipByte(value, 30), context }),
      () => decryptSecret({ key: randomBytes(32), value, context }),
    ]) {
      try {
        attempt();
      } catch (caught) {
        errors.push(caught);
      }
    }
    expect(errors).toHaveLength(2);
    const text = errors
      .map(error => (error instanceof Error ? `${error.message} ${String(error.stack)}` : ''))
      .join(' ');
    expect(text).not.toContain(plaintext);
    expect(text).not.toContain(key.toString('hex'));
    expect(text).not.toContain(key.toString('base64'));
  });

  it('rejects keys of the wrong length', () => {
    expect(() => encryptSecret({ key: randomBytes(16), plaintext, context })).toThrow('32 bytes');
    expect(() => masterKeyId(randomBytes(31))).toThrow('32 bytes');
  });
});
