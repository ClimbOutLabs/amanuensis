import { UI_BASE_PATH } from './publicPath';

/** The live browser page's address under the app's public base, as the model tells the person to open it. */
export const BROWSER_LIVE_PATH = '/browser-live';

/**
 * Whether a location is the live browser page. The app answers it before its own router, which
 * would otherwise take the unknown address for the home page. A trailing slash is the same page.
 */
export function isBrowserLivePath(pathname: string, uiBasePath: string = UI_BASE_PATH): boolean {
  const base = uiBasePath.replace(/\/$/, '');
  const path = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return path === `${base}${BROWSER_LIVE_PATH}`;
}
