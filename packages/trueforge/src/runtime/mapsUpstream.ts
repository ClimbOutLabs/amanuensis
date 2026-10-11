/** Shared upstream fetch for the maps geocoder, router and tile proxy: same-origin redirects only. */

/**
 * Resolve a redirect target, returning null when it leaves the origin of the configured URL.
 * Requests never follow a redirect to a host (or scheme) the approval card did not name.
 */
export function safeRedirectTarget({
  upstreamUrl,
  location,
}: {
  upstreamUrl: string;
  location: string;
}): string | null {
  let target: URL;
  try {
    target = new URL(location, upstreamUrl);
  } catch {
    return null;
  }
  return target.origin === new URL(upstreamUrl).origin ? target.toString() : null;
}

function isRedirect(response: Response): boolean {
  return response.status >= 300 && response.status < 400;
}

/**
 * GET with the identifying headers and a total timeout, following at most one same-origin redirect.
 * Throws when the upstream redirects elsewhere or redirects twice.
 */
export async function fetchSameOrigin({
  url,
  headers,
  timeoutMs,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
}): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  const first = await fetch(url, { headers, signal, redirect: 'manual' });
  if (!isRedirect(first)) {
    return first;
  }
  const location = first.headers.get('location');
  const target = location === null ? null : safeRedirectTarget({ upstreamUrl: url, location });
  if (target === null) {
    throw new Error('Upstream redirected to another origin');
  }
  const second = await fetch(target, { headers, signal, redirect: 'manual' });
  if (isRedirect(second)) {
    throw new Error('Upstream redirected more than once');
  }
  return second;
}
