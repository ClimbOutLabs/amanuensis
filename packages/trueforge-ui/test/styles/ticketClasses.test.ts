import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the B2 ticket, row and reward classes in styles.css. Colours there
 * are hex-then-oklch pairs, and the new section sizes everything in rem.
 */
describe('B2 look styles', () => {
  const stylesPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css');
  const css = readFileSync(stylesPath, 'utf8');
  const b2Section = css.slice(css.indexOf('B2 look: time-of-day paper'));

  it('defines every ticket, row and brief card class', () => {
    for (const selector of [
      '.aui-ticket {',
      '.aui-ticket--stub {',
      '.aui-ticket--punch::before {',
      '.aui-ticket--selected {',
      '.aui-ticket--mark {',
      '.aui-ticket__tear {',
      '.aui-ticket__stub {',
      '.aui-row {',
      '.aui-row--2 {',
      '.aui-brief-card {',
      '.aui-brief-action {',
      '.aui-underline::after {',
      '.aui-receipt {',
    ]) {
      expect(b2Section, selector).toContain(selector);
    }
  });

  it('defines the motion keyframes and a reduced-motion block', () => {
    for (const name of ['aui-settle', 'aui-lay', 'aui-press', 'aui-pulse', 'aui-tear', 'aui-fleck']) {
      expect(b2Section).toContain(`@keyframes ${name}`);
    }
    expect(b2Section).toContain('@media (prefers-reduced-motion: reduce)');
  });

  it('sizes the new section in rem, not px', () => {
    expect(b2Section).not.toMatch(/\dpx\b/);
  });

  it('pairs each gold and palette colour with an oklch() line right after its hex', () => {
    for (const token of ['--gold', '--gold-ink', '--gold-soft', '--gold-line', '--card-bg', '--border']) {
      const pattern = new RegExp(`${token}: #[0-9a-f]{6};\\n\\s*${token}: oklch\\(`, 'm');
      const matches = css.match(new RegExp(`${token}: #[0-9a-f]{6};`, 'g')) ?? [];
      expect(matches.length, token).toBeGreaterThan(0);
      expect(pattern.test(css), token).toBe(true);
    }
  });

  it('no longer defines the retired approval banner tokens', () => {
    expect(css).not.toContain('approval-banner');
  });
});
