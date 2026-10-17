import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';

import type { ResolveRequestContext } from '../auth/identity';
import { ChatImageNotFoundError, type ChatImageService } from '../runtime/chatImages/chatImageService';
import { ChatImageIdSchema, CreateTurnImagesRequestSchema } from '../schemas/chatImages';

/** A served image is only ever an inert picture: no sniffing, no script or framing if opened as a document. */
const IMAGE_SAFETY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Referrer-Policy': 'no-referrer',
};
/** Image ids are random and their bytes never change, so the browser may keep them. */
const IMAGE_CACHE_CONTROL = 'private, max-age=86400, immutable';

/** The part of a chat the routes read: who created it and whether a turn belongs to it. */
interface ChatImageSession {
  record: { created_by_subject: { subject_id: string } };
  getTurn(turnId: string): Promise<unknown>;
}

export interface ChatImagesRouterDeps {
  sessions: { get(input: { tenant_id: string; session_id: string }): Promise<ChatImageSession | undefined> };
  chatImages: ChatImageService;
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/**
 * Browser-only routes that show re-encoded images in chat. Only the chat's creator may use them, and
 * the app mounts them behind the browser-session middleware so no agent or API token can approve a
 * card on the person's behalf.
 */
export function createChatImagesRouter(deps: ChatImagesRouterDeps) {
  const app = new OpenAPIHono();

  /** The caller's own chat, and the turn in it when one is named; a Response when access is refused. */
  async function ownedTurn(input: { c: Context; session_id: string; turn_id: string | undefined }) {
    const requestContext = deps.resolveRequestContext(input.c);
    const session = await deps.sessions.get({ tenant_id: requestContext.tenant_id, session_id: input.session_id });
    if (session?.record.created_by_subject.subject_id !== requestContext.subject.id) {
      return input.c.json({ error: { message: 'Chat not found.' } }, 404);
    }
    if (input.turn_id !== undefined && (await session.getTurn(input.turn_id)) === undefined) {
      return input.c.json({ error: { message: 'Turn not found.' } }, 404);
    }
    return {
      owner: { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id },
      session_id: input.session_id,
    };
  }

  app.get('/sessions/:session_id/turns/:turn_id', async c => {
    const turn_id = c.req.param('turn_id');
    const access = await ownedTurn({ c, session_id: c.req.param('session_id'), turn_id });
    if (access instanceof Response) {
      return access;
    }
    return c.json({ data: await deps.chatImages.listTurnImages({ ...access, turn_id }) }, 200);
  });

  app.post('/sessions/:session_id/turns/:turn_id', async c => {
    const turn_id = c.req.param('turn_id');
    const access = await ownedTurn({ c, session_id: c.req.param('session_id'), turn_id });
    if (access instanceof Response) {
      return access;
    }
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = CreateTurnImagesRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: { message: 'Invalid image request.' } }, 400);
    }
    try {
      const data = await deps.chatImages.showTurnImages({ ...access, turn_id, request: request.data });
      return c.json({ data }, 200);
    } catch (error) {
      if (error instanceof ChatImageNotFoundError) {
        return c.json({ error: { message: error.message } }, 404);
      }
      throw error;
    }
  });

  app.get('/sessions/:session_id/images/:image_id', async c => {
    const imageId = ChatImageIdSchema.safeParse(c.req.param('image_id'));
    if (!imageId.success) {
      return c.json({ error: { message: 'Image not found.' } }, 404);
    }
    const access = await ownedTurn({ c, session_id: c.req.param('session_id'), turn_id: undefined });
    if (access instanceof Response) {
      return access;
    }
    const image = await deps.chatImages.getImage({
      tenant_id: access.owner.tenant_id,
      session_id: access.session_id,
      image_id: imageId.data,
    });
    if (image === undefined) {
      return c.json({ error: { message: 'Image not found.' } }, 404);
    }
    const extension = image.mime === 'image/webp' ? 'webp' : 'png';
    return c.body(new Uint8Array(image.data), 200, {
      ...IMAGE_SAFETY_HEADERS,
      'Content-Type': image.mime,
      'Content-Length': String(image.data.byteLength),
      'Content-Disposition': `inline; filename="image.${extension}"`,
      'Cache-Control': IMAGE_CACHE_CONTROL,
    });
  });

  return app;
}
