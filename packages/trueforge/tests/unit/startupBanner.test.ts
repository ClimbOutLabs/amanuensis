import { formatStandaloneStartupBanner } from '../../src/startupBanner';

describe('standalone startup banner', () => {
  it('names Aman in the wordmark and the version line', () => {
    const { wordmark } = formatStandaloneStartupBanner({ version: '0.2.0', color: false });
    expect(wordmark).toContain('  Aman v0.2.0  ·  standalone');
    expect(wordmark).not.toContain('TrueForge');
    // The wordmark is six rows of the same width.
    const rows = wordmark.split('\n').filter(line => line.includes('█') || line.includes('╚'));
    expect(rows).toHaveLength(6);
    expect(new Set(rows.map(row => row.length)).size).toBe(1);
  });

  it('colours the text only when asked', () => {
    expect(formatStandaloneStartupBanner({ version: '0.2.0', color: false }).wordmark).not.toContain('\x1b[');
    expect(formatStandaloneStartupBanner({ version: '0.2.0', color: true }).wordmark).toContain('\x1b[');
  });
});
