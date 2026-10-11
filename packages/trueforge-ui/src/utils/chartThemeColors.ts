/**
 * Reads chart data-series colors from the app theme.
 *
 * The `--chart-1` … `--chart-8` CSS variables are set by the theme system on
 * `.aui-theme-root`. Chart.js draws to canvas, which cannot resolve `var()`
 * references, so JS reads the computed values directly. Outside a browser
 * (SSR, tests) or when the theme root is absent, the caller-supplied
 * fallbacks are used.
 */

/** Fallback series colors matching the default theme's light values. */
export const CHART_COLOR_FALLBACKS_LIGHT = [
  '#6366f1',
  '#2563eb',
  '#0ea5e9',
  '#8b5cf6',
  '#d946ef',
  '#f59e0b',
  '#10b981',
  '#ef4444',
];

/** Fallback series colors matching the default theme's dark values. */
export const CHART_COLOR_FALLBACKS_DARK = [
  '#6366f1',
  '#60a5fa',
  '#38bdf8',
  '#a78bfa',
  '#e879f9',
  '#fbbf24',
  '#34d399',
  '#f87171',
];

function readThemeVar(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector('.aui-theme-root') ?? document.documentElement;
  const value = getComputedStyle(root).getPropertyValue(name).trim();
  return value === '' ? null : value;
}

/**
 * Reads a single theme variable with a fallback. For canvas-drawn chrome
 * (axis labels, grid lines) that cannot use `var()` directly.
 */
export function readThemeColor(varName: string, fallback: string): string {
  return readThemeVar(varName) ?? fallback;
}

/**
 * Returns `count` themed series colors. Each entry is read from
 * `--chart-{n}`; entries the theme does not define fall back to the matching
 * `fallbacks` value so charts render even before themes load.
 */
export function readChartThemeColors({ count, fallbacks }: { count: number; fallbacks: string[] }): string[] {
  return Array.from({ length: count }, (_, index) => {
    return readThemeVar(`--chart-${index + 1}`) ?? fallbacks[index] ?? '#94a3b8';
  });
}

/** Fallback chrome colors for canvas charts, matching the pre-theme values. */
export const CHART_CHROME_FALLBACKS = {
  axis: { light: '#a1a1aa', dark: '#71717a' },
  grid: { light: '#e4e4e7', dark: '#27272a' },
  turnFill: { light: '#E0ECFD', dark: '#3f3f46' },
  turnHover: { light: '#E0ECFD', dark: '#52525b' },
} as const;

/** Fallback event-type colors for the session timeline, matching the pre-theme registry. */
export const TIMELINE_EVENT_FALLBACKS: Record<string, { color: string; darkColor?: string }> = {
  system: { color: '#94a3b8' },
  user: { color: '#34d399' },
  model: { color: '#3b82f6', darkColor: '#6366f1' },
  tool_call: { color: '#f59e0b' },
  approval: { color: '#f472b6' },
  sub_agent: { color: '#e2e8f0', darkColor: '#3f3f46' },
  waiting_on_human: { color: '#22d3ee' },
  error: { color: '#f87171' },
};
