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
  lookupPushSubscriptionRoute,
  markAllDeliveriesSeenRoute,
  markDeliveriesSeenRoute,
} from '../routes/deliveryRoutes';
import type { Delivery } from '../schemas/deliveries';

export interface DeliveriesRouterDeps {
  deliveryStore: IDeliveryStore;
  sessionStore: Pick<ISessionStore<SessionCustom, TurnCustom>, 'getOwnedIds'>;
  resolveRequestContext: ResolveRequestContext;
}

export interface PushRouterDeps {
  pushSubscriptionStore: IPushSubscriptionStore;
  /** The public VAPID key, or undefined while push is off. */
  publicKey: string | undefined;
  resolveRequestContext: ResolveRequestContext;
}

/** The signed-in person's feed, mounted at /api/v1/user/deliveries. Every read and write is scoped to tenant and creator. */
/** How many unread approval items one count checks for a chat that is gone. */
const UNREAD_APPROVAL_CHECK_LIMIT = 500;

export function createDeliveriesRouter(deps: DeliveriesRouterDeps) {
  const ownerOf = (c: Parameters<ResolveRequestContext>[0]) => {
    const context = deps.resolveRequestContext(c);
    return { tenant_id: context.tenant_id, created_by: context.subject.id };
  };

  // A link to a chat that has since been deleted leads nowhere, and a link to someone else's chat
  // is not the viewer's to open, so the item is served without its link: the words stay in the
  // feed, and no Open is offered. Space links name no chat, so they are served as stored. An item
  // waiting on an approval in a chat that is gone can never be answered, so it leaves the feed and
  // is marked seen in the store, which takes it out of the unread count too. One ownership lookup
  // covers the whole page.
  const resolveChatLinks = async (
    deliveries: readonly Delivery[],
    owner: { tenant_id: string; created_by: string },
  ): Promise<Delivery[]> => {
    const sessionIds = [
      ...new Set(
        deliveries.flatMap(delivery =>
          delivery.link !== null && delivery.link.type !== 'space' ? [delivery.link.session_id] : [],
        ),
      ),
    ];
    if (sessionIds.length === 0) {
      return [...deliveries];
    }
    const owned = new Set(
      await deps.sessionStore.getOwnedIds({
        tenant_id: owner.tenant_id,
        subject_id: owner.created_by,
        ids: sessionIds,
      }),
    );
    const resolved: Delivery[] = [];
    const answerless: string[] = [];
    for (const delivery of deliveries) {
      const link = delivery.link;
      if (link === null || link.type === 'space' || owned.has(link.session_id)) {
        resolved.push(delivery);
      } else if (delivery.kind === 'approval_waiting') {
        if (delivery.seen_at === null) {
          answerless.push(delivery.id);
        }
      } else {
        resolved.push({ ...delivery, link: null });
      }
    }
    await deps.deliveryStore.markSeen({ ...owner, ids: answerless });
    return resolved;
  };

  // The unread count leaves out approval items whose chat is gone: they are checked first, the same
  // way the feed checks them, so the bell never counts an item the feed does not show. Approval items
  // are few (one per waiting request), so one bounded read covers them.
  const countUnread = async (owner: { tenant_id: string; created_by: string }): Promise<number> => {
    const approvals = await deps.deliveryStore.listUnread({
      ...owner,
      kinds: ['approval_waiting'],
      limit: UNREAD_APPROVAL_CHECK_LIMIT,
    });
    await resolveChatLinks(approvals, owner);
    return deps.deliveryStore.countUnread(owner);
  };

  const listHandler: RouteHandler<typeof listDeliveriesRoute> = async c => {
    const query = c.req.valid('query');
    const owner = ownerOf(c);
    try {
      const page = await deps.deliveryStore.list({ ...owner, limit: query.limit, page_token: query.page_token });
      const deliveries = await resolveChatLinks(page.deliveries, owner);
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
    const unread_count = await countUnread(ownerOf(c));
    return c.json({ data: { unread_count } }, 200);
  };

  const seenHandler: RouteHandler<typeof markDeliveriesSeenRoute> = async c => {
    const owner = ownerOf(c);
    const { ids } = c.req.valid('json');
    await deps.deliveryStore.markSeen({ ...owner, ids });
    const unread_count = await countUnread(owner);
    return c.json({ data: { unread_count } }, 200);
  };

  const seenAllHandler: RouteHandler<typeof markAllDeliveriesSeenRoute> = async c => {
    const owner = ownerOf(c);
    await deps.deliveryStore.markAllSeen(owner);
    const unread_count = await countUnread(owner);
    return c.json({ data: { unread_count } }, 200);
  };

  const getHandler: RouteHandler<typeof getDeliveryRoute> = async c => {
    const { delivery_id: id } = c.req.valid('param');
    const owner = ownerOf(c);
    const stored = await deps.deliveryStore.get({ ...owner, id });
    // Another person's delivery reads as missing, so its existence is not revealed. So does an
    // approval item resolved because its chat is gone.
    const [delivery] = stored === undefined ? [] : await resolveChatLinks([stored], owner);
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
