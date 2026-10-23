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

  test('blocks a Windows path to an SSH key written with look-alike backslashes', () => {
    expect(namesSecretPath('C:⧹Users⧹u⧹.ssh⧹id_rsa')).toBe(true);
    expect(namesSecretPath('C:∖Users∖u∖.ssh∖id_rsa')).toBe(true);
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

describe('encoding layers and the decode cap', () => {
  /** Percent-encodes a value `layers` times over, so each decode round peels one layer. */
  const encodeLayers = (value: string, layers: number): string => {
    let out = value;
    for (let i = 0; i < layers; i += 1) {
      out = encodeURIComponent(out);
    }
    return out;
  };

  test('a secret path encoded three layers deep is still read and blocked', () => {
    const encoded = encodeLayers('/home/u/.ssh/id_rsa', 3);
    expect(namesSecretPath(encoded)).toBe(true);
    expect(containsSecretPath({ path: encoded })).toBe(true);
  });

  test('ordinary text encoded three layers deep is judged on what it decodes to', () => {
    expect(namesSecretPath(encodeLayers('hello world', 3))).toBe(false);
    expect(containsPathLikeValue({ note: encodeLayers('hello world', 3) })).toBe(false);
    expect(containsPathLikeValue({ path: encodeLayers('notes/todo', 3) })).toBe(true);
    expect(namesSecretPath(encodeLayers('notes/todo', 3))).toBe(false);
  });

  test('a secret path encoded four layers deep fails closed', () => {
    const encoded = encodeLayers('/home/u/.ssh/id_rsa', 4);
    expect(namesSecretPath(encoded)).toBe(true);
    expect(containsSecretPath({ path: encoded })).toBe(true);
    expect(containsPathLikeValue({ path: encoded })).toBe(true);
  });

  test('any text encoded four layers deep fails closed, because the checks cannot read it', () => {
    expect(namesSecretPath(encodeLayers('notes/todo', 4))).toBe(true);
    expect(containsPathLikeValue({ path: encodeLayers('notes/todo', 4) })).toBe(true);
    expect(namesSecretPath(encodeLayers('hello world', 4))).toBe(true);
    expect(containsPathLikeValue({ note: encodeLayers('hello world', 4) })).toBe(true);
  });

  test('text encoded five layers deep fails closed too', () => {
    expect(namesSecretPath(encodeLayers('/home/u/.ssh/id_rsa', 5))).toBe(true);
    expect(containsPathLikeValue({ path: encodeLayers('notes/todo', 5) })).toBe(true);
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

  test('checks key names too', () => {
    expect(containsPathLikeValue({ '/work/notes.md': 'hello' })).toBe(true);
  });
});

describe('containsPathLikeValue', () => {
  test.each([
    ['a parent folder reference', '..'],
    ['a parent folder path', '../../work/plan'],
    ['a dotfile name', '.bashrc'],
    ['a dotted name with a leading dot', '..hidden'],
    ['a percent-encoded slash', 'notes%2Ftodo'],
    ['a percent-encoded parent path', '..%2F..%2F.ssh%2Fid_rsa'],
    ['a lowercase percent-encoded parent path', '%2e%2e%2fsecrets'],
    ['a double-encoded parent path', '%252e%252e%252fsecrets'],
    ['a division slash', 'notes∕todo'],
    ['a fraction slash', 'notes⁄todo'],
    ['a big solidus', 'notes⧸todo'],
    ['a big reverse solidus', 'notes⧹todo'],
    ['a set minus', 'notes∖todo'],
    ['a fullwidth slash', 'notes／todo'],
    ['a fullwidth backslash', 'notes＼todo'],
    ['a parent path with fullwidth dots', '．．／secrets'],
  ])('treats %s as a path-like value', (_, value) => {
    expect(containsPathLikeValue({ path: value })).toBe(true);
  });

  test('treats a path-like key as path-like even when its value is plain', () => {
    expect(containsPathLikeValue({ '../secrets': 'yes' })).toBe(true);
    expect(containsPathLikeValue({ 'notes%2Ftodo': 'yes' })).toBe(true);
  });

  test.each([
    ['an IANA zone name', { timeZone: 'America/New_York' }],
    ['another IANA zone name', { time_zone: 'Europe/London' }],
    ['a nested IANA zone name', { filters: [{ zone: 'Asia/Kolkata' }] }],
    ['an IANA alias zone name', { timeZone: 'US/Eastern' }],
  ])('does not treat %s as a path', (_, value) => {
    expect(containsPathLikeValue(value)).toBe(false);
  });

  test.each([
    ['a zone name with a parent step', 'America/New_York/../../etc'],
    ['a zone name with extra words', 'America/New_York later'],
    ['a made-up zone name with a slash', 'America/Nowhere'],
  ])('still treats %s as a path', (_, value) => {
    expect(containsPathLikeValue({ path: value })).toBe(true);
  });

  test.each([
    ['a sentence with a dot in it', { query: 'weather in Lisbon this weekend.' }],
    ['a message id', { id: '18f2a9c0' }],
    ['an email address', { to: 'someone@example.com' }],
  ])('does not treat %s as a path', (_, value) => {
    expect(containsPathLikeValue(value)).toBe(false);
  });
});
