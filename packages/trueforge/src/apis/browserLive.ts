import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { ResolveRequestContext } from '../auth/identity';
import {
  callBrowserSidecar,
  callBrowserSidecarForOwner,
  LiveFrameReplySchema,
  LiveInputReplySchema,
  LiveTabsReplySchema,
  type BrowserProfileRef,
  type BrowserTabRef,
} from '../runtime/browserCapability';

/** A tab id names a chat; it is the sidecar's own id shape, checked again there. */
const TabIdSchema = z.string().min(1).max(256);

const FrameRequestSchema = z.object({ tab: TabIdSchema }).strict();

const LiveClickInputSchema = z
  .object({
    tab: TabIdSchema,
    kind: z.literal('click'),
    x: z.number().finite(),
    y: z.number().finite(),
    image_width: z.number().positive().optional(),
    image_height: z.number().positive().optional(),
  })
  .strict();
const LiveTypeInputSchema = z
  .object({ tab: TabIdSchema, kind: z.literal('type'), text: z.string().min(1).max(10000) })
  .strict();
const LiveKeyInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('key'), key: z.string().min(1).max(64) }).strict();
const LiveWheelInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('wheel'), dy: z.number().finite() }).strict();

/** One act the person does in the live view: a click, typed text, one named key, or a scroll step. */
const LiveInputRequestSchema = z.discriminatedUnion('kind', [
  LiveClickInputSchema,
  LiveTypeInputSchema,
  LiveKeyInputSchema,
  LiveWheelInputSchema,
]);

export interface BrowserLiveRouterDeps {
  resolveRequestContext: ResolveRequestContext;
  logger: Logger;
}

/**
 * Browser-session-only routes behind the live view of Aman's browser: the signed-in person watches
 * a tab of their own browser profile and drives it by hand, for the steps only a person can do.
 * The profile always comes from the session, never the request, so a tab id in a request can only
 * ever name a tab inside the caller's own profile; the shared secret stays on this server.
 */
export function createBrowserLiveRouter(deps: BrowserLiveRouterDeps) {
  const app = new OpenAPIHono();

  function profileOf(c: Context): BrowserProfileRef {
    const requestContext = deps.resolveRequestContext(c);
    return { tenant_id: requestContext.tenant_id, created_by: requestContext.subject.id };
  }

  app.get('/tabs', async c => {
    const result = await callBrowserSidecarForOwner({
      path: '/live/tabs',
      profile: profileOf(c),
      schema: LiveTabsReplySchema,
    });
    if (!result.ok) {
      deps.logger.warn('browser live tab list failed', { message: result.message });
      return c.json({ error: { message: result.message } }, 502);
    }
    return c.json({ data: { tabs: result.body.tabs } }, 200);
  });

  app.post('/frame', async c => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = FrameRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: { message: 'That frame request was not understood. Try again.' } }, 400);
    }
    const tab: BrowserTabRef = { ...profileOf(c), chat_id: request.data.tab };
    const result = await callBrowserSidecar({ path: '/live/frame', tab, schema: LiveFrameReplySchema });
    if (!result.ok) {
      deps.logger.warn('browser live frame failed', { message: result.message });
      return c.json({ error: { message: result.message } }, 502);
    }
    return c.json({ data: result.body }, 200);
  });

  app.post('/input', async c => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = LiveInputRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: { message: 'That input was not understood. Try again.' } }, 400);
    }
    const { tab: tabId, ...input } = request.data;
    const tab: BrowserTabRef = { ...profileOf(c), chat_id: tabId };
    const result = await callBrowserSidecar({ path: '/live/input', tab, schema: LiveInputReplySchema, body: input });
    if (!result.ok) {
      deps.logger.warn('browser live input failed', { message: result.message });
      return c.json({ error: { message: result.message } }, 502);
    }
    if (result.body.status === 'bad_input') {
      return c.json({ error: { message: 'That input was not understood. Try again.' } }, 400);
    }
    return c.json({ data: result.body }, 200);
  });

  return app;
}
