import { OpenAPIHono, type RouteHandler } from '@hono/zod-openapi';

import { InvalidPageTokenError, type ISessionStore } from '@truefoundry/trueforge-core/agent-session';

import type { ResolveRequestContext } from '../auth/identity';
import type { IDeliveryStore } from '../db/deliveryStore';
import type { IPushSubscriptionStore } from '../db/pushSubscriptionStore';
import type { SessionCustom, TurnCustom } from '../db/sessionCustom';
import {
  createPushSubscriptionRoute,
  deletePushSubscriptionRoute,
  getDeliveryRoute,
  getDeliveryUnreadCountRoute,
  getPushConfigRoute,
  listDeliveriesRoute,
  markAllDeliveriesSeenRoute,
  markDeliveriesSeenRoute,
} from '../routes/deliveryRoutes';
import type { Delivery } from '../schemas/deliveries';

export interface DeliveriesRouterDeps {
  deliveryStore: IDeliveryStore;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getSession'>;
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

  // A link to a chat that has since been deleted leads nowhere, so the item is served without its
  // link: the words stay in the feed, and no Open is offered for a chat that is gone. Space links
  // name no chat, so they are served as stored. An approval-waiting item keeps its link, because
  // its wire shape requires one; the app opens nothing for a chat it cannot load.
  const withoutDeadChatLink = async (delivery: Delivery, tenant_id: string): Promise<Delivery> => {
    const link = delivery.link;
    if (link === null || link.type === 'space' || delivery.kind === 'approval_waiting') {
      return delivery;
    }
    const session = await deps.sessionStore.getSession({ tenant_id, session_id: link.session_id });
    return session === undefined ? { ...delivery, link: null } : delivery;
  };

  const listHandler: RouteHandler<typeof listDeliveriesRoute> = async c => {
    const query = c.req.valid('query');
    const owner = ownerOf(c);
    try {
      const page = await deps.deliveryStore.list({ ...owner, limit: query.limit, page_token: query.page_token });
      const deliveries = await Promise.all(
        page.deliveries.map(delivery => withoutDeadChatLink(delivery, owner.tenant_id)),
      );
      return c.json({ data: deliveries, next_page_token: page.next_page_token }, 200);
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
    const owner = ownerOf(c);
    const delivery = await deps.deliveryStore.get({ ...owner, id });
    // Another person's delivery reads as missing, so its existence is not revealed.
    if (delivery === undefined) {
      return c.json({ error: { message: 'That item was not found. Open your feed to see what is there.' } }, 404);
    }
    return c.json({ data: await withoutDeadChatLink(delivery, owner.tenant_id) }, 200);
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

  const router = new OpenAPIHono();
  router.openapi(getPushConfigRoute, configHandler);
  router.openapi(createPushSubscriptionRoute, createHandler);
  router.openapi(deletePushSubscriptionRoute, deleteHandler);
  return router;
}
