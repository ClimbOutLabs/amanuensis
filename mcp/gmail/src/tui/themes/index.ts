// Theme contract for every TUI surface. Themes are pure objects (no React,
// no Ink) so tests can introspect them without rendering.

export interface Theme {
  name: string;
  /** True if this theme assumes a Nerd Font is installed (uses non-ASCII glyphs). */
  nerd: boolean;
  // Foreground / background palette
  fg: string;
  bg: string;
  dim: string;
  accent: string;
  error: string;
  warning: string;
  success: string;
  // Per-element overrides
  selectedFg: string;
  selectedBg: string;
  sidebarBg: string;
  /** Background fill used by centered modals (Help / Theme / Stats / Confirm /
      Account). Ink 7 only honors `backgroundColor` on `<Text>`, so every
      modal row paints this colour explicitly via `<ModalRow>` to ensure
      every cell is written and no underlying pane bleeds through. */
  modalBg: string;
  statusBarBg: string;
  statusBarFg: string;
  helpBarFg: string;
  border: string;
  // Glyphs — ASCII-only themes set these to safe fallbacks
  glyphs: {
    mail: string;
    attachment: string;
    star: string;
    starOn: string;
    unread: string;
    chevronRight: string;
    chevronDown: string;
  };
}

import { defaultTheme } from "./default.js";
import { draculaTheme } from "./dracula.js";
import { gruvboxTheme } from "./gruvbox.js";
import { monoTheme } from "./mono.js";
import { nerdTheme } from "./nerd.js";
import { nordTheme } from "./nord.js";
import { solarizedDarkTheme } from "./solarized-dark.js";
import { solarizedLightTheme } from "./solarized-light.js";

export const themes: Record<string, Theme> = {
  default: defaultTheme,
  mono: monoTheme,
  dracula: draculaTheme,
  "solarized-dark": solarizedDarkTheme,
  "solarized-light": solarizedLightTheme,
  nord: nordTheme,
  gruvbox: gruvboxTheme,
  nerd: nerdTheme,
};

export function loadTheme(name: string | undefined): Theme {
  if (!name) return defaultTheme;
  return themes[name] ?? defaultTheme;
}

export function listThemeNames(): string[] {
  return Object.keys(themes);
}
