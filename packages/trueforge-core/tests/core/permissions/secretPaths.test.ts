import { containsSecretPath, namesSecretPath } from '../../../src/core/permissions/secretPaths';

describe('namesSecretPath', () => {
  test.each([
    '/home/u/.ssh/config',
    '~/.gnupg/secring.gpg',
    '/home/u/.aws/credentials',
    '/home/u/.kube/config',
    '/home/u/.docker/config.json',
    '/home/u/.netrc',
    '/home/u/.pgpass',
    '/app/.env',
    '/app/.env.production',
    '/home/u/.ssh/id_rsa',
    '/home/u/.ssh/id_ed25519',
    '/home/u/keys/id_ecdsa',
    'config/server.pem',
    'config/server.key',
    'certs/client.p12',
    'certs/client.pfx',
    '/etc/app/secret',
    '/etc/app/secrets.json',
    '/etc/app/token.json',
    '/etc/app/tokens',
    'credentials',
    'credentials.backup.json',
    'secret',
    'id_rsa',
  ])('blocks the secret path %s', value => {
    expect(namesSecretPath(value)).toBe(true);
  });

  test('blocks a Windows backslash path to an SSH key', () => {
    expect(namesSecretPath('C:\\Users\\u\\.ssh\\id_rsa')).toBe(true);
  });

  test('blocks a path to an SSH key inside a quoted command word', () => {
    expect(namesSecretPath("cat '~/.ssh/id_rsa'")).toBe(true);
  });

  test('blocks a bare secret name that is the whole value, even with quotes or spaces around it', () => {
    expect(namesSecretPath('  credentials  ')).toBe(true);
    expect(namesSecretPath("'credentials'")).toBe(true);
  });

  test('blocks a very long path with no whitespace that ends in an SSH key', () => {
    const long = `${'/a'.repeat(4000)}/.ssh/id_rsa`;
    expect(long.length).toBeGreaterThan(4096);
    expect(namesSecretPath(long)).toBe(true);
  });

  test('scans a 100,000-character string quickly, with and without a secret at its end', () => {
    const plain = 'a/'.repeat(50_000);
    const secret = `${'a/'.repeat(49_990)}.ssh/id_rsa`;
    const started = performance.now();
    expect(namesSecretPath(plain)).toBe(false);
    expect(namesSecretPath(secret)).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
  });

  test.each([
    '/work/secretary/notes.md',
    '/repo/src/tokenizer.ts',
    '/home/u/notes/todo.md',
    'my token budget and secret santa plans',
    'weather in Lisbon this weekend',
    'the token.',
    'e.g. a plain query',
  ])('does not block the ordinary value %s', value => {
    expect(namesSecretPath(value)).toBe(false);
  });
});

describe('containsSecretPath', () => {
  test('finds a secret path at any key and depth', () => {
    expect(containsSecretPath({ a: { b: [{ c: '/home/u/.ssh/id_rsa' }] } })).toBe(true);
    expect(containsSecretPath({ unusual_name: 'credentials.backup.json' })).toBe(true);
  });

  test('ignores key names and non-string values', () => {
    expect(containsSecretPath({ '/home/u/.ssh/id_rsa': 'notes.md' })).toBe(false);
    expect(containsSecretPath({ count: 3, flag: true, nothing: null })).toBe(false);
  });

  test('keeps ordinary arguments, including free text that mentions a secret word', () => {
    expect(containsSecretPath({ attachment_path: '/work/secretary/notes.md' })).toBe(false);
    expect(containsSecretPath({ note: 'my token budget and secret santa plans' })).toBe(false);
  });
});
