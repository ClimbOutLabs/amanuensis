import {
  NOTICING_KINDS,
  type DeliveriesApi,
  type DeliveryItem,
  type DeliveryLink,
  type NoticingKind,
  type PushDevice,
  type ReachApi,
  type ReachChannelState,
  type ReachSender,
  type ReachSettings,
  type ReachView,
  type TextsApi,
  type TextStatus,
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

const UNREADABLE = 'Your Reach me settings could not be read. Reload the page.';

function kindOf(value: unknown): NoticingKind | null {
  return NOTICING_KINDS.find(kind => kind === value) ?? null;
}

/** A field the server always sends. One that is missing or of the wrong type means the reply cannot be trusted. */
function required<T>(value: unknown, check: (candidate: unknown) => candidate is T): T {
  if (!check(value)) {
    throw new Error(UNREADABLE);
  }
  return value;
}

const isString = (value: unknown): value is string => typeof value === 'string';
const isNumber = (value: unknown): value is number => typeof value === 'number';
const isBoolean = (value: unknown): value is boolean => typeof value === 'boolean';
const isArray = (value: unknown): value is unknown[] => Array.isArray(value);

const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === 'string';

function parseChannel(value: unknown): ReachChannelState {
  const channel = required(value, isRecord);
  return {
    available: required(channel.available, isBoolean),
    note: required(channel.note, isString),
    problem: required(channel.problem, isStringOrNull),
  };
}

const isSenderSource = (value: unknown): value is ReachSender['source'] => value === 'settings' || value === 'memory';

/** The server leaves `name` out when the person gave none; anything else it sends must be what it says it is. */
function parseSender(value: unknown): ReachSender {
  const sender = required(value, isRecord);
  return {
    address: required(sender.address, isString),
    name: sender.name === undefined ? null : required(sender.name, isString),
    source: required(sender.source, isSenderSource),
    addedAt: required(sender.added_at, isString),
  };
}

/** The server always sends every field. Kinds this version does not know are dropped, never guessed. */
function parseSettings(value: unknown): ReachSettings {
  const raw = required(value, isRecord);
  const channels = required(raw.channels, isRecord);
  const quiet = required(raw.quiet_hours, isRecord);
  return {
    noticingOn: required(raw.noticing_on, isBoolean),
    textsOn: required(channels.texts, isBoolean),
    callsOn: required(channels.calls, isBoolean),
    alwaysImportant: required(raw.always_important, isArray).map(parseSender),
    dismissedSuggestions: required(raw.dismissed_suggestions, isArray).filter(isString),
    callKinds: required(raw.call_kinds, isArray)
      .map(kindOf)
      .filter(kind => kind !== null),
    callForUrgentReminders: required(raw.call_for_urgent_reminders, isBoolean),
    quietHours: {
      enabled: required(quiet.enabled, isBoolean),
      start: required(quiet.start, isString),
      end: required(quiet.end, isString),
    },
    timezone: required(raw.timezone, isString),
    maxNudgesPerDay: required(raw.max_nudges_per_day, isNumber),
    minHoursBetweenCalls: required(raw.min_hours_between_calls, isNumber),
    travelLeadMinutes: required(raw.travel_lead_minutes, isNumber),
    approvalWaitMinutes: required(raw.approval_wait_minutes, isNumber),
  };
}

function parseMailProblem(value: unknown): ReachView['mailProblem'] {
  if (value === null) {
    return null;
  }
  const raw = required(value, isRecord);
  const kind = raw.kind;
  const since = required(raw.since, isString);
  if (Number.isNaN(new Date(since).getTime())) {
    throw new Error(UNREADABLE);
  }
  return {
    since,
    kind: kind === 'too_slow' || kind === 'google_sign_in' || kind === 'email_password' ? kind : 'other',
  };
}

function parseCalendarProblem(value: unknown): ReachView['calendarProblem'] {
  if (value === null || value === undefined) {
    return null;
  }
  const raw = required(value, isRecord);
  const since = required(raw.since, isString);
  if (Number.isNaN(new Date(since).getTime())) {
    throw new Error(UNREADABLE);
  }
  return { since, kind: raw.kind === 'google_sign_in' ? 'google_sign_in' : 'other' };
}

function parseMailSource(value: unknown): ReachView['mailSource'] {
  return value === 'google' || value === 'email_connector' ? value : null;
}

function parseMailSenderConfirmation(value: unknown): ReachView['mailSenderConfirmation'] {
  return typeof value === 'boolean' ? value : null;
}

function parseView(body: unknown): ReachView {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) {
    throw new Error(UNREADABLE);
  }
  const availability = required(data.availability, isRecord);
  const levels = required(data.max_levels, isRecord);
  const maxLevels: ReachView['maxLevels'] = {};
  for (const kind of NOTICING_KINDS) {
    const level = levels[kind];
    if (level === 'note' || level === 'nudge' || level === 'call') {
      maxLevels[kind] = level;
    }
  }
  return {
    settings: parseSettings(data.settings),
    saved: required(data.saved, isBoolean),
    availability: { texts: parseChannel(availability.texts), calls: parseChannel(availability.calls) },
    maxLevels,
    mailProblem: parseMailProblem(data.mail_problem),
    calendarProblem: parseCalendarProblem(data.calendar_problem),
    mailSource: parseMailSource(data.mail_source),
    mailSenderConfirmation: parseMailSenderConfirmation(data.mail_sender_confirmation),
  };
}

