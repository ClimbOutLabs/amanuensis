import {
  appendOutboundTrace,
  checkOutboundStrings,
  collectOutboundStrings,
  describeOutboundRule,
  OUTBOUND_GUARD_RULES,
  OUTBOUND_MAX_CHARS,
  OUTBOUND_MAX_PLUMBING_CHARS,
  OUTBOUND_MAX_TOTAL_CHARS,
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

function ruleFor(args: unknown, secrets: readonly string[] = [], earlier = ''): OutboundGuardRule | undefined {
  const strings = collectOutboundStrings(args);
  if (strings === undefined) {
    return 'uninspectable';
  }
  const verdict = checkOutboundStrings({ strings, secrets, earlier });
  return verdict.ok ? undefined : verdict.rule;
}

/** What the guard remembers after a call ran, to be passed as `earlier` to the next. */
function traceOf(args: unknown, earlier = ''): string {
  const strings = collectOutboundStrings(args);
  if (strings === undefined) {
    throw new Error('test arguments must be inspectable');
  }
  return appendOutboundTrace({ earlier, strings });
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

  test('a string of more than 200 characters', () => {
    const words = 'the quick brown fox jumps over the lazy dog ';
    expect(ruleFor({ query: words.repeat(5).slice(0, OUTBOUND_MAX_CHARS) })).toBeUndefined();
    expect(ruleFor({ query: words.repeat(5).slice(0, OUTBOUND_MAX_CHARS + 1) })).toBe('too_long');
    expect(ruleFor({ queries: [words.repeat(5).slice(0, OUTBOUND_MAX_CHARS + 1)] })).toBe('too_long');
  });

  test('strings are measured one by one, with a larger cap on all of them together', () => {
    const words = 'the quick brown fox jumps over the lazy dog ';
    const field = words.repeat(5).slice(0, OUTBOUND_MAX_CHARS);
    expect(ruleFor({ a: field, b: field, c: field })).toBeUndefined();
    const fieldCount = Math.floor(OUTBOUND_MAX_TOTAL_CHARS / OUTBOUND_MAX_CHARS) + 1;
    expect(ruleFor({ queries: Array.from({ length: fieldCount }, () => field) })).toBe('too_long');
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

describe('outbound guard: re-encoded and disguised secrets', () => {
  const zeroWidthSpace = '\u200B';
  const encode = (text: string) => encodeURIComponent(text);

  test('zero-width, soft-hyphen and bidi characters cannot split a key or a label', () => {
    expect(ruleFor({ query: awsKeyId.replace('AKIA', `AK${zeroWidthSpace}IA`) })).toBe('key_prefix');
    expect(ruleFor({ query: `${awsKeyId.slice(0, 6)}\u00AD${awsKeyId.slice(6)}` })).toBe('key_prefix');
    expect(ruleFor({ query: `pass\u200Dword: hunter2xx` })).toBe('password_label');
    expect(ruleFor({ query: `\u202Epassword: hunter2xx` })).toBe('password_label');
    expect(ruleFor({ query: serverSecret.replace('-', `${zeroWidthSpace}-`) }, [serverSecret])).toBe('server_secret');
  });

  test('combining marks and compatibility forms fold to the plain spelling', () => {
    expect(ruleFor({ query: 'pa\u0301ssword: hunter2xx' })).toBe('password_label');
    expect(ruleFor({ query: '\uFF50\uFF41\uFF53\uFF53\uFF57\uFF4F\uFF52\uFF44: hunter2xx' })).toBe('password_label');
  });

  test('look-alike Cyrillic and Greek letters fold to Latin ones', () => {
    expect(ruleFor({ query: '\u0440\u0430ssword: hunter2xx' })).toBe('password_label');
    expect(ruleFor({ query: awsKeyId.replace('AKIA', '\u0410KIA') })).toBe('key_prefix');
    expect(ruleFor({ query: awsKeyId.replace('AKIA', '\u0391K\u0399A') })).toBe('key_prefix');
  });

  test('a percent-encoded key, label or card is decoded once before the rules run', () => {
    expect(ruleFor({ query: encode(`debug ${awsKeyId}`) })).toBe('key_prefix');
    expect(ruleFor({ query: awsKeyId.replace('A', '%41') })).toBe('key_prefix');
    expect(ruleFor({ query: encode('password: hunter2xx') })).toBe('password_label');
    expect(ruleFor({ query: encode('charge 4242 4242 4242 4242') })).toBe('card_number');
    expect(ruleFor({ url: `https://example.test/?q=${encode(privateKeyHeader)}` })).toBe('private_key');
  });

  test('a percent sign that is not an escape stays as written and a decoded query still counts toward length', () => {
    expect(ruleFor({ query: '100% of 50% off sale' })).toBeUndefined();
    expect(ruleFor({ query: 'bad escape %E0%A4%A' })).toBeUndefined();
    expect(ruleFor({ query: 'x'.repeat(OUTBOUND_MAX_CHARS + 1) })).toBe('too_long');
  });

  test('a server secret in base64, base64url or hex, and in any case or spacing', () => {
    const awkward = 'p@ss/word+with=chars&more';
    for (const bytes of [Buffer.from(awkward), Buffer.from(serverSecret)]) {
      const secret = bytes.toString();
      for (const form of [bytes.toString('base64'), bytes.toString('base64url'), bytes.toString('hex')]) {
        expect(ruleFor({ query: `see ${form}` }, [secret])).toBe('server_secret');
      }
    }
    expect(ruleFor({ query: serverSecret.toUpperCase() }, [serverSecret])).toBe('server_secret');
    expect(ruleFor({ query: serverSecret.replaceAll('-', ' / ') }, [serverSecret])).toBe('server_secret');
  });

  test('the shortest secret that is matched is eight characters', () => {
    expect(ruleFor({ query: 'use abcd1234 here' }, ['abcd1234'])).toBe('server_secret');
    expect(ruleFor({ query: 'use abcd123 here' }, ['abcd123'])).toBeUndefined();
  });

  test.each([
    'passw0rd: hunter2xx',
    'p@ssw0rd=abc12345',
    'Pa55w0rd = "correct horse"',
    'PwD: abc12345',
    'p4ssc0de 482913',
    'token=ab12cd34ef56',
    'API_KEY: 9f8e7d6c5b',
    'api key = ab12cd34ef56',
    'secret: ab12cd34ef56',
  ])('a disguised credential label: %s', query => {
    expect(ruleFor({ query })).toBe('password_label');
  });

  test.each([
    'api key: 2024 changes',
    'secret: 12 monkeys',
    'token: the movie',
    'secret santa gift ideas',
    'how to rotate an api key',
    'access token expiry best practice',
    'authorization header format',
  ])('an ordinary mention of a credential word passes: %s', query => {
    expect(ruleFor({ query })).toBeUndefined();
  });

  test('a card number with dot separators', () => {
    expect(ruleFor({ query: 'charge 4242.4242.4242.4242' })).toBe('card_number');
    expect(ruleFor({ query: 'version 2024.1.15.3 released' })).toBeUndefined();
  });

  test('a key split between a query and a link, or across array items around one', () => {
    expect(ruleFor({ query: awsKeyId.slice(0, 9), url: `https://example.test/${awsKeyId.slice(9)}` })).toBe(
      'key_prefix',
    );
    expect(
      ruleFor({ query: serverSecret.slice(0, 12), url: `https://example.test/${serverSecret.slice(12)}` }, [
        serverSecret,
      ]),
    ).toBe('server_secret');
  });
});

describe('outbound guard: a secret sent in pieces over several calls', () => {
  test('is seen once the later piece arrives, in either order', () => {
    const first = awsKeyId.slice(0, 9);
    const rest = awsKeyId.slice(9);
    expect(ruleFor({ query: first })).toBeUndefined();
    expect(ruleFor({ query: rest }, [], traceOf({ query: first }))).toBe('key_prefix');
    expect(ruleFor({ query: first }, [], traceOf({ query: rest }))).toBe('key_prefix');
  });

  test('works for a server secret and across three calls', () => {
    const parts = [serverSecret.slice(0, 10), serverSecret.slice(10, 20), serverSecret.slice(20)];
    let earlier = '';
    const rules: (OutboundGuardRule | undefined)[] = [];
    for (const part of parts) {
      rules.push(ruleFor({ query: part }, [serverSecret], earlier));
      earlier = traceOf({ query: part }, earlier);
    }
    expect(rules).toEqual([undefined, undefined, 'server_secret']);
  });

  test('ordinary consecutive searches do not trip each other', () => {
    let earlier = '';
    for (const query of [
      'best restaurants in Lisbon 2024',
      'Python 3.12 release date',
      'weather in New York on 2024-06-15',
      'node.js vs deno performance',
      'order 12345678 shipping status',
    ]) {
      expect(ruleFor({ query }, [serverSecret], earlier)).toBeUndefined();
      earlier = traceOf({ query }, earlier);
    }
  });

  test('remembers only the most recent text, so an old piece is forgotten', () => {
    let earlier = traceOf({ query: awsKeyId.slice(0, 9) });
    for (let i = 0; i < 40; i += 1) {
      earlier = traceOf({ query: 'filler words that are long enough to push the first piece out of memory' }, earlier);
    }
    expect(ruleFor({ query: awsKeyId.slice(9) }, [], earlier)).toBeUndefined();
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

describe('outbound guard: provider plumbing fields', () => {
  // Invented values only.
  const inventedHexId = 'c0ffee00d15ea5e0bad0cafe12345678';
  const inventedUuid = '3f2b8c1e-7a44-4d0e-9b61-5e2f0c9a1d77';
  const inventedBase64Url = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXpfYWJjLTEyMzQ';
  const inventedBase64Padded = 'Zm9vYmFyYmF6cXV4cXV1eHF1dXo9PQ+/ab==';
  const plumbing = ['session_id', 'model_name'];

  function ruleWithPlumbing({
    args,
    secrets = [],
  }: {
    args: unknown;
    secrets?: readonly string[];
  }): OutboundGuardRule | undefined {
    const strings = collectOutboundStrings(args, plumbing);
    if (strings === undefined) {
      return 'uninspectable';
    }
    const verdict = checkOutboundStrings({ strings, secrets });
    return verdict.ok ? undefined : verdict.rule;
  }

  test('a declared field is kept out of the query text and out of the length rule', () => {
    const strings = collectOutboundStrings(
      { objective: 'find the inventor of the zipper', session_id: inventedUuid, model_name: 'invented-model-7' },
      plumbing,
    );
    expect(strings?.values).toEqual(['find the inventor of the zipper']);
    expect(strings?.plumbing).toEqual([inventedUuid, 'invented-model-7']);
    expect(strings?.keys).toEqual(['objective', 'session_id', 'model_name']);
  });

  test('only a top-level plain value counts as plumbing, so a nested one stays user text', () => {
    const strings = collectOutboundStrings(
      { filters: { session_id: 'nested text' }, session_id: ['listed text'] },
      plumbing,
    );
    expect(strings?.plumbing).toEqual([]);
    expect(strings?.values).toEqual(['nested text', 'listed text']);
  });

  test('a UUID session id and a model name pass', () => {
    expect(
      ruleWithPlumbing({
        args: { objective: 'zipper history', session_id: inventedUuid, model_name: 'invented-model-7' },
      }),
    ).toBeUndefined();
  });

  test('a long random session id passes as plumbing, whatever its alphabet', () => {
    for (const sessionId of [inventedHexId, inventedBase64Url, inventedBase64Padded]) {
      expect(
        ruleWithPlumbing({
          args: {
            objective: 'zipper history',
            search_queries: ['zipper inventor'],
            session_id: sessionId,
            model_name: 'invented-model-7',
          },
        }),
      ).toBeUndefined();
    }
  });

  test('the same runs in user text, or in a field the catalog does not declare, are held', () => {
    for (const run of [inventedHexId, inventedBase64Url, inventedBase64Padded]) {
      expect(ruleWithPlumbing({ args: { objective: `look up ${run}` } })).toBe('encoded_run');
      expect(ruleWithPlumbing({ args: { filters: { session_id: run } } })).toBe('encoded_run');
      expect(ruleWithPlumbing({ args: { note_id: run } })).toBe('encoded_run');
    }
  });

  test('every other rule still reads a plumbing value', () => {
    expect(ruleWithPlumbing({ args: { session_id: awsKeyId } })).toBe('key_prefix');
    expect(ruleWithPlumbing({ args: { model_name: serverSecret }, secrets: [serverSecret] })).toBe('server_secret');
    expect(ruleWithPlumbing({ args: { session_id: 'password: hunter2xx' } })).toBe('password_label');
    expect(ruleWithPlumbing({ args: { session_id: jwt } })).toBe('jwt');
  });

  test('a plumbing value is capped, so the field cannot carry a bulk send', () => {
    expect(ruleWithPlumbing({ args: { model_name: 'm'.repeat(OUTBOUND_MAX_PLUMBING_CHARS) } })).toBeUndefined();
    expect(ruleWithPlumbing({ args: { model_name: 'm'.repeat(OUTBOUND_MAX_PLUMBING_CHARS + 1) } })).toBe('too_long');
  });

  test('an encoded secret in a plumbing field is held, not exempt', () => {
    const base64Token = Buffer.from(githubToken).toString('base64');
    const hexToken = Buffer.from(githubToken).toString('hex');
    const base64UrlText = Buffer.from('my private notes about the lease dispute with the landlord').toString(
      'base64url',
    );
    for (const value of [base64Token, hexToken, base64UrlText]) {
      expect(value.length).toBeGreaterThan(OUTBOUND_MAX_PLUMBING_CHARS);
      expect(ruleWithPlumbing({ args: { session_id: value } })).toBe('encoded_run');
      expect(ruleWithPlumbing({ args: { model_name: value } })).toBe('encoded_run');
    }
  });

  test('a plumbing value outside the identifier shape is read as user text', () => {
    expect(ruleWithPlumbing({ args: { session_id: `${inventedHexId} ${inventedBase64Url}` } })).toBe('encoded_run');
  });

  test('a secret split between a plumbing value and the next call is still seen whole', () => {
    const first = collectOutboundStrings({ session_id: githubToken.slice(0, 12) }, plumbing);
    if (first === undefined) {
      throw new Error('test arguments must be inspectable');
    }
    const earlier = appendOutboundTrace({ earlier: '', strings: first });
    expect(ruleFor({ query: githubToken.slice(12) }, [], earlier)).toBe('key_prefix');
  });
});
