/**
 * Vite writes this token into the production app shell; the server substitutes
 * `PUBLIC_BASE_URL`'s pathname for it once at process start. It must not appear
 * in JS identifiers.
 *
 * The substituted value is always `/` or a path with a trailing slash, so the
 * token stands in for the whole prefix and the URL after it carries no leading
 * slash of its own.
 */
export const SHELL_BASE_TOKEN = '%%TRUEFORGE_BASE_PATH%%';

/**
 * Rewrites the public-root URLs Vite emits into the built shell so they resolve
 * against the configured base rather than the current page. Handles both
 * double- and single-quoted attributes, since bundlers differ. The shell also
 * answers deep links such as `/sessions/{id}`, where a page-relative `./` would
 * resolve one directory too deep.
 */
export function rewriteShellAssetUrls(html: string): string {
  return html
    .replaceAll('src="./', `src="${SHELL_BASE_TOKEN}`)
    .replaceAll('href="./', `href="${SHELL_BASE_TOKEN}`)
    .replaceAll("src='./", `src='${SHELL_BASE_TOKEN}`)
    .replaceAll("href='./", `href='${SHELL_BASE_TOKEN}`);
}
