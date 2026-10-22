import { OpenAPIHono } from '@hono/zod-openapi';

import type { ResolveRequestContext } from '../auth/identity';
import type { SpacePictureService } from '../runtime/spacePictures/spacePictureService';
import { SpacePictureQuerySchema } from '../schemas/spacePictures';
import { IMAGE_SAFETY_HEADERS } from './chatImages';

/** Pictures are fetched again after the in-memory cache expires; the browser may hold one briefly. */
const PICTURE_CACHE_CONTROL = 'private, max-age=300';

export interface SpacePicturesRouterDeps {
  pictures: SpacePictureService;
  resolveRequestContext: ResolveRequestContext;
  /** The tenant the spaces API stores its records under. */
  tenantId: string;
}

/**
 * Browser-only route that proxies a picture a space links to. Only the signed-in owner may use it,
 * and only for a URL one of their stored spaces contains; the app mounts it behind the browser
 * session middleware so no agent or API token can fetch on the person's behalf.
 */
export function createSpacePicturesRouter(deps: SpacePicturesRouterDeps) {
  const app = new OpenAPIHono();

  app.get('/', async c => {
    const query = SpacePictureQuerySchema.safeParse({ url: c.req.query('url') });
    if (!query.success) {
      return c.json({ error: { message: 'Picture not found in your spaces.' } }, 404);
    }
    const created_by = deps.resolveRequestContext(c).subject.id;
    const outcome = await deps.pictures.get({
      tenant_id: deps.tenantId,
      created_by,
      url: query.data.url,
    });
    if (outcome.status === 'not_in_spaces') {
      return c.json({ error: { message: 'Picture not found in your spaces.' } }, 404);
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
