import { UI_BASE_PATH } from './publicPath';

/** The pair-a-terminal page's address under the app's public base, as the pairing start hands it out. */
export const PAIR_TERMINAL_PATH = '/pair-terminal';

/**
 * Whether a location is the pair-a-terminal page. The app answers it before its own
 * router, which would otherwise take the unknown address for the home page. A
 * trailing slash is the same page.
 */
export function isPairTerminalPath(pathname: string, uiBasePath: string = UI_BASE_PATH): boolean {
  const base = uiBasePath.replace(/\/$/, '');
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return path === `${base}${PAIR_TERMINAL_PATH}`;
}
