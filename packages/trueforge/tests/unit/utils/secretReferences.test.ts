import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  isSecretReference,
  parseSecretReference,
  resolveSecretReference,
  SecretReferenceError,
} from '../../../src/utils/secretReferences';

describe('isSecretReference / parseSecretReference', () => {
  it('detects exact-match env and file references', () => {
    expect(isSecretReference('${env:LKOS_TOKEN}')).toBe(true);
    expect(parseSecretReference('${env:LKOS_TOKEN}')).toEqual({ kind: 'env', name: 'LKOS_TOKEN' });

    expect(isSecretReference('${file:/data/secrets/lkos-token}')).toBe(true);
    expect(parseSecretReference('${file:/data/secrets/lkos-token}')).toEqual({
      kind: 'file',
      path: '/data/secrets/lkos-token',
    });
  });

  it('treats a value merely containing a reference-like substring as a literal', () => {
    const literals = [
      'prefix${env:FOO}',
      '${env:FOO}suffix',
      'Bearer ${env:FOO}',
      '${env:FOO} ${env:BAR}',
      '${FOO}',
      '${unknown:FOO}',
      '$env:FOO',
      'env:FOO',
      '',
    ];
    for (const literal of literals) {
      expect(isSecretReference(literal)).toBe(false);
      expect(parseSecretReference(literal)).toBeUndefined();
    }
  });

  it('rejects an empty name/path as not a reference', () => {
    expect(isSecretReference('${env:}')).toBe(false);
    expect(isSecretReference('${file:}')).toBe(false);
    expect(parseSecretReference('${env:}')).toBeUndefined();
    expect(parseSecretReference('${file:}')).toBeUndefined();
  });
});

describe('resolveSecretReference — env', () => {
  const VAR_NAME = 'SECRET_REFERENCES_TEST_VAR';

  afterEach(() => {
    delete process.env[VAR_NAME];
  });

  it('resolves from the process environment', async () => {
    process.env[VAR_NAME] = 'super-secret-value';
    await expect(resolveSecretReference(`\${env:${VAR_NAME}}`)).resolves.toBe('super-secret-value');
  });

  it('fails with a message naming the reference and variable, never the value', async () => {
    delete process.env[VAR_NAME];
    const reference = `\${env:${VAR_NAME}}`;
    await expect(resolveSecretReference(reference)).rejects.toThrow(SecretReferenceError);
    await expect(resolveSecretReference(reference)).rejects.toMatchObject({
      message: expect.stringContaining(reference),
    });
    await expect(resolveSecretReference(reference)).rejects.toMatchObject({
      message: expect.stringContaining(VAR_NAME),
    });
  });
});

describe('resolveSecretReference — file', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'tfy-secret-ref-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('resolves file content trimmed of a single trailing newline', async () => {
    const filePath = join(dir, 'token-lf');
    await writeFile(filePath, 'file-secret-value\n', 'utf-8');
    await expect(resolveSecretReference(`\${file:${filePath}}`)).resolves.toBe('file-secret-value');
  });

  it('trims multiple trailing newlines and CRLF, but no other whitespace', async () => {
    const filePath = join(dir, 'token-crlf');
    await writeFile(filePath, '  file-secret-value  \r\n\r\n', 'utf-8');
    await expect(resolveSecretReference(`\${file:${filePath}}`)).resolves.toBe('  file-secret-value  ');
  });

  it('does not trim when there is no trailing newline', async () => {
    const filePath = join(dir, 'token-no-newline');
    await writeFile(filePath, 'file-secret-value', 'utf-8');
    await expect(resolveSecretReference(`\${file:${filePath}}`)).resolves.toBe('file-secret-value');
  });

  it('fails with a message naming the reference and path, never the value', async () => {
    const filePath = join(dir, 'does-not-exist');
    const reference = `\${file:${filePath}}`;
    await expect(resolveSecretReference(reference)).rejects.toThrow(SecretReferenceError);
    await expect(resolveSecretReference(reference)).rejects.toMatchObject({
      message: expect.stringContaining(reference),
    });
  });

  it('re-reads the file on every call — rotation is picked up without any restart', async () => {
    const filePath = join(dir, 'token-rotating');
    await writeFile(filePath, 'first-value\n', 'utf-8');
    const reference = `\${file:${filePath}}`;

    await expect(resolveSecretReference(reference)).resolves.toBe('first-value');

    await writeFile(filePath, 'second-value\n', 'utf-8');
    await expect(resolveSecretReference(reference)).resolves.toBe('second-value');
  });
});
