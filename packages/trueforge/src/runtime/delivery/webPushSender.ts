import { buildPushPayload } from '@block65/webcrypto-web-push';

import type { WebPushSettings } from '../../config';
import type { IPushSubscriptionStore, PushTarget } from '../../db/pushSubscriptionStore';
import type { Delivery, DeliveryAttempt, DeliveryKind } from '../../schemas/deliveries';
import { fetchPublicUrl, PublicFetchError, type ResolveAddresses } from '../publicFetch';
import type { DeliveryChannelSender } from './deliveryChannel';

/** How long a push service keeps a notice for a device that is off. */
const PUSH_TTL_SECONDS = 24 * 60 * 60;
const PUSH_TIMEOUT_MS = 10_000;

/**
 * The only words a push carries. They name no person, chat or reminder text, because a notice can show on a
 * locked screen. The page fetches the details once it opens.
 */
export function pushTitle(kind: DeliveryKind): string {
  switch (kind) {
    case 'reminder':
      return 'Reminder';
    case 'note':
      return 'A note for you';
    case 'nudge':
      return 'Something needs you today';
    case 'approval_waiting':
      return 'Something is waiting for your ok';
  }
}

/** The JSON a device receives: the item id and a short title, nothing more. */
export function pushBody(delivery: Delivery): string {
  return JSON.stringify({ delivery_id: delivery.id, title: pushTitle(delivery.kind) });
}

interface PushRequest {
  headers: Record<string, string>;
  body: Uint8Array<ArrayBuffer>;
}
type PushFetch = (url: string, init: PushRequest) => Promise<{ status: number }>;

/** A push service address is checked like any outside address: public, ports 80 and 443 only, no redirects. */
function describePushProblem(): string {
  return 'This device’s address is not a public push service.';
}

function publicPushFetch(resolveAddresses: ResolveAddresses | undefined): PushFetch {
  return async (url, init) => {
    const result = await fetchPublicUrl(url, {
      fetchImpl: undefined,
      resolveAddresses,
      timeoutMs: PUSH_TIMEOUT_MS,
      maxRedirects: 0,
      method: 'POST',
      headers: init.headers,
      body: init.body,
      allowHop: undefined,
      describe: describePushProblem,
    });
    const status = result.response.status;
    await result.release();
    return { status };
  };
}

function attempt({
  outcome,
  detail,
  target,
  at,
}: {
  outcome: DeliveryAttempt['outcome'];
  detail: string | null;
  target: string | null;
  at: Date;
}): DeliveryAttempt {
  return { channel: 'web_push', outcome, detail, target, attempted_at: at.toISOString() };
}

/** Sends one push per device the person turned notices on for. A note stays in the app. */
export function createWebPushSender({
  subscriptions,
  settings,
  resolveAddresses,
  fetchPush = publicPushFetch(resolveAddresses),
  now = () => new Date(),
}: {
  subscriptions: IPushSubscriptionStore;
  settings: WebPushSettings | undefined;
  /** DNS seam for tests. */
  resolveAddresses?: ResolveAddresses;
  fetchPush?: PushFetch;
  now?: () => Date;
}): DeliveryChannelSender {
  async function sendOne({
    target,
    delivery,
    owner,
  }: {
    target: PushTarget;
    delivery: Delivery;
    owner: { tenant_id: string; created_by: string };
  }): Promise<DeliveryAttempt> {
    if (settings === undefined) {
      return attempt({
        outcome: 'skipped',
        detail: 'Push is not set up on this server.',
        target: target.id,
        at: now(),
      });
    }
    try {
      const request = await buildPushPayload(
        { data: pushBody(delivery), options: { ttl: PUSH_TTL_SECONDS, urgency: 'normal' } },
        { endpoint: target.endpoint, expirationTime: null, keys: { p256dh: target.p256dh, auth: target.auth } },
        { subject: settings.subject, publicKey: settings.publicKey, privateKey: settings.privateKey },
      );
      const response = await fetchPush(target.endpoint, { headers: request.headers, body: request.body });
      if (response.status >= 200 && response.status < 300) {
        return attempt({ outcome: 'sent', detail: null, target: target.id, at: now() });
      }
      if (response.status === 404 || response.status === 410) {
        await subscriptions.removeById({ ...owner, id: target.id });
        return attempt({
          outcome: 'gone',
          detail: 'This device no longer takes notices, so it was removed. Turn notices on there again in Settings.',
          target: target.id,
          at: now(),
        });
      }
      return attempt({
        outcome: 'failed',
        detail: `The push service answered ${String(response.status)}. The item is still in your feed.`,
        target: target.id,
        at: now(),
      });
    } catch (error) {
      // An address that is not a public push service will never work, so it is removed. A failed lookup may pass.
      if (
        error instanceof PublicFetchError &&
        error.problem.kind !== 'lookup_failed' &&
        error.problem.kind !== 'unresolved'
      ) {
        await subscriptions.removeById({ ...owner, id: target.id });
        return attempt({
          outcome: 'gone',
          detail:
            'This device’s address is not a public push service, so it was removed. Turn notices on there again in Settings.',
          target: target.id,
          at: now(),
        });
      }
      return attempt({
        outcome: 'failed',
        detail: 'The push service could not be reached. The item is still in your feed.',
        target: target.id,
        at: now(),
      });
    }
  }

  return {
    async send({ delivery, tenant_id, created_by }) {
      if (delivery.level === 'note') {
        return [];
      }
      const owner = { tenant_id, created_by };
      const targets = await subscriptions.listTargets(owner);
      return Promise.all(targets.map(target => sendOne({ target, delivery, owner })));
    },
  };
}
