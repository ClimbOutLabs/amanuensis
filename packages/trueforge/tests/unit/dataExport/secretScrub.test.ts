import { normalizeSecrets, scrubJsonForExport, scrubTextForExport } from '../../../src/dataExport/secretScrub';
import { scrubCredentialPatternsInText } from '../../../src/privacy/exportScrub';

describe('export secret layers', () => {
  it('normalizeSecrets drops short values and sorts longest first', () => {
    expect(normalizeSecrets(['short', 'a-much-longer-secret', 'mid-length-1', null, undefined])).toEqual([
      'a-much-longer-secret',
      'mid-length-1',
    ]);
  });

  it('layer 1 removes stored secrets from nested JSON values and keys are untouched', () => {
    const secret = 'stored-secret-value-1234';
    const out = scrubJsonForExport({ a: [`prefix ${secret} suffix`], b: { c: secret } }, [secret]) as {
      a: string[];
      b: { c: string };
    };
    expect(out.a[0]).toBe('prefix [redacted] suffix');
    expect(out.b.c).toBe('[redacted]');
  });

  it('layer 2 redacts credential-shaped values that are not stored secrets', () => {
    // JSON values follow the privacy scrub semantics: a string containing a
    // credential pattern is replaced whole, and secret-named keys always redact.
    const pastedToken = ['ghp', 'abcdefgh1234567890abcdefgh'].join('_');
    const out = scrubJsonForExport({ note: `token ${pastedToken} here`, api_key: 'anything' }, []) as {
      note: string;
      api_key: string;
    };
    expect(out.note).toBe('[redacted]');
    expect(out.api_key).toBe('[redacted]');
  });

  it('text scrubbing keeps prose and removes both layers', () => {
    const secret = 'stored-secret-value-1234';
    expect(scrubTextForExport(`keep this, drop ${secret}, and sk-abcdefgh12345678 too`, [secret])).toBe(
      'keep this, drop [redacted], and [redacted] too',
    );
    expect(scrubCredentialPatternsInText('Bearer abcdefghijklmnopqrstuvwxyz')).toBe('[redacted]');
  });
});
