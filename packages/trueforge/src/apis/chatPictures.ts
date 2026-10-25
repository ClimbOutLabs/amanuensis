import { OpenAPIHono } from '@hono/zod-openapi';

import type { ResolveRequestContext } from '../auth/identity';
import type { ChatPictureService } from '../runtime/chatPictures/chatPictureService';

import { ChatPictureQuerySchema } from '../schemas/chatPictures';
import { IMAGE_SAFETY_HEADERS } from './chatImages';

/** Pictures are fetched again after the in-memory cache expires; the browser may hold one briefly. */
const PICTURE_CACHE_CONTROL = 'private, max-age=300';

export interface ChatPicturesRouterDeps {
  pictures: ChatPictureService;
  sessions: {
    get(input: {
      tenant_id: string;
      session_id: string;
    }): Promise<{ record: { created_by_subject: { subject_id: string } } } | undefined>;
  };
  resolveRequestContext: ResolveRequestContext;
}

/**
 * Browser-only route that proxies a picture a chat page links to. Only the signed-in owner of
 * the chat may use it, and only for a URL that chat's stored turns show as seen; the app mounts
 * it behind the browser session middleware so no agent or API token can fetch on the person's
 * behalf. An unseen link is refused, full stop, so the proxy can never fetch an arbitrary URL.
 */
export function createChatPicturesRouter(deps: ChatPicturesRouterDeps) {
  const app = new OpenAPIHono();

  app.get('/', async c => {
    const query = ChatPictureQuerySchema.safeParse({
      session_id: c.req.query('session_id'),
      url: c.req.query('url'),
    });
    if (!query.success) {
      return c.json({ error: { message: 'Picture not found in this chat.' } }, 404);
    }
    const requestContext = deps.resolveRequestContext(c);
    const session = await deps.sessions.get({
      tenant_id: requestContext.tenant_id,
      session_id: query.data.session_id,
    });
    if (session?.record.created_by_subject.subject_id !== requestContext.subject.id) {
      return c.json({ error: { message: 'Chat not found.' } }, 404);
    }
    const outcome = await deps.pictures.get({
      session_id: query.data.session_id,
      url: query.data.url,
    });
    if (outcome.status === 'not_in_chat') {
      return c.json({ error: { message: 'Picture not found in this chat.' } }, 404);
    }
    if (outcome.status === 'refused') {
      return c.json({ error: { message: 'This picture could not be shown.' } }, 422);
    }
    return c.body(new Uint8Array(outcome.bytes), 200, {
      ...IMAGE_SAFETY_HEADERS,
      'Content-Type': outcome.mime,
      'Content-Length': String(outcome.bytes.byteLength),
      'Cache-Control': PICTURE_CACHE_CONTROL,
    });
  });

  return app;
}
