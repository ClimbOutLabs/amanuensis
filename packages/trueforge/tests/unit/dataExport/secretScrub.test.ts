import { KEY_PREFIXES } from '@truefoundry/trueforge-core/core';
import { createExportScrubber, normalizeSecrets, REDACTED } from '../../../src/dataExport/secretScrub';

// Credential-shaped samples are assembled so no literal in this file looks like a real secret.
const sample = {
  stripe: ['sk', 'live', 'abcdefghij0123456789'].join('_'),
  slackBot: ['xoxb', '1234567890', 'abcdefghij'].join('-'),
  slackUser: ['xoxs', '1234567890', 'abcdefghij'].join('-'),
  slackRefresh: ['xoxr', '1234567890', 'abcdefghij'].join('-'),
  googleOauth: ['ya29', 'a0AfH6SMBabcdefghij0123456789'].join('.'),
  jwt: ['eyJhbGciOiJIUzI1NiJ9', 'eyJzdWIiOiIxMjM0NTY3ODkwIn0', 'abcdefghijKLMNOP'].join('.'),
  github: ['ghp', 'abcdefgh1234567890abcdefgh'].join('_'),
  openai: ['sk', 'abcdefghij0123456789abcd'].join('-'),
};

describe('export secret scrubbing', () => {
  it('normalizeSecrets drops short values, adds the parts of a header value, and sorts longest first', () => {
    expect(normalizeSecrets(['short', 'a-much-longer-secret', 'mid-length-1', null, undefined])).toEqual([
      'a-much-longer-secret',
      'mid-length-1',
    ]);
    expect(normalizeSecrets(['Bearer abcdefgh12345678'])).toEqual(['Bearer abcdefgh12345678', 'abcdefgh12345678']);
  });

  it('removes stored secrets from nested JSON values, leaving the text around them', () => {
    const secret = 'stored-secret-value-1234';
    const scrubber = createExportScrubber([secret]);
    expect(scrubber.json({ a: [`prefix ${secret} suffix`], b: { c: secret } })).toEqual({
      a: ['prefix [redacted] suffix'],
      b: { c: REDACTED },
    });
    expect(scrubber.redactionCount()).toBe(2);
  });

  it('redacts only the credential span inside a JSON string, not the whole value', () => {
    const scrubber = createExportScrubber([]);
    expect(scrubber.json({ note: `token ${sample.github} here`, api_key: 'anything', empty: null })).toEqual({
      note: 'token [redacted] here',
      api_key: REDACTED,
      empty: null,
    });
    expect(scrubber.redactionCount()).toBe(2);
  });

  it.each(Object.entries(sample))('redacts a %s credential in free text and keeps the prose', (_name, value) => {
    const scrubber = createExportScrubber([]);
    expect(scrubber.text(`before ${value} after`)).toBe('before [redacted] after');
    expect(scrubber.redactionCount()).toBe(1);
  });

  it('redacts the password of a connection URL but keeps its host', () => {
    const scrubber = createExportScrubber([]);
    expect(scrubber.text('use postgres://app:hunter2pass@db.internal:5432/aman now')).toBe(
      'use postgres://app:[redacted]@db.internal:5432/aman now',
    );
    expect(scrubber.text('see postgres://db.internal/aman')).toBe('see postgres://db.internal/aman');
  });

  it('counts every replacement across json and text', () => {
    const scrubber = createExportScrubber(['stored-secret-value-1234']);
    scrubber.text('stored-secret-value-1234 and stored-secret-value-1234');
    scrubber.text(`${sample.openai}`);
    expect(scrubber.redactionCount()).toBe(3);
  });

  it('strips userinfo, query and fragment from a URL and replaces path segments that hold secrets', () => {
    const scrubber = createExportScrubber(['stored-secret-value-1234']);
    expect(scrubber.url('https://user:pw@host.example.com/mcp/stored-secret-value-1234/v1?key=abc#frag')).toBe(
      'https://host.example.com/mcp/[redacted]/v1',
    );
    expect(scrubber.url(`https://host.example.com/${sample.github}`)).toBe('https://host.example.com/[redacted]');
    expect(scrubber.url('https://host.example.com/mcp')).toBe('https://host.example.com/mcp');
    expect(scrubber.url('not a url')).toBe(REDACTED);
  });

  it('removes a whole PEM private key, body and END line included', () => {
    const pem = [
      ['-----BEGIN RSA', 'PRIVATE KEY-----'].join(' '),
      'MIIEowIBAAKCAQEAbodyline1',
      'bodyline2xyz',
      ['-----END RSA', 'PRIVATE KEY-----'].join(' '),
    ];
    const scrubber = createExportScrubber([]);
    const out = scrubber.text(`before\n${pem.join('\n')}\nafter`);
    expect(out).toBe('before\n[redacted]\nafter');
    expect(scrubber.text(`note\n${pem.slice(0, 3).join('\n')}`)).toBe('note\n[redacted]');
  });

  describe('parity with the outbound guard', () => {
    // One sample per guard key pattern; the length check fails when the guard gains a pattern without a sample.
    const guardSamples = [
      ['AKIA', 'ABCDEFGHIJKLMNOP'].join(''),
      ['ASIA', 'ABCDEFGHIJKLMNOP'].join(''),
      ['ghp', 'abcdefgh1234567890abcdefgh'].join('_'),
      ['github', 'pat', 'abcdefgh1234567890abcdefgh'].join('_'),
      ['sk', 'ant', 'abcdefghij1234'].join('-'),
      ['sk', 'abcdefghij0123456789abcd'].join('-'),
      ['xoxb', '1234567890', 'abcdefghij'].join('-'),
      ['xapp', '1234567890', 'abcdefghij'].join('-'),
      ['v1', 'abcdefghij0123456789abcdefghij01'].join('.'),
      ['AIza', 'abcdefghij0123456789abcdefghij01234'].join(''),
      ['ya29', 'a0AfH6SMBabcdefghij0123456789'].join('.'),
      ['sk', 'test', 'abcdefghij0123456789'].join('_'),
      ['hf', 'abcdefghij0123456789abcdefghij01'].join('_'),
      ['npm', 'abcdefghij0123456789abcdefghij01'].join('_'),
      ['glpat', 'abcdefghij0123456789'].join('-'),
      ['SG', 'abcdefghij0123456789', 'abcdefghij0123456789'].join('.'),
      ['SK', 'abcdef0123456789abcdef0123456789'].join(''),
      'Bearer abcdefghij0123456789abcd',
    ];

    it('has a sample for every guard key pattern', () => {
      expect(guardSamples).toHaveLength(KEY_PREFIXES.length + 1);
    });

    it.each(guardSamples)('redacts %s', value => {
      const scrubber = createExportScrubber([]);
      expect(scrubber.text(`key ${value} end`)).toBe('key [redacted] end');
    });

    it.each([
      ['password: hunter2xyz', 'password: [redacted]'],
      ['api_key=ab12cd34ef56', 'api_key=[redacted]'],
      ['passcode 123456', 'passcode [redacted]'],
    ])('redacts the value of the label in %s', (input, expected) => {
      expect(createExportScrubber([]).text(input)).toBe(expected);
    });

    it('leaves ordinary hyphenated words alone', () => {
      expect(createExportScrubber([]).text('the sk-learn-style-words stay')).toBe('the sk-learn-style-words stay');
    });
  });
});
