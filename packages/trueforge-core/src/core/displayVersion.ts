/**
 * The version users see: the startup banner, the side panel release line, and
 * the API docs. Owned here so every surface reads one constant; raise it with
 * `pnpm release:version`. Package versions in package.json are a separate
 * maintainer concern and are never shown to users.
 */
export const APP_DISPLAY_VERSION = '1.0.0';

/** Enough of a commit SHA to compare against a branch or an image tag by eye. */
const SHORT_REF_LENGTH = 7;

/** Shortens a commit SHA; anything else (a tag, a branch) is already meant to be read whole. */
export function shortenBuildRef(ref: string): string {
  return /^[0-9a-f]{12,}$/i.test(ref) ? ref.slice(0, SHORT_REF_LENGTH) : ref;
}

function stampedRef(buildRef: string | undefined): string | undefined {
  const ref = buildRef?.trim();
  return ref === undefined || ref === '' ? undefined : ref;
}

/**
 * The display version with its build stamp: `1.0.0 · <short commit>` for a
 * stamped build, `1.0.0 · dev` for an unstamped local build, so every running
 * build is identifiable even between releases.
 */
export function formatDisplayVersion(buildRef: string | undefined): string {
  const ref = stampedRef(buildRef);
  return ref === undefined ? `${APP_DISPLAY_VERSION} · dev` : `${APP_DISPLAY_VERSION} · ${shortenBuildRef(ref)}`;
}

/** The same stamp with the full build reference kept, for tooltips and reports. */
export function formatDisplayVersionFull(buildRef: string | undefined): string {
  const ref = stampedRef(buildRef);
  return ref === undefined ? `${APP_DISPLAY_VERSION} · dev` : `${APP_DISPLAY_VERSION} · ${ref}`;
}
