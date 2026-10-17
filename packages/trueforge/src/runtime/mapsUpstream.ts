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

/** Largest geocoder or router JSON body read; the tile proxy applies the same cap to image bodies. */
export const UPSTREAM_JSON_MAX_BODY_BYTES = 512 * 1024;

/** Read a body without ever holding more than `maxBytes`; null when it is larger. */
export async function readCappedBody({
  response,
  maxBytes,
}: {
  response: Response;
  maxBytes: number;
}): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body?.getReader();
  if (reader === undefined) {
    return new Uint8Array();
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const read: { done: boolean; value?: unknown } = await reader.read();
    if (read.done) {
      break;
    }
    const value = read.value;
    if (!(value instanceof Uint8Array)) {
      await reader.cancel();
      return null;
    }
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/** Parse a capped JSON body; null when the body is over the cap or is not valid JSON. */
export async function readCappedJson(response: Response): Promise<{ value: unknown } | null> {
  const body = await readCappedBody({ response, maxBytes: UPSTREAM_JSON_MAX_BODY_BYTES });
  if (body === null) {
    return null;
  }
  try {
    return { value: JSON.parse(new TextDecoder().decode(body)) };
  } catch {
    return null;
  }
}

/**
 * GET with the identifying headers and a total timeout, following at most one same-origin redirect.
 * Throws when the upstream redirects elsewhere or redirects twice.
 */
export async function fetchSameOrigin({
  url,
  headers,
  timeoutMs,
  onRequest,
}: {
  url: string;
  headers: Record<string, string>;
  timeoutMs: number;
  /** Called with the upstream host just before each request is sent. */
  onRequest?: ((host: string) => void) | undefined;
}): Promise<Response> {
  const signal = AbortSignal.timeout(timeoutMs);
  onRequest?.(new URL(url).host);
  const first = await fetch(url, { headers, signal, redirect: 'manual' });
  if (!isRedirect(first)) {
    return first;
  }
  // A redirect body is never read; cancel it so the connection is released before the next request.
  await first.body?.cancel();
  const location = first.headers.get('location');
  const target = location === null ? null : safeRedirectTarget({ upstreamUrl: url, location });
  if (target === null) {
    throw new Error('Upstream redirected to another origin');
  }
  onRequest?.(new URL(target).host);
  const second = await fetch(target, { headers, signal, redirect: 'manual' });
  if (isRedirect(second)) {
    await second.body?.cancel();
    throw new Error('Upstream redirected more than once');
  }
  return second;
}
