import type { LucideIcon } from 'lucide-react';
import type { ComponentType, CSSProperties, FC, ReactNode, SVGProps } from 'react';

export type ThemeMode = 'light' | 'dark' | 'system';

/** Picker order. The first entry is the default for new users. */
export const THEME_PRESET_IDS = ['paper', 'forest', 'midnight', 'high-contrast'] as const;

export type ThemePreset = (typeof THEME_PRESET_IDS)[number];

export const DEFAULT_THEME_PRESET: ThemePreset = 'paper';

export type SemanticTokens = {
  // Across product
  sidebarBg: string;
  sidebarText: string;
  topbarBg: string;
  primaryBg: string;
  secondaryBg: string;
  border: string;
  fontFamily: string;
  /** Display face for prose, headings, and welcome surfaces. Chrome keeps `fontFamily`. */
  fontDisplay: string;
  // Building blocks
  inputBoxBg: string;
  inputBorder: string;
  textPrimary: string;
  textSecondary: string;
  // Type scale
  textXs: string;
  textSm: string;
  textBase: string;
  textLg: string;
  textXl: string;
  text2xl: string;
  cardBg: string;
  /** Raised surface for layered UI (modals, popovers, elevated cards). */
  surfaceElevated: string;
  dropdownSelectedItemBg: string;
  dropdownSelectedItemText: string;
  // Chat
  userMessageBg: string;
  userMessageText: string;
  assistantMessageBg: string;
  assistantMessageText: string;
  // Buttons
  primaryButtonBg: string;
  primaryButtonHover: string;
  primaryButtonText: string;
  secondaryButtonBg: string;
  secondaryButtonHover: string;
  secondaryButtonText: string;
  ghostButtonBg: string;
  ghostButtonHover: string;
  ghostButtonText: string;
  // Status
  successBg: string;
  successText: string;
  failureBg: string;
  failureText: string;
  warningBg: string;
  warningText: string;
  /**
   * Vivid semantic foregrounds for status text, dots, and borders. The `*Bg`
   * tokens above are muted fills; these are the unmistakable hues that carry
   * meaning (a live recording dot, an error, an active badge).
   */
  success: string;
  warning: string;
  danger: string;
  dangerBg: string;
  info: string;
  infoBg: string;
  /** Live microphone indicator. May equal `danger`, but stays a separate name so the privacy cue is never dulled by a theme tweak. */
  recording: string;
  /** Categorical data-series colors for charts, read from CSS vars in JS. */
  chart1: string;
  chart2: string;
  chart3: string;
  chart4: string;
  chart5: string;
  chart6: string;
  chart7: string;
  chart8: string;
  // Kept internals
  /** Keyboard focus ring. Gold ink in light mode, bright gold in dark. */
  focusRing: string;
  /** The one highlight: fills, marks, the pending badge. Never text in light mode. */
  gold: string;
  /** Gold as words and lines: links, active nav, the focus ring's partner in light mode. */
  goldInk: string;
  /** Soft gold fill behind a selected or pending card. */
  goldSoft: string;
  /** Edge for a gold-soft fill, where a bright edge alone would be too faint. */
  goldLine: string;
  /** Centre of the panda's frame, sampled from the picture: parchment in light, the wall's glow in dark. */
  pandaGlowFrom: string;
  /** Rim of the panda's frame, sampled from the picture: wood in light, the deep wall in dark. */
  pandaGlowTo: string;
  radius: string;
  composerRadius: string;
  overlay: string;
  shadowColor: string;
  scrollbarThumb: string;
};

export type IconProps = {
  className?: string;
  style?: CSSProperties;
  size?: string | number;
  'aria-hidden'?: boolean | 'true' | 'false';
  'aria-label'?: string;
  'data-testid'?: string;
};

export type IconComponent = LucideIcon | ((props: IconProps) => ReactNode) | FC<SVGProps<SVGSVGElement>>;

export type IconEntry = IconComponent | ReactNode;

export type IconMap = Record<string, IconEntry>;

/**
 * Brand image sources. `light` / `dark` pick per resolved theme mode and fall
 * back to each other, then to `src`.
 */
export type BrandLogoConfig = {
  src?: string;
  light?: string;
  dark?: string;
};

export type BrandImage = string | BrandLogoConfig;

/** Chrome look for `theme.brand`. Omit `brand` entirely for the default TrueForge marks. */
export type BrandMode = 'icon-title' | 'icon-only' | 'logo';

/**
 * Product branding. Set `mode`, then pass the fields that mode requires.
 * `name` always labels the mark (`alt` / `aria-label`).
 */
export type BrandConfig =
  | {
      mode: 'icon-title';
      /** Accessible label and visible title beside the square mark in expanded chrome. */
      name: string;
      /** Square image, or per-mode sources. Omit to keep the default mark. */
      icon?: BrandImage;
      logo?: never;
      /** Wraps configured brand images in a same-tab link. */
      href?: string;
    }
  | {
      mode: 'icon-only';
      /** Accessible label only — no title text in expanded chrome. */
      name: string;
      /** Square image, or per-mode sources. */
      icon: BrandImage;
      logo?: never;
      /** Wraps configured brand images in a same-tab link. */
      href?: string;
    }
  | {
      mode: 'logo';
      /** Accessible label only — wide logo replaces the text title in expanded chrome. */
      name: string;
      /** Square image, or per-mode sources, used when compact. */
      icon: BrandImage;
      /** Wider image, or per-mode sources, used when expanded. */
      logo: BrandImage;
      /** Wraps configured brand images in a same-tab link. */
      href?: string;
    };

