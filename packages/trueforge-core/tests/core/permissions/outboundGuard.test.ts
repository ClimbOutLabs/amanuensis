import {
  checkOutboundStrings,
  collectOutboundStrings,
  describeOutboundRule,
  OUTBOUND_GUARD_RULES,
  OUTBOUND_MAX_CHARS,
  type OutboundGuardRule,
} from '../../../src/core/permissions/outboundGuard';

/**
 * Every secret-shaped value is assembled at run time from fragments, so no literal in this file
 * looks like a credential to a scanner. All of them are synthetic.
 */
const awsKeyId = ['AKI', 'A', 'ABCDEFGH', 'IJKLMNOP'].join('');
const githubToken = ['gh', 'p', '_', 'a1B2c3D4'.repeat(4)].join('');
const githubPat = ['github', 'pat', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('_');
const anthropicKey = ['sk', 'ant', 'api03', 'a1B2c3D4e5F6g7H8'].join('-');
const openAiKey = ['sk', 'proj', 'a1B2c3D4e5F6g7H8i9J0k1L2'].join('-');
const slackToken = ['xo', 'xb', '-', '123456789012', '-', 'a1B2c3D4e5F6'].join('');
const nebiusKey = ['v1', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8'].join('.');
const googleKey = ['AI', 'za', 'A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r'].join('');
const stripeKey = ['s', 'k_', 'live_', 'a1B2c3D4e5F6g7H8i9J0'].join('');
const privateKeyHeader = ['-----BEGIN ', 'RSA ', 'PRIVATE ', 'KEY-----'].join('');
const base64Url = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
const jwt = [base64Url({ alg: 'HS256', typ: 'JWT' }), base64Url({ sub: 'synthetic-user' }), 'c2lnbmF0dXJl'].join('.');
const serverSecret = 'synthetic-server-secret-value-0001';

function ruleFor(args: unknown, secrets: readonly string[] = []): OutboundGuardRule | undefined {
  const strings = collectOutboundStrings(args);
  if (strings === undefined) {
    return 'uninspectable';
  }
  const verdict = checkOutboundStrings({ strings, secrets });
  return verdict.ok ? undefined : verdict.rule;
}

describe('outbound guard: rules that trip', () => {
  test('a server-held secret, verbatim', () => {
    expect(ruleFor({ query: `how do I use ${serverSecret} in curl` }, [serverSecret])).toBe('server_secret');
  });

  test('a server-held secret, url-encoded, split by spaces, or chunked across array items', () => {
    const awkward = 'p@ss/word+with=chars&more';
    expect(ruleFor({ query: encodeURIComponent(awkward) }, [awkward])).toBe('server_secret');
    expect(ruleFor({ query: serverSecret.replace(/(.{8})/g, '$1 ') }, [serverSecret])).toBe('server_secret');
    expect(ruleFor({ queries: [serverSecret.slice(0, 12), serverSecret.slice(12)] }, [serverSecret])).toBe(
      'server_secret',
    );
  });

  test('a server-held secret hidden in an object key or a fullwidth lookalike', () => {
    expect(ruleFor({ [serverSecret]: 'x' }, [serverSecret])).toBe('server_secret');
    const fullwidth = serverSecret.replace(/[a-z]/g, ch => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
    expect(ruleFor({ query: fullwidth }, [serverSecret])).toBe('server_secret');
  });

  test('a short server secret is not matched, so it cannot flag ordinary words', () => {
    expect(ruleFor({ query: 'admin panel login' }, ['admin'])).toBeUndefined();
  });

  test('a private key block', () => {
    expect(ruleFor({ query: `${privateKeyHeader} MIIE` })).toBe('private_key');
    expect(ruleFor({ query: privateKeyHeader.toLowerCase().replace('rsa ', '') })).toBe('private_key');
  });

  test('a JWT', () => {
    expect(ruleFor({ query: `decode ${jwt}` })).toBe('jwt');
  });

  test.each([
    ['AWS access key id', awsKeyId],
    ['GitHub token', githubToken],
    ['GitHub fine-grained token', githubPat],
    ['Anthropic key', anthropicKey],
    ['OpenAI key', openAiKey],
    ['Slack token', slackToken],
    ['Nebius key', nebiusKey],
    ['Google key', googleKey],
    ['Stripe key', stripeKey],
  ])('a %s prefix', (_label, key) => {
    expect(ruleFor({ query: `is ${key} valid` })).toBe('key_prefix');
  });

  test('a key prefix split across array items', () => {
    expect(ruleFor({ queries: [awsKeyId.slice(0, 6), awsKeyId.slice(6)] })).toBe('key_prefix');
  });

  test('a hex run of 20 or more characters', () => {
    expect(ruleFor({ query: 'lookup 9f86d081884c7d659a2f' })).toBe('encoded_run');
    expect(ruleFor({ query: 'lookup 9f86d081884c7d659a2' })).toBeUndefined();
  });

  test('a base64 run of 20 or more characters', () => {
    expect(ruleFor({ query: 'decode Zm9vYmFyYmF6cXV4MTIzNDU2' })).toBe('encoded_run');
    expect(ruleFor({ query: 'decode aGVsbG8gd29ybGQgaGVsbG8=' })).toBe('encoded_run');
    expect(ruleFor({ query: 'token dGhpcy1pcy1hLXNlY3JldC12YWx1ZQ' })).toBe('encoded_run');
  });

  test.each([
    'password: hunter2xx',
    'my pwd=abc12345',
    'Password = "correct horse"',
    'passcode 482913',
    'passphrase: purple-elephant-9',
    '{"password":"hunter2xx"}',
    // A label with a delimiter is held even when the "value" is a plain word: that is the cost of not guessing.
    'what does password: mean in a config file',
  ])('a password label followed by a value: %s', query => {
    expect(ruleFor({ query })).toBe('password_label');
  });

  test.each(['4242 4242 4242 4242', '4242-4242-4242-4242', '4242424242424242', '378282246310005'])(
    'a payment card number that passes Luhn: %s',
    number => {
      expect(ruleFor({ query: `charge ${number}` })).toBe('card_number');
    },
  );

  test('a card number sent as a JSON number', () => {
    expect(ruleFor({ query: 'balance', card: 4242424242424242 })).toBe('card_number');
  });

  test('more than 200 characters in total, summed over every string', () => {
    const words = 'the quick brown fox jumps over the lazy dog ';
    expect(ruleFor({ query: words.repeat(5).slice(0, OUTBOUND_MAX_CHARS) })).toBeUndefined();
    expect(ruleFor({ query: words.repeat(5).slice(0, OUTBOUND_MAX_CHARS + 1) })).toBe('too_long');
    expect(ruleFor({ a: words.repeat(2), b: words.repeat(2), c: words })).toBe('too_long');
  });

  test('arguments too deep to inspect trip rather than pass unread', () => {
    let deep: unknown = 'leaf';
    for (let i = 0; i < 12; i += 1) {
      deep = { next: deep };
    }
    expect(ruleFor(deep)).toBe('uninspectable');
  });

  test('every rule has a plain description that never echoes input', () => {
    for (const rule of OUTBOUND_GUARD_RULES) {
      expect(describeOutboundRule(rule).length).toBeGreaterThan(5);
    }
  });
});

describe('outbound guard: ordinary queries pass', () => {
  test.each([
    'best restaurants in Lisbon 2024',
    'Python 3.12 release date June 15 2024',
    'weather in New York on 2024-06-15',
    'flights 2024-06-15 2024-06-16 Paris',
    'iPhone 15 Pro Max 256GB price',
    'node.js vs deno performance',
    'sk-learn pipeline tutorial',
    'how to reset a forgotten password on windows 10',
    'IllegalArgumentException in Java streams',
    'internationalization best practices',
    'src/components/Button/index.tsx props',
    '123e4567-e89b-12d3-a456-426614174000 uuid format',
    'unix timestamp 1718451234567 to date',
    'call 415-555-0132 customer service hours',
    'version v1.2.3 changelog',
    'Fürstenfeldbruck population 2023',
    'SHA-256 vs MD5 collision resistance',
    'Barack Obama born August 4 1961 Honolulu',
    'GDP of Germany 2023 in euros 4.12 trillion',
    'TCP port 8080 vs 443 firewall rules',
    'kubernetes pod stuck in CrashLoopBackOff after upgrade',
    'ISBN 978-3-16-148410-0 lookup',
    'order 12345678 shipping status',
  ])('%s', query => {
    expect(ruleFor({ query })).toBeUndefined();
  });

  test('a typical structured search call with options passes', () => {
    expect(
      ruleFor({
        objective: 'Find the current stable release of PostgreSQL and its end of life date',
        search_queries: ['postgresql latest stable release', 'postgresql end of life 2024'],
        max_results: 10,
        include_snippets: true,
      }),
    ).toBeUndefined();
  });

  test('empty and non-text arguments pass', () => {
    expect(ruleFor({})).toBeUndefined();
    expect(ruleFor({ limit: 5, deep: null })).toBeUndefined();
  });
});
