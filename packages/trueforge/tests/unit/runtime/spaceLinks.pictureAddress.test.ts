import { createWebSearchTurnState } from '@truefoundry/trueforge-core/core';
import { recordPageImageUrls, recordSearchResults } from '@truefoundry/trueforge-core/core/permissions/provenance';
import { Response as UndiciResponse } from 'undici';
import type { SpaceRecord } from '../../../src/db/spaceStore';
import { dropUnseenSpaceLinks } from '../../../src/runtime/spaceLinks';
import { createSpacePictureService } from '../../../src/runtime/spacePictures/spacePictureService';
import { EXAMPLE_COM_ADDRESS } from '../../fixtures/exampleComAddress';

/** A picture an opened page listed. */
const SEEN = 'https://cdn.photos.test/album/fox.jpg';
/** A page a search returned. */
const RESULT = 'https://foxes.test/guide';

function chat() {
  const state = createWebSearchTurnState();
  recordPageImageUrls({ provenance: state.provenance, urls: [SEEN] });
  recordSearchResults({
    provenance: state.provenance,
    texts: [JSON.stringify({ results: [{ title: 'Foxes', url: RESULT }] })],
  });
  return state;
}

/** How many pictures a write of one picture cuts out: 0 when it stays, 1 when it goes. */
function picturesCut(input: { picture: string; format: 'html' | 'markdown' }): number {
  const body = input.format === 'html' ? `<p><img src="${input.picture}" alt="Fox"></p>` : `![Fox](${input.picture})`;
  return dropUnseenSpaceLinks({ body, previousBody: '', format: input.format, web_search: chat() }).pictures;
}

describe.each(['html', 'markdown'] as const)('a picture address in a %s space', format => {
  it.each([
    ['exactly as the page listed it', SEEN],
    ['with a fragment added, which never leaves this machine', `${SEEN}#top`],
    ['with www added, which names the same site', 'https://www.cdn.photos.test/album/fox.jpg'],
    ['as the address of a page a search returned', RESULT],
  ])('stays %s', (_label, picture) => {
    expect(picturesCut({ picture, format })).toBe(0);
  });

  it.each([
    ['adds a query', `${SEEN}?size=large`],
    ['adds a path segment', `${SEEN}/large`],
    ['changes a path segment', 'https://cdn.photos.test/other/fox.jpg'],
    ['adds a subdomain', 'https://img.cdn.photos.test/album/fox.jpg'],
    ['names another site', 'https://pictures.test/fox.jpg'],
    ['adds a port', 'https://cdn.photos.test:8443/album/fox.jpg'],
    ['adds a query to a page a search returned', `${RESULT}?size=large`],
  ])('is cut out when it %s', (_label, picture) => {
    expect(picturesCut({ picture, format })).toBe(1);
  });
});

describe('what the picture route fetches for a picture a space holds', () => {
  const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

  async function view(picture: string) {
    const fetched: string[] = [];
    const record: SpaceRecord = {
      tenant_id: 'default',
      created_by: 'user-a',
      id: 'space-1',
      name: 'Foxes',
      purpose: '',
      status: 'active',
      body: `![Fox](${picture})`,
      format: 'markdown',
      revision: 1,
      created_at: '2026-10-01T00:00:00.000Z',
      updated_at: '2026-10-01T00:00:00.000Z',
    };
    const pictures = createSpacePictureService({
      spaceStore: {
        listSpaces: input => Promise.resolve(input.offset === 0 || input.offset === undefined ? [record] : []),
      },
      fetchDeps: {
        fetchImpl: (url: unknown) => {
          fetched.push(String(url));
          return Promise.resolve(new UndiciResponse(PNG, { status: 200, headers: { 'content-type': 'image/png' } }));
        },
        resolveAddresses: () => Promise.resolve([EXAMPLE_COM_ADDRESS]),
      },
      now: () => 0,
    });
    const outcome = await pictures.get({ tenant_id: 'default', created_by: 'user-a', url: picture });
    return { outcome, fetched };
  }

  it('fetches the picture as the space holds it', async () => {
    const { outcome, fetched } = await view(SEEN);
    expect(outcome.status).toBe('shown');
    expect(fetched).toEqual([SEEN]);
  });

  it('refuses an address with a sign-in name before the site and fetches nothing', async () => {
    const { outcome, fetched } = await view('https://someone@cdn.photos.test/album/fox.jpg');
    expect(outcome.status).toBe('refused');
    expect(fetched).toEqual([]);
  });
});