export type ContentClassNames = {
  markdown?: string;
  inlineCode?: string;
  syntaxHighlighter?: {
    root?: string;
    pre?: string;
    code?: string;
    lineNumber?: string;
  };
  openui?: {
    root?: string;
    scope?: string;
  };
  monaco?: {
    root?: string;
    editor?: string;
    monacoTheme?: string;
  };
};

/** Host token overrides split per resolved mode. A mode left out keeps the preset's values for that mode. */
export type ModeTokens = {
  light?: Partial<SemanticTokens>;
  dark?: Partial<SemanticTokens>;
};

/**
 * Host token overrides, flat or split by mode.
 *
 * The flat form applies to both modes, so colour tokens given flat survive the
 * light/dark toggle and defeat it. Give colours in the split form and keep the
 * flat form for values that are genuinely mode-independent, such as radii.
 */
export type ThemeTokensConfig = Partial<SemanticTokens> | ModeTokens;

/** Own-property rather than `in`, so a config built on a base object carrying `light` or `dark` is still read as flat. */
function isModeTokens(tokens: ThemeTokensConfig): tokens is ModeTokens {
  return Object.prototype.hasOwnProperty.call(tokens, 'light') || Object.prototype.hasOwnProperty.call(tokens, 'dark');
}

/**
 * Picks the override set that applies at `mode`, leaving the preset to supply everything else.
 * A mode the host omits resolves to no overrides: borrowing the other mode's set is what makes a
 * toggle look dead. The result is a copy, so the theme context never hands the host's own config
 * object to consumers.
 */
export function resolveHostTokens(
  tokens: ThemeTokensConfig | undefined,
  mode: 'light' | 'dark',
): Partial<SemanticTokens> {
  if (!tokens) return {};
  if (!isModeTokens(tokens)) return { ...tokens };
  return { ...tokens[mode] };
}

export type ThemeConfig = {
  preset?: ThemePreset;
  /** Controlled mode. Setting this makes the ThemeProvider controlled: `setTheme` becomes a no-op and stored preference is ignored. */
  mode?: ThemeMode;
  /** Preference used only when nothing is stored yet. Never makes the provider controlled: a stored preference or a `setTheme` call still wins. Defaults to `'system'`. */
  defaultMode?: ThemeMode;
  tokens?: ThemeTokensConfig;
  brand?: BrandConfig;
  className?: string;
  icons?: IconMap;
  classNames?: ContentClassNames;
  /** Load Google Sans from Google Fonts. Defaults to true; set false for hosts whose CSP keeps the page on its own origin. */
  webFonts?: boolean;
};

export type BuiltInLayout = 'sidebar' | 'drawer' | 'dock' | 'widget';

export type LayoutProp = BuiltInLayout | ComponentType<{ className?: string }>;

/** camelCase SemanticTokens key → CSS custom property name */
export const TOKEN_CSS_VARS: Record<keyof SemanticTokens, string> = {
  sidebarBg: '--sidebar-bg',
  sidebarText: '--sidebar-text',
  topbarBg: '--topbar-bg',
  primaryBg: '--primary-bg',
  secondaryBg: '--secondary-bg',
  border: '--border',
  fontFamily: '--font-agent-ui',
  fontDisplay: '--font-display',
  inputBoxBg: '--input-box-bg',
  inputBorder: '--input-border',
  textPrimary: '--text-primary',
  textSecondary: '--text-secondary',
  textXs: '--text-xs',
  textSm: '--text-sm',
  textBase: '--text-base',
  textLg: '--text-lg',
  textXl: '--text-xl',
  text2xl: '--text-2xl',
  cardBg: '--card-bg',
  surfaceElevated: '--surface-elevated',
  dropdownSelectedItemBg: '--dropdown-selected-item-bg',
  dropdownSelectedItemText: '--dropdown-selected-item-text',
  userMessageBg: '--user-message-bg',
  userMessageText: '--user-message-text',
  assistantMessageBg: '--assistant-message-bg',
  assistantMessageText: '--assistant-message-text',
  primaryButtonBg: '--primary-button-bg',
  primaryButtonHover: '--primary-button-hover',
  primaryButtonText: '--primary-button-text',
  secondaryButtonBg: '--secondary-button-bg',
  secondaryButtonHover: '--secondary-button-hover',
  secondaryButtonText: '--secondary-button-text',
  ghostButtonBg: '--ghost-button-bg',
  ghostButtonHover: '--ghost-button-hover',
  ghostButtonText: '--ghost-button-text',
  successBg: '--success-bg',
  successText: '--success-text',
  failureBg: '--failure-bg',
  failureText: '--failure-text',
  warningBg: '--warning-bg',
  warningText: '--warning-text',
  success: '--success',
  warning: '--warning',
  danger: '--danger',
  dangerBg: '--danger-bg',
  info: '--info',
  infoBg: '--info-bg',
  recording: '--recording',
  chart1: '--chart-1',
  chart2: '--chart-2',
  chart3: '--chart-3',
  chart4: '--chart-4',
  chart5: '--chart-5',
  chart6: '--chart-6',
  chart7: '--chart-7',
  chart8: '--chart-8',
  focusRing: '--focus-ring',
  gold: '--gold',
  goldInk: '--gold-ink',
  goldSoft: '--gold-soft',
  goldLine: '--gold-line',
  pandaGlowFrom: '--panda-glow-from',
  pandaGlowTo: '--panda-glow-to',
  radius: '--radius',
  composerRadius: '--composer-radius',
  overlay: '--overlay',
  shadowColor: '--shadow-color',
  scrollbarThumb: '--scrollbar-thumb',
};
