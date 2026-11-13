import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import { InvalidPageTokenError } from '@truefoundry/trueforge-core/agent-session';

import type { ResolveRequestContext } from '../auth/identity';
import type { IDeliveryStore } from '../db/deliveryStore';
import type { IPushSubscriptionStore } from '../db/pushSubscriptionStore';
import {
  createPushSubscriptionRoute,
  deletePushSubscriptionRoute,
  getDeliveryRoute,
  getDeliveryUnreadCountRoute,
  getPushConfigRoute,
  listDeliveriesRoute,
  lookupPushSubscriptionRoute,
  markAllDeliveriesSeenRoute,
  markDeliveriesSeenRoute,
} from '../routes/deliveryRoutes';

export interface DeliveriesRouterDeps {
  deliveryStore: IDeliveryStore;
  resolveRequestContext: ResolveRequestContext;
}

export interface PushRouterDeps {
  pushSubscriptionStore: IPushSubscriptionStore;
  /** The public VAPID key, or undefined while push is off. */
  publicKey: string | undefined;
  resolveRequestContext: ResolveRequestContext;
}

/** The signed-in person's feed, mounted at /api/v1/user/deliveries. Every read and write is scoped to tenant and creator. */
export function createDeliveriesRouter(deps: DeliveriesRouterDeps) {
  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const context = deps.resolveRequestContext(c);
    return { tenant_id: context.tenant_id, created_by: context.subject.id };
  };

  const listHandler: RouteHandler<typeof listDeliveriesRoute> = async c => {
    const query = c.req.valid('query');
    try {
      const page = await deps.deliveryStore.list({ ...ownerOf(c), limit: query.limit, page_token: query.page_token });
      return c.json({ data: page.deliveries, next_page_token: page.next_page_token }, 200);
    } catch (error) {
      if (error instanceof InvalidPageTokenError) {
        return c.json(
          { error: { message: 'That page of your feed is out of date. Reload to start from the newest.' } },
          400,
        );
      }
      throw error;
    }
  };

  const unreadHandler: RouteHandler<typeof getDeliveryUnreadCountRoute> = async c => {
    const unread_count = await deps.deliveryStore.countUnread(ownerOf(c));
    return c.json({ data: { unread_count } }, 200);
  };

  const seenHandler: RouteHandler<typeof markDeliveriesSeenRoute> = async c => {
    const owner = ownerOf(c);
    const { ids } = c.req.valid('json');
    await deps.deliveryStore.markSeen({ ...owner, ids });
    const unread_count = await deps.deliveryStore.countUnread(owner);
    return c.json({ data: { unread_count } }, 200);
  };

  const seenAllHandler: RouteHandler<typeof markAllDeliveriesSeenRoute> = async c => {
    const owner = ownerOf(c);
    await deps.deliveryStore.markAllSeen(owner);
    const unread_count = await deps.deliveryStore.countUnread(owner);
    return c.json({ data: { unread_count } }, 200);
  };

  const getHandler: RouteHandler<typeof getDeliveryRoute> = async c => {
    const { delivery_id: id } = c.req.valid('param');
    const delivery = await deps.deliveryStore.get({ ...ownerOf(c), id });
    // Another person's delivery reads as missing, so its existence is not revealed.
    if (delivery === undefined) {
      return c.json({ error: { message: 'That item was not found. Open your feed to see what is there.' } }, 404);
    }
    return c.json({ data: delivery }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(listDeliveriesRoute, listHandler);
  router.openapi(getDeliveryUnreadCountRoute, unreadHandler);
  router.openapi(markDeliveriesSeenRoute, seenHandler);
  router.openapi(markAllDeliveriesSeenRoute, seenAllHandler);
  router.openapi(getDeliveryRoute, getHandler);
  return router;
}

/** Devices that take push notices, mounted at /api/v1/user/push. */
export function createPushRouter(deps: PushRouterDeps) {
  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const context = deps.resolveRequestContext(c);
    return { tenant_id: context.tenant_id, created_by: context.subject.id };
  };

  const configHandler: RouteHandler<typeof getPushConfigRoute> = c =>
    c.json({ data: { public_key: deps.publicKey ?? null } }, 200);

  const createHandler: RouteHandler<typeof createPushSubscriptionRoute> = async c => {
    const body = c.req.valid('json');
    if (deps.publicKey === undefined) {
      return c.json(
        { error: { message: 'Push is not set up on this server. Ask the person who runs it to turn it on.' } },
        400,
      );
    }
    const saved = await deps.pushSubscriptionStore.save({
      ...ownerOf(c),
      endpoint: body.endpoint,
      p256dh: body.keys.p256dh,
      auth: body.keys.auth,
      label: body.label ?? null,
      server_key: deps.publicKey,
    });
    if (saved.outcome === 'taken') {
      return c.json(
        {
          error: {
            message: 'This browser gets notices for another account. Turn notices on again to set it up for you.',
          },
        },
        409,
      );
    }
    return c.json({ data: saved.subscription }, 201);
  };

  const deleteHandler: RouteHandler<typeof deletePushSubscriptionRoute> = async c => {
    const { endpoint } = c.req.valid('json');
    await deps.pushSubscriptionStore.removeByEndpoint({ ...ownerOf(c), endpoint });
    return c.json({}, 200);
  };

  const lookupHandler: RouteHandler<typeof lookupPushSubscriptionRoute> = async c => {
    const { endpoint } = c.req.valid('json');
    const saved = await deps.pushSubscriptionStore.hasEndpoint({ ...ownerOf(c), endpoint });
    return c.json({ data: { saved } }, 200);
  };

  const router = new OpenAPIHono();
  router.openapi(getPushConfigRoute, configHandler);
  router.openapi(createPushSubscriptionRoute, createHandler);
  router.openapi(deletePushSubscriptionRoute, deleteHandler);
  router.openapi(lookupPushSubscriptionRoute, lookupHandler);
  return router;
}
