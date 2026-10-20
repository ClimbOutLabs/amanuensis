import type { fetch as undiciFetch } from 'undici';

import type { ChatImageRefusal } from '../../schemas/chatImages';
import { readCappedBody } from '../mapsUpstream';
import { fetchPublicUrl, PublicFetchError, type PublicFetchProblem, type ResolveAddresses } from '../publicFetch';
import { imageTypeFromContentType, sniffImageType } from './imageSniff';
import { CHAT_IMAGE_FETCH_MAX_REDIRECTS, CHAT_IMAGE_FETCH_TIMEOUT_MS, CHAT_IMAGE_REMOTE_MAX_BYTES } from './limits';

export type RemoteImageFetchOutcome =
  { ok: true; bytes: Buffer; finalUrl: string } | { ok: false; reason: ChatImageRefusal };

export interface RemoteImageFetchDeps {
  fetchImpl: typeof undiciFetch | undefined;
  resolveAddresses: ResolveAddresses | undefined;
}

const BLOCKED_PROBLEMS: ReadonlySet<PublicFetchProblem['kind']> = new Set([
  'invalid_url',
  'scheme',
  'credentials',
  'port',
  'private_host',
  'refused_hop',
]);

/**
 * Downloads one image on the host for the sandbox to re-encode. Public addresses only, every redirect
 * re-checked (including by `allowUrl`, the caller's outbound guard), no cookies, Referer or
 * credentials, one time budget, a byte cap, and the Content-Type and leading bytes must both name the
 * same allow-listed type.
 */
export async function fetchRemoteImage(input: {
  url: string;
  allowUrl: (url: URL) => boolean;
  deps: RemoteImageFetchDeps;
}): Promise<RemoteImageFetchOutcome> {
  let fetched: Awaited<ReturnType<typeof fetchPublicUrl>>;
  try {
    fetched = await fetchPublicUrl(input.url, {
      fetchImpl: input.deps.fetchImpl,
      resolveAddresses: input.deps.resolveAddresses,
      timeoutMs: CHAT_IMAGE_FETCH_TIMEOUT_MS,
      maxRedirects: CHAT_IMAGE_FETCH_MAX_REDIRECTS,
      headers: { 'user-agent': 'Amanuensis-Image/1.0', accept: 'image/png, image/jpeg, image/gif, image/webp' },
      allowHop: input.allowUrl,
      describe: problem => `Image fetch stopped: ${problem.kind}`,
    });
  } catch (error) {
    if (error instanceof PublicFetchError && BLOCKED_PROBLEMS.has(error.problem.kind)) {
      return { ok: false, reason: 'blocked' };
    }
    return { ok: false, reason: 'fetch_failed' };
  }
  try {
    if (!fetched.response.ok) {
      return { ok: false, reason: 'fetch_failed' };
    }
    const claimed = imageTypeFromContentType(fetched.response.headers.get('content-type'));
    if (claimed === null) {
      return { ok: false, reason: 'unsupported_type' };
    }
    const body = await readCappedBody({ response: fetched.response, maxBytes: CHAT_IMAGE_REMOTE_MAX_BYTES });
    if (body === null) {
      return { ok: false, reason: 'too_large' };
    }
    if (sniffImageType(body) !== claimed) {
      return { ok: false, reason: 'unsupported_type' };
    }
    return { ok: true, bytes: Buffer.from(body), finalUrl: fetched.finalUrl };
  } catch {
    return { ok: false, reason: 'fetch_failed' };
  } finally {
    await fetched.release();
  }
}
