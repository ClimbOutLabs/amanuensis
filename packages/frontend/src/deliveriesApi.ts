import type { DeliveriesApi, DeliveryItem, DeliveryLink, PushDevice } from '@truefoundry/trueforge-ui';

import { apiPath, UI_BASE_PATH } from './publicPath';

// The server owns the wire shapes (src/schemas/deliveries.ts). Bodies are checked here, never asserted: an item or
// link this version does not recognise is dropped rather than drawn wrong.
const DELIVERIES_URL = '/api/v1/user/deliveries';
const PUSH_URL = '/api/v1/user/push';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseLink(value: unknown): DeliveryLink | null {
  if (!isRecord(value)) {
    return null;
  }
  if (value.type === 'chat' && typeof value.session_id === 'string') {
    return { type: 'chat', sessionId: value.session_id };
  }
  if (value.type === 'approval' && typeof value.session_id === 'string' && typeof value.approval_id === 'string') {
    return { type: 'approval', sessionId: value.session_id, approvalId: value.approval_id };
  }
  if (value.type === 'space' && typeof value.space_id === 'string') {
    return { type: 'space', spaceId: value.space_id };
  }
  return null;
}

function parseItem(value: unknown): DeliveryItem | null {
  if (!isRecord(value)) {
    return null;
  }
  const { id, kind, text, reason, created_at: createdAt, seen_at: seenAt } = value;
  if (
    typeof id !== 'string' ||
    typeof kind !== 'string' ||
    typeof text !== 'string' ||
    typeof reason !== 'string' ||
    typeof createdAt !== 'string' ||
    !(seenAt === null || typeof seenAt === 'string')
  ) {
    return null;
  }
  return { id, kind, text, reason, link: parseLink(value.link), createdAt, seenAt };
}

function errorMessage({ body, status }: { body: unknown; status: number }): string {
  if (isRecord(body) && isRecord(body.error) && typeof body.error.message === 'string' && body.error.message !== '') {
    return body.error.message;
  }
  return `That did not work (error ${String(status)}). Try again in a moment.`;
}

async function readBody(response: Response): Promise<unknown> {
  const body: unknown = await response.json().catch((): null => null);
  if (!response.ok) {
    throw new Error(errorMessage({ body, status: response.status }));
  }
  return body;
}

function unreadCountOf(body: unknown): number {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || typeof data.unread_count !== 'number') {
    throw new Error('The unread count could not be read. Reload the page.');
  }
  return data.unread_count;
}

function json(body: unknown): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

/** Backs `DeliveriesProvider`: the signed-in person's feed and push devices. */
export function createDeliveriesApi(fetcher: typeof fetch): DeliveriesApi {
  return {
    pushWorker: { url: `${UI_BASE_PATH}sw.js`, scope: UI_BASE_PATH },
    async list({ limit, pageToken }) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (pageToken !== undefined) {
        query.set('page_token', pageToken);
      }
      const body = await readBody(await fetcher(`${apiPath(DELIVERIES_URL)}?${query.toString()}`));
      const rows: unknown = isRecord(body) ? body.data : undefined;
      const items = Array.isArray(rows) ? rows.map(parseItem).filter(item => item !== null) : [];
      const next = isRecord(body) && typeof body.next_page_token === 'string' ? body.next_page_token : undefined;
      return { items, nextPageToken: next };
    },
    async unreadCount() {
      return unreadCountOf(await readBody(await fetcher(apiPath(`${DELIVERIES_URL}/unread-count`))));
    },
    async markSeen(ids) {
      return unreadCountOf(await readBody(await fetcher(apiPath(`${DELIVERIES_URL}/seen`), json({ ids }))));
    },
    async get(id) {
      const response = await fetcher(apiPath(`${DELIVERIES_URL}/${encodeURIComponent(id)}`));
      if (response.status === 404) {
        return null;
      }
      const body = await readBody(response);
      return parseItem(isRecord(body) ? body.data : undefined);
    },
    async pushPublicKey() {
      const body = await readBody(await fetcher(apiPath(`${PUSH_URL}/config`)));
      const data = isRecord(body) ? body.data : undefined;
      return isRecord(data) && typeof data.public_key === 'string' ? data.public_key : null;
    },
    async savePushDevice(device: PushDevice) {
      await readBody(
        await fetcher(
          apiPath(`${PUSH_URL}/subscriptions`),
          json({
            endpoint: device.endpoint,
            keys: { p256dh: device.p256dh, auth: device.auth },
            label: device.label,
          }),
        ),
      );
    },
    async removePushDevice(endpoint) {
      const query = new URLSearchParams({ endpoint });
      await readBody(
        await fetcher(`${apiPath(`${PUSH_URL}/subscriptions`)}?${query.toString()}`, { method: 'DELETE' }),
      );
    },
  };
}
