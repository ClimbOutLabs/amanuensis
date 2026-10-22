import type { ChatImageInputType } from '@truefoundry/trueforge-core/core/chatImages';
import { CHAT_IMAGE_INPUT_MIME_TYPES } from '@truefoundry/trueforge-core/core/chatImages';

import type { ISpaceStore } from '../../db/spaceStore';
import type { ChatImageRefusal } from '../../schemas/chatImages';
import { SPACE_LIST_LIMIT } from '../../schemas/space';
import { sniffImageType } from '../chatImages/imageSniff';
import { fetchRemoteImage, type RemoteImageFetchDeps } from '../chatImages/remoteImageFetch';
import { bodyLinks } from '../spaceBodyLinks';
import { isPlaceholder } from '../spaceLinks';

/** A picture a person's browser may show is kept this long in memory, and at most this many at once. */
export const SPACE_PICTURE_CACHE_TTL_MS = 5 * 60 * 1000;
export const SPACE_PICTURE_CACHE_MAX_ENTRIES = 16;

export type SpacePictureOutcome =
  | { status: 'shown'; bytes: Buffer; mime: string }
  | { status: 'not_in_spaces' }
  | { status: 'refused'; reason: ChatImageRefusal };

export interface SpacePictureServiceDeps<TTransaction> {
  spaceStore: Pick<ISpaceStore<TTransaction>, 'listSpaces'>;
  fetchDeps: RemoteImageFetchDeps;
  now: () => number;
}

export interface SpacePictureService {
  get(input: { tenant_id: string; created_by: string; url: string }): Promise<SpacePictureOutcome>;
}

interface CachedPicture {
  bytes: Buffer;
  mime: string;
  expires_at: number;
}

function isHttpsUrl(url: string): URL | undefined {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function mimeOf(type: ChatImageInputType): string | undefined {
  return [...CHAT_IMAGE_INPUT_MIME_TYPES].find(([, value]) => value === type)?.[0];
}

/**
 * Serves a space picture to its owner. The URL must be one a stored space of the caller contains
 * as a picture, which is the same extraction the write-time check uses: #322 only lets a picture
 * into a body after its link passed that check, so a stored picture is one that passed. The fetch
 * itself reuses the chat image fetcher (public addresses only, every redirect and DNS answer checked,
 * no cookies or Referer, byte cap, magic-number type check).
 */
export function createSpacePictureService<TTransaction>(
  deps: SpacePictureServiceDeps<TTransaction>,
): SpacePictureService {
  const cache = new Map<string, CachedPicture>();

  async function isStoredPicture(input: { tenant_id: string; created_by: string; url: string }): Promise<boolean> {
    let offset = 0;
    for (;;) {
      const page = await deps.spaceStore.listSpaces({
        tenant_id: input.tenant_id,
        created_by: input.created_by,
        status: undefined,
        limit: SPACE_LIST_LIMIT,
        offset,
      });
      const found = page.some(space =>
        (bodyLinks({ body: space.body, format: space.format }) ?? []).some(
          link => link.kind === 'picture' && link.value === input.url,
        ),
      );
      if (found) {
        return true;
      }
      if (page.length < SPACE_LIST_LIMIT) {
        return false;
      }
      offset += page.length;
    }
  }

  function cached(url: string): CachedPicture | undefined {
    const hit = cache.get(url);
    if (hit === undefined) {
      return undefined;
    }
    if (hit.expires_at <= deps.now()) {
      cache.delete(url);
      return undefined;
    }
    return hit;
  }

  function remember(url: string, picture: CachedPicture): void {
    cache.delete(url);
    cache.set(url, picture);
    while (cache.size > SPACE_PICTURE_CACHE_MAX_ENTRIES) {
      const oldest = cache.keys().next();
      if (oldest.done === true) {
        break;
      }
      cache.delete(oldest.value);
    }
  }

  return {
    async get(input) {
      const parsed = isHttpsUrl(input.url);
      if (parsed === undefined || isPlaceholder(parsed.hostname)) {
        return { status: 'refused', reason: 'blocked' };
      }
      if (!(await isStoredPicture(input))) {
        return { status: 'not_in_spaces' };
      }
      const hit = cached(input.url);
      if (hit !== undefined) {
        return { status: 'shown', bytes: hit.bytes, mime: hit.mime };
      }
      const fetched = await fetchRemoteImage({
        url: input.url,
        allowUrl: url => url.protocol === 'https:',
        deps: deps.fetchDeps,
      });
      if (!fetched.ok) {
        return { status: 'refused', reason: fetched.reason };
      }
      const type = sniffImageType(fetched.bytes);
      const mime = type === null ? undefined : mimeOf(type);
      if (mime === undefined) {
        return { status: 'refused', reason: 'unsupported_type' };
      }
      remember(input.url, { bytes: fetched.bytes, mime, expires_at: deps.now() + SPACE_PICTURE_CACHE_TTL_MS });
      return { status: 'shown', bytes: fetched.bytes, mime };
    },
  };
}
