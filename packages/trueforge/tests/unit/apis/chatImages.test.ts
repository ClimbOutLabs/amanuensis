import { Hono } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { createLogger } from 'winston';
import { z } from 'zod';

import { createChatImagesRouter } from '../../../src/apis/chatImages';
import type { Authenticator } from '../../../src/auth/authenticator';
import { resolveRequestContext, type RequestContext } from '../../../src/auth/identity';
import { createUiSessionAuthMiddleware } from '../../../src/auth/middleware';
import { createChatImageService } from '../../../src/runtime/chatImages/chatImageService';
import { TurnImageListSchema, TurnImagesResultSchema } from '../../../src/schemas/chatImages';
import { FakeChatImageStore } from '../../fixtures/fakeChatImageStore';
import { FakeTurnArtifactStore } from '../../fixtures/fakeTurnArtifactStore';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 5, 5]);
const IMAGE_ID = 'f'.repeat(32);
const USER: RequestContext = {
  tenant_id: 'default',
  subject: { id: 'user-a', type: 'user', display_name: 'user-a' },
  roles: [],
  user_credential: null,
};

const cookieAuthenticator: Authenticator = {
  authenticate: c => {
    if (c.req.header('Cookie')?.includes('accessToken=') !== true) {
      return Promise.reject(new HTTPException(401, { message: 'Authentication required' }));
    }
    return Promise.resolve(USER);
  },
};

async function buildApp() {
  const store = new FakeChatImageStore();
  await store.putImage({
    tenant_id: 'default',
    created_by: 'user-a',
    session_id: 'mine',
    turn_id: 't1',
    image_id: IMAGE_ID,
    source_key: 'upload:0',
    origin: 'local',
    mime: 'image/png',
    width: 2,
    height: 2,
    data: PNG,
    user_max_bytes: 1e9,
  });
  const chats: Record<string, string> = { mine: 'user-a', theirs: 'user-b' };
  const app = new Hono();
  app.use('*', createUiSessionAuthMiddleware(cookieAuthenticator));
  app.route(
    '/api/chat-images',
    createChatImagesRouter({
      sessions: {
        get: input => {
          const creator = chats[input.session_id];
          return Promise.resolve(
            creator === undefined
              ? undefined
              : {
                  record: { created_by_subject: { subject_id: creator } },
                  getTurn: (turnId: string) => Promise.resolve(turnId === 't1' ? { id: turnId } : undefined),
                },
          );
        },
      },
      chatImages: createChatImageService({
        store,
        sessionStore: {
          listTurnEvents: () => Promise.resolve({ data: [], pagination: { limit: 200 } }),
        },
        turnArtifactStore: new FakeTurnArtifactStore(),
        reencode: () => Promise.resolve({ ok: false, reason: 'sandbox_unavailable' }),
        sentinel: {
          audit: null,
          isOffline: () => Promise.resolve(false),
          outboundSecrets: () => Promise.resolve([]),
        },
        fetchDeps: { fetchImpl: undefined, resolveAddresses: undefined },
      }),
      resolveRequestContext,
      logger: createLogger({ silent: true }),
    }),
  );
  return app;
}

const session = { Cookie: 'accessToken=session' };

describe('chat image routes', () => {
  it('serves a stored image as an inert, private picture', async () => {
    const app = await buildApp();
    const response = await app.request(`/api/chat-images/sessions/mine/images/${IMAGE_ID}`, { headers: session });
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(PNG);
    expect(Object.fromEntries(response.headers)).toMatchObject({
      'content-type': 'image/png',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; sandbox",
      'content-disposition': 'inline; filename="image.png"',
      'cross-origin-resource-policy': 'same-origin',
      'cache-control': 'private, max-age=86400, immutable',
    });
  });

  it('refuses any bearer credential, so no agent can approve a card', async () => {
    const app = await buildApp();
    const bearer = { ...session, Authorization: 'Bearer agent-token' };
    expect((await app.request(`/api/chat-images/sessions/mine/images/${IMAGE_ID}`, { headers: bearer })).status).toBe(
      401,
    );
    const post = await app.request('/api/chat-images/sessions/mine/turns/t1', {
      method: 'POST',
      headers: { ...bearer, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { kind: 'email', tool_call_id: 'mail-1' }, approved: true }),
    });
    expect(post.status).toBe(401);
  });

  it("hides another person's chat and unknown images", async () => {
    const app = await buildApp();
    for (const path of [
      `/api/chat-images/sessions/theirs/images/${IMAGE_ID}`,
      `/api/chat-images/sessions/mine/images/${'0'.repeat(32)}`,
      '/api/chat-images/sessions/mine/images/not-an-id',
      '/api/chat-images/sessions/theirs/turns/t1',
      '/api/chat-images/sessions/mine/turns/t9',
    ]) {
      expect((await app.request(path, { headers: session })).status).toBe(404);
    }
  });

  it('lists a turn images and answers a show request', async () => {
    const app = await buildApp();
    const list = await app.request('/api/chat-images/sessions/mine/turns/t1', { headers: session });
    expect(z.object({ data: TurnImageListSchema }).parse(await list.json()).data).toEqual({
      artifacts: [],
      tool_images: [],
      emails: [],
    });

    const post = (body: unknown) =>
      app.request('/api/chat-images/sessions/mine/turns/t1', {
        method: 'POST',
        headers: { ...session, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    expect((await post({ source: { kind: 'svg' }, approved: true })).status).toBe(400);
    expect((await post({ source: { kind: 'email', tool_call_id: 'mail-1' }, approved: true })).status).toBe(404);
    const shown = await post({ source: { kind: 'reply', url: 'https://example.com/a.png' }, approved: false });
    expect(shown.status).toBe(404);
  });

  it('describes a show result in the documented shape', () => {
    expect(TurnImagesResultSchema.parse({ status: 'ask', count: 3, host: null })).toEqual({
      status: 'ask',
      count: 3,
      host: null,
    });
  });
});