function settingsBody(settings: ReachSettings): unknown {
  return {
    noticing_on: settings.noticingOn,
    channels: { texts: settings.textsOn, calls: settings.callsOn },
    always_important: settings.alwaysImportant.map(sender => ({
      address: sender.address,
      ...(sender.name === null ? {} : { name: sender.name }),
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

function parseTextStatus(body: unknown): TextStatus {
  const data = isRecord(body) ? body.data : undefined;
  if (!isRecord(data)) {
    throw new Error('Your number for texts could not be read. Reload the page.');
  }
  return {
    phone: typeof data.phone === 'string' ? data.phone : null,
    confirmed: data.confirmed === true,
    mode: data.mode === 'full' ? 'full' : 'private',
    optedOut: data.opted_out === true,
    codePending: data.code_pending === true,
    pendingPhone: typeof data.pending_phone === 'string' ? data.pending_phone : null,
    privatePreview: typeof data.private_preview === 'string' ? data.private_preview : '',
    words: Array.isArray(data.words) ? data.words.filter((word): word is string => typeof word === 'string') : [],
  };
}

function createTextsApi(fetcher: typeof fetch): TextsApi {
  const url = () => apiPath(`${REACH_URL}/texts`);
  return {
    async status() {
      return parseTextStatus(await readBody(await fetcher(url())));
    },
    async sendCode(phone) {
      return parseTextStatus(await readBody(await fetcher(`${url()}/code`, json({ phone }))));
    },
    async confirm(code) {
      return parseTextStatus(await readBody(await fetcher(`${url()}/confirm`, json({ code }))));
    },
    async setMode(mode) {
      const response = await fetcher(url(), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mode }),
      });
      return parseTextStatus(await readBody(response));
    },
    async addWord(word) {
      return parseTextStatus(await readBody(await fetcher(`${url()}/words`, json({ word }))));
    },
    async removeWord(word) {
      return parseTextStatus(
        await readBody(await fetcher(`${url()}/words/${encodeURIComponent(word)}`, json({}, 'DELETE'))),
      );
    },
    async remove() {
      await readBody(await fetcher(url(), json({}, 'DELETE')));
    },
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
    texts: createTextsApi(fetcher),
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
    async pushDeviceSaved(endpoint) {
      // The address goes in the body, so it stays out of request logs.
      const body = await readBody(await fetcher(apiPath(`${PUSH_URL}/subscriptions/lookup`), json({ endpoint })));
      const data = isRecord(body) ? body.data : undefined;
      return isRecord(data) && data.saved === true;
    },
    async removePushDevice(endpoint) {
      // The address goes in the body, so it stays out of request logs.
      await readBody(await fetcher(apiPath(`${PUSH_URL}/subscriptions`), json({ endpoint }, 'DELETE')));
    },
  };
}
