'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react';

import { cn } from '../atoms/lib/cn.js';
import { dayPartForHour } from './dayPart.js';
import { ensureStyles } from './ensureStyles.js';
import { resolvePresetTokens } from './presets/index.js';
import {
  resolveHostTokens,
  TOKEN_CSS_VARS,
  type BrandConfig,
  type ContentClassNames,
  type IconMap,
  type SemanticTokens,
  type ThemeConfig,
  type ThemeMode,
  type ThemePreset,
} from './types.js';

export type ThemeContextValue = {
  preset: ThemePreset;
  /** Resolved light/dark (never `"system"`). */
  mode: 'light' | 'dark';
  /** Preference including `"system"` when uncontrolled. */
  preference: ThemeMode;
  isDark: boolean;
  setTheme: (mode: ThemeMode) => void;
  setPreset: (preset: ThemePreset) => void;
  /** Partial: `theme.brand` is optional, so consumers fall back to SDK defaults. */
  brand: Partial<BrandConfig>;
  icons: IconMap;
  classNames: ContentClassNames;
  tokens: Partial<SemanticTokens>;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

export { ThemeContext };

const STORAGE_KEY = 'aui-theme-preference';
const PRESET_STORAGE_KEY = 'aui-theme-preset';

const VALID_PRESETS: ReadonlyArray<ThemePreset> = [
  'trueforge',
  'claude',
  'chatgpt',
  'gemini',
  'midnight',
  'forest',
  'sunset',
  'volt',
];

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  } catch {
    return 'light';
  }
}

function resolveMode(preference: ThemeMode): 'light' | 'dark' {
  return preference === 'system' ? getSystemTheme() : preference;
}

/** Returns the stored preference, or `null` when nothing is stored yet (distinct from a stored `'system'`). */
function readStoredPreference(): ThemeMode | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored === 'light' || stored === 'dark' || stored === 'system') return stored;
  } catch {
    /* ignore */
  }
  return null;
}

/** Returns the stored preset, or `null` when nothing is stored yet. */
function readStoredPreset(): ThemePreset | null {
  if (typeof window === 'undefined') return null;
  try {
    const stored = localStorage.getItem(PRESET_STORAGE_KEY);
    if (stored != null && (VALID_PRESETS as ReadonlyArray<string>).includes(stored)) {
      return stored as ThemePreset;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function tokensToStyle(tokens: Partial<SemanticTokens> | undefined): CSSProperties {
  if (!tokens) return {};
  const style: Record<string, string> = {};
  for (const [key, value] of Object.entries(tokens) as [keyof SemanticTokens, string | undefined][]) {
    if (value == null) continue;
    style[TOKEN_CSS_VARS[key]] = value;
  }
  return style as CSSProperties;
}

/**
 * Renders the theme root and provides theme context to descendants.
 *
 * Uncontrolled by default: the resolved preference is the stored preference if one
 * exists, else `theme.defaultMode`, else `'system'`. `setTheme` (and the toggle UI)
 * updates the preference and persists it to localStorage.
 *
 * Passing `theme.mode` makes the provider controlled: `setTheme` becomes a no-op and
 * the stored preference and `theme.defaultMode` are both ignored.
 */
export function ThemeProvider({ theme, children }: { theme?: ThemeConfig; children: ReactNode }) {
  const isControlled = theme?.mode !== undefined;
  const initialPreference = () => theme?.mode ?? readStoredPreference() ?? theme?.defaultMode ?? 'system';
  const [preference, setPreference] = useState<ThemeMode>(initialPreference);
  const [mode, setMode] = useState<'light' | 'dark'>(() => resolveMode(initialPreference()));
  // Preset is uncontrolled: the stored preset wins, else the host config, else 'trueforge'.
  const [preset, setPresetState] = useState<ThemePreset>(() => readStoredPreset() ?? theme?.preset ?? 'trueforge');

  const webFonts = theme?.webFonts;
  useLayoutEffect(() => {
    ensureStyles(undefined, { webFonts });
  }, [webFonts]);

  useLayoutEffect(() => {
    if (theme?.mode !== undefined) {
      setPreference(theme.mode);
      setMode(resolveMode(theme.mode));
      return;
    }
    const stored = readStoredPreference() ?? theme?.defaultMode ?? 'system';
    setPreference(stored);
    setMode(resolveMode(stored));
  }, [theme?.mode, theme?.defaultMode]);

  useEffect(() => {
    if (isControlled || typeof window === 'undefined' || typeof window.matchMedia !== 'function') {
      return;
    }
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => {
      if (preference !== 'system') return;
      setMode(getSystemTheme());
    };
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, [isControlled, preference]);

  const setTheme = useCallback(
    (next: ThemeMode) => {
      if (isControlled) return;
      setPreference(next);
      setMode(resolveMode(next));
      try {
        localStorage.setItem(STORAGE_KEY, next);
      } catch {
        /* ignore */
      }
    },
    [isControlled],
  );

  const setPreset = useCallback((next: ThemePreset) => {
    setPresetState(next);
    try {
      localStorage.setItem(PRESET_STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
  }, []);

  const hostTokens = useMemo(() => resolveHostTokens(theme?.tokens, mode), [theme?.tokens, mode]);

  const value = useMemo<ThemeContextValue>(
    () => ({
      preset,
      mode,
      preference,
      isDark: mode === 'dark',
      setTheme,
      setPreset,
      brand: theme?.brand ?? {},
      icons: theme?.icons ?? {},
      classNames: theme?.classNames ?? {},
      tokens: hostTokens,
    }),
    [preset, mode, preference, setTheme, setPreset, theme?.brand, theme?.icons, theme?.classNames, hostTokens],
  );

  const rootStyle = useMemo(
    () =>
      tokensToStyle({
        ...resolvePresetTokens(preset, mode),
        ...hostTokens,
      }),
    [preset, hostTokens, mode],
  );

  return (
    <ThemeContext.Provider value={value}>
      <div
        className={cn('aui-theme-root h-full min-h-0', mode === 'dark' && 'dark', theme?.className)}
        data-theme={mode}
        data-preset={preset}
        data-day={dayPartForHour(new Date().getHours())}
        style={rootStyle}
      >
        {children}
      </div>
    </ThemeContext.Provider>
  );
}

function useThemeContext(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) {
    throw new Error('useTheme must be used within a ThemeProvider');
  }
  return ctx;
}

export function useTheme(): Pick<
  ThemeContextValue,
  'preset' | 'mode' | 'preference' | 'isDark' | 'setTheme' | 'setPreset'
> {
  const { preset, mode, preference, isDark, setTheme, setPreset } = useThemeContext();
  return { preset, mode, preference, isDark, setTheme, setPreset };
}

/** Configured branding. Fields are optional — `theme.brand` may be omitted entirely. */
export function useBrand(): Partial<BrandConfig> {
  return useThemeContext().brand;
}

export function useContentClassNames(): ContentClassNames {
  return useThemeContext().classNames;
}

export function useThemeIcons(): IconMap {
  return useThemeContext().icons;
}

/** Safe for trees that may sit outside ThemeProvider (falls back to light). */
export function useOptionalThemeMode(): 'light' | 'dark' {
  return useContext(ThemeContext)?.mode ?? 'light';
}

/** Safe for trees that may sit outside ThemeProvider (falls back to trueforge). */
export function useOptionalThemePreset(): ThemePreset {
  return useContext(ThemeContext)?.preset ?? 'trueforge';
}

/** Safe for trees that may sit outside ThemeProvider (falls back to {}). */
export function useOptionalContentClassNames(): ContentClassNames {
  return useContext(ThemeContext)?.classNames ?? {};
}
