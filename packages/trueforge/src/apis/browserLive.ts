import { OpenAPIHono } from '@hono/zod-openapi';
import type { Context } from 'hono';
import type { Logger } from 'winston';
import { z } from 'zod';

import type { ResolveRequestContext } from '../auth/identity';
import {
  callBrowserSidecar,
  callBrowserSidecarForOwner,
  LiveCopyReplySchema,
  LiveFrameReplySchema,
  LiveInputReplySchema,
  LiveTabsReplySchema,
  LiveTakeoverReplySchema,
  type BrowserProfileRef,
  type BrowserTabRef,
} from '../runtime/browserCapability';
import { requireJsonOrSameOrigin } from './crossSite';

/** A tab id names a chat; it is the sidecar's own id shape, checked again there. */
const TabIdSchema = z.string().min(1).max(256);

const FrameRequestSchema = z.object({ tab: TabIdSchema }).strict();

/** The point a pointer act names, and the frame size it was read from when the caller measured one. */
const LivePointShape = {
  x: z.number(),
  y: z.number(),
  image_width: z.number().positive().optional(),
  image_height: z.number().positive().optional(),
};

const LiveClickInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('click'), ...LivePointShape }).strict();
const LiveMoveInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('move'), ...LivePointShape }).strict();
const LiveDownInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('down'), ...LivePointShape }).strict();
const LiveUpInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('up'), ...LivePointShape }).strict();
const LiveTypeInputSchema = z
  .object({ tab: TabIdSchema, kind: z.literal('type'), text: z.string().min(1).max(10000) })
  .strict();
// Pasted text goes in as one insert, so a line break in it never presses Enter on the page.
const LivePasteInputSchema = z
  .object({ tab: TabIdSchema, kind: z.literal('paste'), text: z.string().min(1).max(10000) })
  .strict();
const LiveKeyInputSchema = z
  .object({ tab: TabIdSchema, kind: z.literal('key'), key: z.string().min(1).max(64) })
  .strict();
const LiveWheelInputSchema = z.object({ tab: TabIdSchema, kind: z.literal('wheel'), dy: z.number() }).strict();

/**
 * One act the person does in the live view: a click, the takeover pointer acts (move, down, up),
 * typed or pasted text, one named key, or a scroll step.
 */
const LiveInputRequestSchema = z.discriminatedUnion('kind', [
  LiveClickInputSchema,
  LiveMoveInputSchema,
  LiveDownInputSchema,
  LiveUpInputSchema,
  LiveTypeInputSchema,
  LivePasteInputSchema,
  LiveKeyInputSchema,
  LiveWheelInputSchema,
]);

/** Hands one tab to the person, or back to Aman; the tab itself stays where it is either way. */
const TakeoverRequestSchema = z.object({ tab: TabIdSchema, on: z.boolean() }).strict();

/** A file the person uploads into the page, as base64; at most 10 MiB once decoded. */
const UploadRequestSchema = z
  .object({
    tab: TabIdSchema,
    name: z.string().min(1).max(255),
    mime: z.string().max(255),
    data: z.string().min(1).max(14_000_000),
  })
  .strict();

const LiveUploadReplySchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('ok') }),
  z.object({ status: z.literal('no_file_field') }),
  z.object({ status: z.literal('bad_input') }),
  z.object({ status: z.literal('closed') }),
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

  // Every act below drives the person's own tab, so a form posted from another site must not reach it.
  for (const path of ['/frame', '/input', '/copy', '/upload', '/takeover']) {
    app.use(path, requireJsonOrSameOrigin());
  }

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

  // The selected text goes back to the person's own live view only: it is never logged or kept,
  // since it may be anything on the page.
  app.post('/copy', async c => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = FrameRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: { message: 'That copy request was not understood. Try again.' } }, 400);
    }
    const tab: BrowserTabRef = { ...profileOf(c), chat_id: request.data.tab };
    const result = await callBrowserSidecar({ path: '/live/copy', tab, schema: LiveCopyReplySchema });
    if (!result.ok) {
      deps.logger.warn('browser live copy failed', { message: result.message });
      return c.json({ error: { message: result.message } }, 502);
    }
    switch (result.body.status) {
      case 'ok':
        return c.json({ data: { text: result.body.text } }, 200);
      case 'nothing_selected':
        return c.json(
          { error: { message: 'Nothing is selected in the page. Select some text in the picture first.' } },
          409,
        );
      case 'password':
        return c.json(
          { error: { message: 'Passwords cannot be copied out of the page. Copy it from your password manager.' } },
          409,
        );
      case 'closed':
        return c.json({ error: { message: 'That tab has closed. Ask Aman to open the page again.' } }, 409);
    }
  });

  app.post('/takeover', async c => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = TakeoverRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: { message: 'That takeover request was not understood. Try again.' } }, 400);
    }
    const { tab: tabId, on } = request.data;
    const tab: BrowserTabRef = { ...profileOf(c), chat_id: tabId };
    const result = await callBrowserSidecar({
      path: '/live/takeover',
      tab,
      schema: LiveTakeoverReplySchema,
      body: { on },
    });
    if (!result.ok) {
      deps.logger.warn('browser live takeover failed', { message: result.message });
      return c.json({ error: { message: result.message } }, 502);
    }
    if (result.body.status === 'bad_input') {
      return c.json({ error: { message: 'That takeover request was not understood. Try again.' } }, 400);
    }
    return c.json({ data: result.body }, 200);
  });

  app.post('/upload', async c => {
    const body: unknown = await c.req.json().catch(() => undefined);
    const request = UploadRequestSchema.safeParse(body);
    if (!request.success) {
      return c.json({ error: { message: 'That file could not be sent. Files up to 10 MB work.' } }, 400);
    }
    const { tab: tabId, ...file } = request.data;
    const tab: BrowserTabRef = { ...profileOf(c), chat_id: tabId };
    const result = await callBrowserSidecar({ path: '/live/upload', tab, schema: LiveUploadReplySchema, body: file });
    if (!result.ok) {
      deps.logger.warn('browser live upload failed', { message: result.message });
      return c.json({ error: { message: result.message } }, 502);
    }
    switch (result.body.status) {
      case 'ok':
        return c.json({ data: result.body }, 200);
      case 'no_file_field':
        return c.json(
          { error: { message: 'This page has no place to upload a file. Click its upload button first.' } },
          409,
        );
      case 'closed':
        return c.json({ error: { message: 'That tab has closed. Ask Aman to open the page again.' } }, 409);
      case 'bad_input':
        return c.json({ error: { message: 'That file could not be sent. Files up to 10 MB work.' } }, 400);
    }
  });

  return app;
}
