import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Guards the map card against the dark-mode regression where it referenced
 * `--aui-color-*` variables that no theme defines, so every card fell back to
 * bright white in dark mode. The card must use the app's theme tokens, which
 * `.aui-theme-root` and `.aui-theme-root.dark` both define.
 */
describe('maps card theme tokens', () => {
  const stylesPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'styles.css');
  const css = readFileSync(stylesPath, 'utf8');
  const mapsSection = css.slice(css.indexOf('Embedded maps card'));

  it('references no undefined aui-color variables', () => {
    expect(mapsSection).not.toContain('--aui-color-');
  });

  it('paints surfaces and text from the theme tokens', () => {
    for (const token of ['--card-bg', '--border', '--text-primary', '--text-secondary']) {
      expect(mapsSection).toContain(`var(${token})`);
    }
  });
});
