import { createSpacePicturesRouter } from '../../../src/apis/spacePictures';
import type { RequestContext } from '../../../src/auth/identity';
import type { SpacePictureOutcome, SpacePictureService } from '../../../src/runtime/spacePictures/spacePictureService';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7]);
const PICTURE = 'https://cdn.photos.test/chart.png';
const USER: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-a', type: 'user', display_name: 'user-a' },
  roles: [],
  user_credential: null,
};

function router(outcome: SpacePictureOutcome) {
  const calls: { tenant_id: string; created_by: string; url: string }[] = [];
  const pictures: SpacePictureService = {
    get: async input => {
      calls.push(input);
      return outcome;
    },
  };
  const app = createSpacePicturesRouter({ pictures, resolveRequestContext: () => USER, tenantId: 'default' });
  return { calls, request: (query: string) => app.request(`/?${query}`) };
}

describe('GET /api/space-pictures', () => {
  it('returns the picture with the safety headers and the owner’s scope', async () => {
    const { calls, request } = router({ status: 'shown', bytes: PNG, mime: 'image/png' });
    const response = await request(`url=${encodeURIComponent(PICTURE)}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(calls).toEqual([{ tenant_id: 'default', created_by: 'user-a', url: PICTURE }]);
  });

  it('answers not found for a URL no stored space contains', async () => {
    const { request } = router({ status: 'not_in_spaces' });
    const response = await request(`url=${encodeURIComponent(PICTURE)}`);
    expect(response.status).toBe(404);
  });

  it('answers unprocessable with the one plain line for a refused picture', async () => {
    const { request } = router({ status: 'refused', reason: 'unsupported_type' });
    const response = await request(`url=${encodeURIComponent(PICTURE)}`);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: { message: 'This picture could not be shown.' } });
  });

  it('answers not found without asking the service when no url is given', async () => {
    const { calls, request } = router({ status: 'shown', bytes: PNG, mime: 'image/png' });
    const response = await request('');
    expect(response.status).toBe(404);
    expect(calls).toEqual([]);
  });
});
