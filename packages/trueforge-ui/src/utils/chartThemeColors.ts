import { resolvePresetTokens } from '../theme/presets/index.js';
import { TOKEN_CSS_VARS, type SemanticTokens } from '../theme/types.js';

/**
 * Reads theme tokens for canvas-drawn charts.
 *
 * Chart.js draws to canvas, which cannot resolve `var()` references, so JS
 * reads the computed CSS variables directly. Outside a browser (SSR, tests)
 * or when the theme root is absent, the default preset's value is used, so
 * the preset stays the only place those colors are defined.
 */

/** Series tokens in `--chart-1` … `--chart-8` order. */
export const CHART_SERIES_TOKENS = [
  'chart1',
  'chart2',
  'chart3',
  'chart4',
  'chart5',
  'chart6',
  'chart7',
  'chart8',
] as const satisfies readonly (keyof SemanticTokens)[];

function readThemeVar(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector('.aui-theme-root') ?? document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  return value === '' ? null : value;
}

/** Reads one token's live CSS variable, falling back to the default preset's value for `mode`. */
export function readThemeToken({ token, mode }: { token: keyof SemanticTokens; mode: 'light' | 'dark' }): string {
  return readThemeVar(TOKEN_CSS_VARS[token]) ?? resolvePresetTokens(undefined, mode)[token];
}

/** The eight themed series colors, in `--chart-N` order. */
export function readChartThemeColors({ mode }: { mode: 'light' | 'dark' }): string[] {
  return CHART_SERIES_TOKENS.map(token => readThemeToken({ token, mode }));
}
