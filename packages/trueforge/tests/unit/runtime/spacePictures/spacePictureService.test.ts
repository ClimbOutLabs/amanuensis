import { Response as UndiciResponse } from 'undici';

import type { SpaceRecord } from '../../../../src/db/spaceStore';
import { CHAT_IMAGE_REMOTE_MAX_BYTES } from '../../../../src/runtime/chatImages/limits';
import {
  createSpacePictureService,
  SPACE_PICTURE_CACHE_TTL_MS,
  type SpacePictureOutcome,
} from '../../../../src/runtime/spacePictures/spacePictureService';
import { EXAMPLE_COM_ADDRESS } from '../../../fixtures/exampleComAddress';

const TENANT_ID = 'default';
const OWNER = 'user-a';
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const PICTURE = 'https://cdn.photos.test/chart.png';

function space(body: string, format: 'markdown' | 'html' = 'markdown'): SpaceRecord {
  return {
    tenant_id: TENANT_ID,
    created_by: OWNER,
    id: 'space-1',
    name: 'Sales',
    purpose: '',
    status: 'active',
    body,
    format,
    revision: 1,
    created_at: '2026-10-01T00:00:00.000Z',
    updated_at: '2026-10-01T00:00:00.000Z',
  };
}

function storeWith(...spaces: SpaceRecord[]) {
  return {
    listSpaces: async (input: { created_by: string; offset?: number | undefined }) =>
      input.offset === undefined || input.offset === 0
        ? spaces.filter(item => item.created_by === input.created_by)
        : [],
  };
}

/** Public hosts resolve to a public address; `rebind.test` answers with loopback, as a rebinding DNS would. */
async function resolveAddresses(hostname: string): Promise<string[]> {
  if (hostname === 'rebind.test') {
    return ['127.0.0.1'];
  }
  return [EXAMPLE_COM_ADDRESS];
}

function image(body: Uint8Array, contentType = 'image/png'): UndiciResponse {
  return new UndiciResponse(body, { status: 200, headers: { 'content-type': contentType } });
}

function redirect(location: string): UndiciResponse {
  return new UndiciResponse(null, { status: 302, headers: { location } });
}

function service(input: {
  body: string;
  handler?: (url: string) => UndiciResponse;
  now?: () => number;
  format?: 'markdown' | 'html';
}) {
  const seen: string[] = [];
  const fetchImpl = async (url: unknown): Promise<UndiciResponse> => {
    seen.push(String(url));
    return input.handler?.(String(url)) ?? image(PNG);
  };
  const pictures = createSpacePictureService({
    spaceStore: storeWith(space(input.body, input.format)),
    fetchDeps: { fetchImpl, resolveAddresses },
    now: input.now ?? (() => 0),
  });
  const get = (url: string): Promise<SpacePictureOutcome> =>
    pictures.get({ tenant_id: TENANT_ID, created_by: OWNER, url });
  return { seen, get };
}

describe('space picture service', () => {
  it('serves a picture a stored space contains, and keeps it briefly in memory', async () => {
    const { seen, get } = service({ body: `![chart](${PICTURE})` });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'shown', bytes: PNG, mime: 'image/png' });
    expect(seen).toEqual([PICTURE]);
  });

  it('refuses a URL that no stored space of the owner contains, without fetching it', async () => {
    const { seen, get } = service({ body: `![chart](${PICTURE})` });
    await expect(get('https://cdn.photos.test/other.png')).resolves.toEqual({ status: 'not_in_spaces' });
    expect(seen).toEqual([]);
  });

  it('does not serve a space picture to a different owner', async () => {
    const pictures = createSpacePictureService({
      spaceStore: storeWith(space(`![chart](${PICTURE})`)),
      fetchDeps: { fetchImpl: undefined, resolveAddresses },
      now: () => 0,
    });
    await expect(pictures.get({ tenant_id: TENANT_ID, created_by: 'user-b', url: PICTURE })).resolves.toEqual({
      status: 'not_in_spaces',
    });
  });

  it('refuses a picture on a private address literal', async () => {
    const url = 'https://10.0.0.5/chart.png';
    const { seen, get } = service({ body: `![chart](${url})` });
    await expect(get(url)).resolves.toEqual({ status: 'refused', reason: 'blocked' });
    expect(seen).toEqual([]);
  });

  it('refuses a name that resolves to loopback (DNS rebinding)', async () => {
    const url = 'https://rebind.test/chart.png';
    const { get } = service({ body: `![chart](${url})` });
    await expect(get(url)).resolves.toEqual({ status: 'refused', reason: 'blocked' });
  });

  it('refuses a redirect that leads to a private address', async () => {
    const { get } = service({
      body: `![chart](${PICTURE})`,
      handler: () => redirect('https://192.168.1.10/chart.png'),
    });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'refused', reason: 'blocked' });
  });

  it('refuses a plain http picture', async () => {
    const url = 'http://cdn.photos.test/chart.png';
    const { seen, get } = service({ body: `![chart](${url})` });
    await expect(get(url)).resolves.toEqual({ status: 'refused', reason: 'blocked' });
    expect(seen).toEqual([]);
  });

  it('refuses a placeholder domain, as the write-time check does', async () => {
    const url = 'https://example.com/chart.png';
    const { seen, get } = service({ body: `![chart](${url})` });
    await expect(get(url)).resolves.toEqual({ status: 'refused', reason: 'blocked' });
    expect(seen).toEqual([]);
  });

  it('refuses an SVG, even when served as an image', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>');
    const { get } = service({ body: `![chart](${PICTURE})`, handler: () => image(svg, 'image/svg+xml') });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'refused', reason: 'unsupported_type' });
  });

  it('refuses bytes that are not a listed image type, even when the header says PNG', async () => {
    const { get } = service({
      body: `![chart](${PICTURE})`,
      handler: () => image(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')),
    });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'refused', reason: 'unsupported_type' });
  });

  it('refuses a picture over the size cap', async () => {
    const big = Buffer.alloc(CHAT_IMAGE_REMOTE_MAX_BYTES + 1);
    PNG.copy(big);
    const { get } = service({ body: `![chart](${PICTURE})`, handler: () => image(big) });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'refused', reason: 'too_large' });
  });

  it('gives up after three redirects', async () => {
    const { get } = service({
      body: `![chart](${PICTURE})`,
      handler: url => redirect(`${url}?again`),
    });
    await expect(get(PICTURE)).resolves.toEqual({ status: 'refused', reason: 'fetch_failed' });
  });

  it('fetches again once the cached picture has expired', async () => {
    let now = 0;
    const { seen, get } = service({ body: `![chart](${PICTURE})`, now: () => now });
    await get(PICTURE);
    now = SPACE_PICTURE_CACHE_TTL_MS;
    await get(PICTURE);
    expect(seen).toHaveLength(2);
  });

  it('finds a picture in a markdown image on a later page of the owner’s spaces', async () => {
    const pictures = createSpacePictureService({
      spaceStore: {
        listSpaces: async input => {
          if (input.offset === 0) {
            return Array.from({ length: 500 }, (_, index) => ({ ...space('plain text'), id: `s${String(index)}` }));
          }
          return [space(`<img src="${PICTURE}">`, 'html')];
        },
      },
      fetchDeps: { fetchImpl: async () => image(PNG), resolveAddresses },
      now: () => 0,
    });
    await expect(pictures.get({ tenant_id: TENANT_ID, created_by: OWNER, url: PICTURE })).resolves.toEqual({
      status: 'shown',
      bytes: PNG,
      mime: 'image/png',
    });
  });
});
