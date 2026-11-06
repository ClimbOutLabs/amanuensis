import { createHmac } from 'node:crypto';

import type { PersonOwner } from '../../db/personOwner';
import type { ITextContactStore } from '../../db/textContactStore';

export const HOUR_MS = 60 * 60_000;
/** The longest window of any limit, so old counts can be forgotten without ending a window that is still open. */
export const DAY_MS = 24 * HOUR_MS;

/** Texts a day to one person from deliveries of every kind, reminders and tests included, so a loop cannot run up the bill. */
export const MAX_TEXTS_PER_PERSON_PER_DAY = 30;
/** Texts a day to one number, however many people confirmed it. */
export const MAX_TEXTS_PER_NUMBER_PER_DAY = 30;
/** Test texts an hour from the Try it button. */
export const MAX_TEST_TEXTS_PER_HOUR = 3;

/** At most `max` sends for `key` in a window that ends `window_ms` after its first send, at most a day. */
export interface TextLimit {
  key: string;
  window_ms: number;
  max: number;
}

/** What the delivery limits need from the server: the secret that keys number counts, and the server's day cap. */
export interface DeliveryLimitSettings {
  number_key: string;
  max_texts_per_day: number;
}

interface LimitRefusal {
  ok: false;
  limit: TextLimit;
  retry_in_minutes: number;
}
/** Refused, it names the limit that refused and how long until that limit has room. */
type LimitResult = { ok: true } | LimitRefusal;

export function ownerLimitKey({ scope, owner }: { scope: string; owner: PersonOwner }): string {
  return `${scope}:${JSON.stringify([owner.tenant_id, owner.created_by])}`;
}

/**
 * Country codes whose numbers are dialled at home with a 0 in front, which people often type after the code as well.
 * Country codes never begin one another, so a match here is the number's whole country code.
 */
// prettier-ignore
const TRUNK_ZERO_CODES = new Set([
  '20', '27', '31', '32', '33', '41', '43', '44', '46', '49', '51', '54', '55', '60', '61', '62', '63', '64', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '98', '212', '213', '234', '254', '255', '256', '353', '358',
  '380', '880', '966', '971', '972',
]);

/** The number as a limit counts it: a trunk 0 typed after a country code that uses one is left out. */
function limitNumber(phone: string): string {
  for (const length of [1, 2, 3]) {
    const code = phone.slice(1, 1 + length);
    if (TRUNK_ZERO_CODES.has(code)) {
      const rest = phone.slice(1 + length);
      return rest.startsWith('0') ? `+${code}${rest.slice(1)}` : phone;
    }
  }
  return phone;
}

/** A limit's key for one number, keyed with a server secret so the count table never holds the number itself. */
export function numberLimitKey({ secret, scope, phone }: { secret: string; scope: string; phone: string }): string {
  const number = createHmac('sha256', secret)
    .update(`number\u0000${limitNumber(phone)}`)
    .digest('hex');
  return `${scope}:${number}`;
}

/** The limits one delivery text counts against, claimed in this order: the person, the number and the whole server. */
export function deliveryTextLimits({
  owner,
  phone,
  settings,
}: {
  owner: PersonOwner;
  phone: string;
  settings: DeliveryLimitSettings;
}): { person: TextLimit; number: TextLimit; server: TextLimit } {
  return {
    person: { key: ownerLimitKey({ scope: 'texts-day', owner }), window_ms: DAY_MS, max: MAX_TEXTS_PER_PERSON_PER_DAY },
    number: {
      key: numberLimitKey({ secret: settings.number_key, scope: 'texts-number-day', phone }),
      window_ms: DAY_MS,
      max: MAX_TEXTS_PER_NUMBER_PER_DAY,
    },
    server: { key: 'texts-server-day', window_ms: DAY_MS, max: settings.max_texts_per_day },
  };
}

/** Why a text over a day's limit was not sent, and when texts start again. */
export function dayLimitWords({
  limits,
  refused,
}: {
  limits: ReturnType<typeof deliveryTextLimits>;
  refused: LimitRefusal;
}): string {
  const reached =
    refused.limit === limits.number
      ? `Your number had ${String(MAX_TEXTS_PER_NUMBER_PER_DAY)} texts today, the most for one number, so no text was sent.`
      : refused.limit === limits.server
        ? 'This server sent the most texts it may send in one day, so no text was sent.'
        : `You had ${String(MAX_TEXTS_PER_PERSON_PER_DAY)} texts today, the most for one day, so no text was sent.`;
  return `${reached} Texts start again in ${waitWords(refused.retry_in_minutes)}.`;
}

export function testTextLimit(owner: PersonOwner): TextLimit {
  return { key: ownerLimitKey({ scope: 'test-text', owner }), window_ms: HOUR_MS, max: MAX_TEST_TEXTS_PER_HOUR };
}

function refused({
  limit,
  window_started_at,
  at,
}: {
  limit: TextLimit;
  window_started_at: string;
  at: Date;
}): LimitRefusal {
  const waited = at.getTime() - new Date(window_started_at).getTime();
  return { ok: false, limit, retry_in_minutes: Math.max(1, Math.ceil((limit.window_ms - waited) / 60_000)) };
}

/**
 * Counts one send against each limit in turn, each in one statement before anything is sent, so neither parallel
 * requests nor a failing provider get past a limit. A limit already passed when a later one refuses stays spent, so
 * the limit everyone shares goes last.
 */
export async function claimTextLimits({
  store,
  limits,
  at,
}: {
  store: Pick<ITextContactStore, 'claimTextSend' | 'forgetTextSends'>;
  limits: readonly TextLimit[];
  at: Date;
}): Promise<LimitResult> {
  await store.forgetTextSends({ before: new Date(at.getTime() - DAY_MS) });
  for (const limit of limits) {
    const claim = await store.claimTextSend({ ...limit, now: at });
    if (!claim.ok) {
      return refused({ limit, window_started_at: claim.window_started_at, at });
    }
  }
  return { ok: true };
}

/** Whether every limit has room for one more send, counting nothing. The claim made when sending still decides. */
export async function textLimitsRoom({
  store,
  limits,
  at,
}: {
  store: Pick<ITextContactStore, 'textSendRoom'>;
  limits: readonly TextLimit[];
  at: Date;
}): Promise<LimitResult> {
  for (const limit of limits) {
    const room = await store.textSendRoom({ ...limit, now: at });
    if (!room.ok) {
      return refused({ limit, window_started_at: room.window_started_at, at });
    }
  }
  return { ok: true };
}

/** How long to wait, in words: minutes under two hours, whole hours after that. */
export function waitWords(minutes: number): string {
  if (minutes < 120) {
    return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  }
  return `about ${String(Math.round(minutes / 60))} hours`;
}
