import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { PRESETS } from '@/theme/presets/index.js';
import { THEME_PRESET_IDS } from '@/theme/types.js';

import { contrastRatio } from './wcagContrast.js';

/** The package root, found from wherever the runner started. */
function packageRoot(): string {
  let dir = process.cwd();
  for (;;) {
    for (const relative of ['.', 'packages/trueforge-ui']) {
      const candidate = resolve(dir, relative);
      if (existsSync(join(candidate, 'src/styles.css')) && existsSync(join(candidate, 'src/theme'))) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error('could not locate the trueforge-ui package');
    dir = parent;
  }
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

describe('placeholders', () => {
  const root = packageRoot();

  it('use the muted color token at normal weight everywhere', () => {
    const stylesheet = readFileSync(join(root, 'src/styles.css'), 'utf8');
    const rule = stylesheet.slice(
      stylesheet.indexOf('::placeholder {'),
      stylesheet.indexOf('}', stylesheet.indexOf('::placeholder {')),
    );
    expect(rule).toContain('color: var(--text-muted);');
    expect(rule).toContain('font-weight: 400;');

    const offenders = sourceFiles(join(root, 'src')).filter(path =>
      /placeholder:text-(?!text-muted\b)(?!\[)/.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
    expect(readFileSync(join(root, 'src/containers/ComposerContainer.tsx'), 'utf8')).toContain(
      'placeholder:text-text-muted',
    );
  });

  it('read lighter than secondary text and still meet AA on the input background in every theme', () => {
    for (const preset of THEME_PRESET_IDS) {
      for (const mode of ['light', 'dark'] as const) {
        const tokens = PRESETS[preset][mode];
        const muted = contrastRatio({ text: tokens.textMuted, surface: tokens.inputBoxBg, base: tokens.inputBoxBg });
        const secondary = contrastRatio({
          text: tokens.textSecondary,
          surface: tokens.inputBoxBg,
          base: tokens.inputBoxBg,
        });
        expect(muted, `${preset} ${mode}`).toBeGreaterThanOrEqual(4.5);
        expect(muted, `${preset} ${mode} is a hint, not typed text`).toBeLessThanOrEqual(secondary);
      }
    }
  });
});
