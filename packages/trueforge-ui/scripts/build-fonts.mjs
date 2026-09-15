#!/usr/bin/env node
/**
 * Regenerates `src/fonts.css` from the installed `@fontsource/inter-tight`
 * package (latin subset, weights 400/500/600/700) as data-URI @font-face rules.
 *
 * The SDK stylesheet is injected at runtime via a `<style>` tag, so relative
 * font-file URLs would resolve against the host document and break — inlining
 * keeps the font genuinely bundled. Run with `pnpm build:fonts`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const pkgDir = dirname(require.resolve('@fontsource/inter-tight/package.json'));
const outPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'fonts.css');

const WEIGHTS = [400, 500, 600, 700];
const UNICODE_RANGE =
  'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';

// Wrapped exactly as prettier formats the value (twelve ranges, then the rest),
// so regenerated output stays `prettier --check`-clean without a post-generation
// format pass. `prettier --check src/fonts.css` after regenerating catches drift.
const UNICODE_RANGE_ITEMS = UNICODE_RANGE.split(',');
const UNICODE_RANGE_PRETTY = [
  `    ${UNICODE_RANGE_ITEMS.slice(0, 12).join(', ')},`,
  `    ${UNICODE_RANGE_ITEMS.slice(12).join(', ')};`,
];

const blocks = [
  '/*',
  ' * Bundled Inter Tight (latin subset) as data URIs.',
  ' * The SDK stylesheet is injected at runtime via a <style> tag, so relative',
  ' * font-file URLs would resolve against the host document and break; inlining',
  ' * keeps the font genuinely bundled. Regenerate with `pnpm build:fonts`.',
  ' * Source: @fontsource/inter-tight (OFL-1.1).',
  ' */',
];

for (const weight of WEIGHTS) {
  const file = join(pkgDir, 'files', `inter-tight-latin-${weight}-normal.woff2`);
  const base64 = readFileSync(file).toString('base64');
  blocks.push(
    '',
    '@font-face {',
    "  font-family: 'Inter Tight';",
    '  font-style: normal;',
    '  font-display: swap;',
    `  font-weight: ${weight};`,
    `  src: url(data:font/woff2;base64,${base64})`,
    `    format('woff2');`,
    '  unicode-range:',
    ...UNICODE_RANGE_PRETTY,
    '}',
  );
}

writeFileSync(outPath, blocks.join('\n') + '\n');
console.log(`wrote ${outPath}`);
