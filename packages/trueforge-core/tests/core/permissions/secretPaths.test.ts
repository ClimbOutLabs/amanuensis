import { containsPathLikeValue, containsSecretPath, namesSecretPath } from '../../../src/core/permissions/secretPaths';

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
    '/home/u/.git-credentials',
    '/home/u/client_secret.json',
    '/home/u/.config/gcloud/application_default_credentials.json',
    '/home/u/notes/github_token.txt',
    '/home/u/notes/db-password.txt',
    '/home/u/notes/api_key.apikey',
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
    '/home/u/keyboard/layout.md',
    '/home/u/notes/monkey.md',
    '/home/u/notes/apiaries.md',
    '/home/u/keys/notes.md',
    '/home/u/notes/key-ideas.md',
    '/home/u/notes/access-log.md',
    '/home/u/notes/sessionNotes.md',
    '/home/u/notes/Tokenizer.ts',
    '/home/u/notes/secretary_plan.md',
    '/home/u/notes/Passwordless.md',
    'my token budget and secret santa plans',
    'weather in Lisbon this weekend',
    'the token.',
    'e.g. a plain query',
  ])('does not block the ordinary value %s', value => {
    expect(namesSecretPath(value)).toBe(false);
  });
});

describe('namesSecretPath with split words', () => {
  const PAIRS: Array<[string, string]> = [
    ['api', 'key'],
    ['private', 'key'],
    ['access', 'key'],
    ['secret', 'key'],
    ['client', 'secret'],
    ['auth', 'token'],
    ['refresh', 'token'],
    ['session', 'token'],
  ];

  const capitalise = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`;

  test.each(
    PAIRS.flatMap(([first, second]) => [
      `${first}_${second}.txt`,
      `${first}-${second}.txt`,
      `${first}.${second}.txt`,
      `${first}${capitalise(second)}.txt`,
      `${capitalise(first)}${capitalise(second)}.txt`,
      `${first.toUpperCase()}_${second.toUpperCase()}.txt`,
      `${first}_${second}s.txt`,
      `${first}${capitalise(second)}s.txt`,
      `${first}-${second}s.txt`,
    ]),
  )('blocks a secret pair written as %s', name => {
    expect(namesSecretPath(`/home/u/notes/${name}`)).toBe(true);
    expect(namesSecretPath(name)).toBe(true);
  });

  test.each([
    'apiKey',
    'APIKey',
    'API_KEY',
    'accessKeyId',
    'privateKey',
    'clientSecret',
    'authToken',
    'refresh_token',
    'sessionToken',
  ])('blocks a two-word secret name %s when it is the whole value', name => {
    expect(namesSecretPath(name)).toBe(true);
  });

  test.each([
    '/home/u/notes/passwords.txt',
    '/home/u/notes/credential.txt',
    '/home/u/notes/Credentials',
    '/home/u/notes/tokens.json',
    '/home/u/notes/apiKeys.csv',
    '/home/u/notes/privkeys.txt',
    '/home/u/notes/PASSWORD.txt',
    '/home/u/notes/passwd',
    '/home/u/notes/apikey.txt',
    '/home/u/notes/privKey.txt',
    '/home/u/notes/SecretKey.json',
  ])('blocks the single secret word or plural in %s', value => {
    expect(namesSecretPath(value)).toBe(true);
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

describe('namesSecretPath splits letters from digits', () => {
  test.each(['/home/u/notes/token2.txt', '/home/u/notes/apikey2.json', 'token2'])('%s is secret', value => {
    expect(namesSecretPath(value)).toBe(true);
  });

  test('keeps ordinary names with digits', () => {
    expect(namesSecretPath('/home/u/notes/keyboard2.md')).toBe(false);
    expect(namesSecretPath('/home/u/notes/oauth2.md')).toBe(false);
  });
});

describe('namesSecretPath checks a path with spaces as one path', () => {
  test.each(['/home/u/api keys/notes.md', '/work/my tokens/plan.md', 'C:\\Users\\u\\Private Keys\\note.txt'])(
    '%s is secret',
    value => {
      expect(namesSecretPath(value)).toBe(true);
    },
  );

  test('keeps an ordinary path with spaces', () => {
    expect(namesSecretPath('/home/u/My Notes/plan.md')).toBe(false);
  });
});

describe('containsPathLikeValue', () => {
  test.each([
    ['a slash path', { a: '/work/notes' }],
    ['a backslash path', { a: 'notes\\plan' }],
    ['a home path', { a: '~/Documents' }],
    ['a drive path', { a: 'D:' }],
    ['a file name with an extension', { file: 'todo.md' }],
    ['a file name with spaces and an extension', { file: 'Q3 report final.pdf' }],
    ['a file name with a trailing comma', { file: 'see report.pdf, then reply' }],
    ['a path nested in a list', { items: [{ files: ['exports/2026.csv'] }] }],
    ['a very long value with a path', { a: `${'x'.repeat(4000)}/end` }],
  ])('finds %s at any depth', (_, value) => {
    expect(containsPathLikeValue(value)).toBe(true);
  });

  test.each([
    ['an email address', { to: 'alice@example.com' }],
    ['a sender search', { query: 'invoice from:alice@example.com' }],
    ['a message id', { id: '18f2a9c0' }],
    ['a date and time', { after: '2026-10-01', at: '3.5pm' }],
    ['a folder name with spaces', { folder: 'Family photos' }],
    ['a number and a flag', { count: 3, unread: true, nothing: null }],
  ])('ignores %s', (_, value) => {
    expect(containsPathLikeValue(value)).toBe(false);
  });

  test('ignores key names', () => {
    expect(containsPathLikeValue({ '/work/notes.md': 'hello' })).toBe(false);
  });
});
