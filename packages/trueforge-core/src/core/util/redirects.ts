/** Whether an HTTP status answers with a redirect, which a caller that does not follow redirects must refuse. */
export function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

function resolveUrl({ location, base }: { location: string; base: string | URL | undefined }): URL | undefined {
  try {
    return base === undefined ? new URL(location) : new URL(location, base);
  } catch {
    return undefined;
  }
}

/**
 * Origin a redirect response points at, or undefined when it names no http(s) location. Only the
 * origin is reported: a Location can carry a secret in its query, and the origin is all an error
 * or a log line needs to say where the answer led. A relative Location is resolved against
 * `requestUrl`; an absolute one needs no usable base.
 */
export function redirectTargetOrigin({
  response,
  requestUrl,
}: {
  response: Response;
  requestUrl: string | URL;
}): string | undefined {
  const location = response.headers.get('location');
  if (location === null) {
    return undefined;
  }
  const target = resolveUrl({ location, base: requestUrl }) ?? resolveUrl({ location, base: undefined });
  return target !== undefined && (target.protocol === 'http:' || target.protocol === 'https:')
    ? target.origin
    : undefined;
}
