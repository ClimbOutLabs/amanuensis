// Theme resolution: env var > (future config.json) > "default".

import { loadTheme, type Theme } from "../themes/index.js";

export function resolveInitialTheme(env: NodeJS.ProcessEnv = process.env): Theme {
  const name = env.GMAIL_TUI_THEME?.trim();
  return loadTheme(name);
}
