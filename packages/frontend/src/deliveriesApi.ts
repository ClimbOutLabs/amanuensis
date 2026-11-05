import type {
  DeliveriesApi,
  DeliveryItem,
  DeliveryLink,
  NoticingKind,
  PushDevice,
  ReachApi,
  ReachSettings,
  ReachView,
} from '@truefoundry/trueforge-ui';

import { apiPath, UI_BASE_PATH } from './publicPath';

// The server owns the wire shapes (src/schemas/deliveries.ts). Bodies are checked here, never asserted: an item or
// link this version does not recognise is dropped rather than drawn wrong.
const DELIVERIES_URL = '/api/v1/user/deliveries';
const PUSH_URL = '/api/v1/user/push';
const REACH_URL = '/api/v1/user/reach';

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

function json(body: unknown, method: 'POST' | 'DELETE' = 'POST'): RequestInit {
  return { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) };
}

const KINDS: readonly NoticingKind[] = ['mail_always', 'calendar_clash', 'travel', 'bill_due', 'approval_waiting'];

function kindOf(value: unknown): NoticingKind | null {
  return KINDS.find(kind => kind === value) ?? null;
}

function stringOr(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' ? value : fallback;
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function parseChannel(value: unknown): { available: boolean; note: string } {
  return isRecord(value)
    ? { available: value.available === true, note: stringOr(value.note, '') }
    : { available: false, note: '' };
}

function parseSettings(value: unknown): ReachSettings {
  const raw = isRecord(value) ? value : {};
  const channels = isRecord(raw.channels) ? raw.channels : {};
  const quiet = isRecord(raw.quiet_hours) ? raw.quiet_hours : {};
  const senders = Array.isArray(raw.always_important) ? raw.always_important : [];
  const callKinds = Array.isArray(raw.call_kinds) ? raw.call_kinds : [];
  const dismissed = Array.isArray(raw.dismissed_suggestions) ? raw.dismissed_suggestions : [];
  return {
    textsOn: channels.texts === true,
    callsOn: channels.calls === true,
    alwaysImportant: senders.flatMap(sender =>
      isRecord(sender) && typeof sender.address === 'string' && typeof sender.added_at === 'string'
        ? [
            {
              address: sender.address,
              name: typeof sender.name === 'string' ? sender.name : null,
              source: sender.source === 'memory' ? ('memory' as const) : ('settings' as const),
              addedAt: sender.added_at,
            },
          ]
        : [],
    ),
    dismissedSuggestions: dismissed.filter(item => typeof item === 'string'),
    callKinds: callKinds.map(kindOf).filter(kind => kind !== null),
    callForUrgentReminders: raw.call_for_urgent_reminders === true,
    quietHours: {
      enabled: boolOr(quiet.enabled, true),
      start: stringOr(quiet.start, '21:00'),
      end: stringOr(quiet.end, '08:00'),
    },
    timezone: stringOr(raw.timezone, 'UTC'),
    maxNudgesPerDay: numberOr(raw.max_nudges_per_day, 5),
    minHoursBetweenCalls: numberOr(raw.min_hours_between_calls, 6),
    travelLeadMinutes: numberOr(raw.travel_lead_minutes, 90),
    approvalWaitMinutes: numberOr(raw.approval_wait_minutes, 120),
  };
}

function parseView(body: unknown): ReachView {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data) || !isRecord(data.settings)) {
    throw new Error('Your Reach me settings could not be read. Reload the page.');
  }
  const availability = isRecord(data.availability) ? data.availability : {};
  const levels = isRecord(data.max_levels) ? data.max_levels : {};
  const maxLevels: ReachView['maxLevels'] = {};
  for (const kind of KINDS) {
    const level = levels[kind];
    if (level === 'note' || level === 'nudge' || level === 'call') {
      maxLevels[kind] = level;
    }
  }
  return {
    settings: parseSettings(data.settings),
    saved: data.saved === true,
    availability: { texts: parseChannel(availability.texts), calls: parseChannel(availability.calls) },
    maxLevels,
  };
}

function settingsBody(settings: ReachSettings): unknown {
  return {
    channels: { texts: settings.textsOn, calls: settings.callsOn },
    always_important: settings.alwaysImportant.map(sender => ({
      address: sender.address,
      name: sender.name,
      source: sender.source,
      added_at: sender.addedAt,
    })),
    dismissed_suggestions: settings.dismissedSuggestions,
    call_kinds: settings.callKinds,
    call_for_urgent_reminders: settings.callForUrgentReminders,
    quiet_hours: settings.quietHours,
    timezone: settings.timezone,
    max_nudges_per_day: settings.maxNudgesPerDay,
    min_hours_between_calls: settings.minHoursBetweenCalls,
    travel_lead_minutes: settings.travelLeadMinutes,
    approval_wait_minutes: settings.approvalWaitMinutes,
  };
}

function createReachApi(fetcher: typeof fetch): ReachApi {
  return {
    async get() {
      return parseView(await readBody(await fetcher(apiPath(REACH_URL))));
    },
    async save(settings) {
      const response = await fetcher(apiPath(REACH_URL), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ settings: settingsBody(settings) }),
      });
      return parseView(await readBody(response));
    },
    async suggestions() {
      const body = await readBody(await fetcher(apiPath(`${REACH_URL}/suggestions`)));
      const rows: unknown = isRecord(body) ? body.data : undefined;
      return Array.isArray(rows)
        ? rows.flatMap(row =>
            isRecord(row) && typeof row.address === 'string' && typeof row.memory === 'string'
              ? [{ address: row.address, memory: row.memory }]
              : [],
          )
        : [];
    },
    async test(channel) {
      const body = await readBody(await fetcher(apiPath(`${REACH_URL}/test`), json({ channel })));
      const data = isRecord(body) ? body.data : undefined;
      return { devicesReached: isRecord(data) && typeof data.devices_reached === 'number' ? data.devices_reached : 0 };
    },
  };
}

/** Backs `DeliveriesProvider`: the signed-in person's feed and push devices. */
export function createDeliveriesApi(fetcher: typeof fetch): DeliveriesApi {
  return {
    reach: createReachApi(fetcher),
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
    async markAllSeen() {
      return unreadCountOf(await readBody(await fetcher(apiPath(`${DELIVERIES_URL}/seen-all`), json({}))));
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
      const response = await fetcher(
        apiPath(`${PUSH_URL}/subscriptions`),
        json({
          endpoint: device.endpoint,
          keys: { p256dh: device.p256dh, auth: device.auth },
          label: device.label,
        }),
      );
      // 409: another account holds this address; the caller makes a fresh subscription.
      if (response.status === 409) {
        return 'taken';
      }
      await readBody(response);
      return 'saved';
    },
    async removePushDevice(endpoint) {
      // The address goes in the body, so it stays out of request logs.
      await readBody(await fetcher(apiPath(`${PUSH_URL}/subscriptions`), json({ endpoint }, 'DELETE')));
    },
  };
}
