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
  openai: ['sk', 'abcdefgh12345678'].join('-'),
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
});
