import { OpenAPIHono } from '@hono/zod-openapi';
import { timingSafeEqual } from 'node:crypto';
import { truefoundryAdminMiddleware } from '../../../src/auth/middleware';

jest.mock('node:crypto', () => {
  const actual = jest.requireActual<typeof import('node:crypto')>('node:crypto');
  return { ...actual, timingSafeEqual: jest.fn(actual.timingSafeEqual) };
});

jest.mock('../../../src/config', () => {
  const actual = jest.requireActual<typeof import('../../../src/config')>('../../../src/config');
  return {
    ...actual,
    __esModule: true,
    default: { ...actual.default, STANDALONE: false, TRUEFOUNDRY_API_KEY: 'service-key' },
  };
});

function adminApp() {
  const app = new OpenAPIHono();
  app.use('*', truefoundryAdminMiddleware);
  app.post('/', c => c.body(null, 204));
  return app;
}

const post = (authorization: string | undefined) =>
  adminApp().request('/', {
    method: 'POST',
    ...(authorization === undefined ? {} : { headers: { Authorization: authorization } }),
  });

describe('the service admin key check', () => {
  beforeEach(() => {
    jest.mocked(timingSafeEqual).mockClear();
  });

  it('lets the configured key in', async () => {
    expect((await post('Bearer service-key')).status).toBe(204);
  });

  it.each([
    ['no key', undefined],
    ['a wrong key of the same length', 'Bearer service-keY'],
    ['a shorter key', 'Bearer service'],
    ['a longer key that starts with the right one', 'Bearer service-key-and-more'],
  ])('refuses %s', async (_label, authorization) => {
    expect((await post(authorization)).status).toBe(403);
  });

  it.each([
    ['the right key', 'Bearer service-key'],
    ['a wrong key of the same length', 'Bearer service-keY'],
    ['a key of another length', 'Bearer short'],
  ])('compares %s in constant time', async (_label, authorization) => {
    await post(authorization);
    expect(timingSafeEqual).toHaveBeenCalledTimes(1);
  });
});
