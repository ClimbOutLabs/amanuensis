import { createHmac } from 'node:crypto';

import type { PersonOwner } from '../../db/personOwner';
import type { ITextContactStore, TextSendLimit } from '../../db/textContactStore';

export const HOUR_MS = 60 * 60_000;
/** The longest window of any limit, so old counts can be forgotten without ending a window that is still open. */
export const DAY_MS = 24 * HOUR_MS;

/** Codes sent in one hour for one person, whatever number they ask for, so the page cannot be used to text strangers. */
export const MAX_CODES_PER_HOUR = 3;
/** Codes sent in a day for one person, below the server's cap, so one account cannot use up everyone's codes. */
export const MAX_CODES_PER_PERSON_PER_DAY = 10;
/** Codes sent to one number, whoever asks, so many people together cannot flood it either. */
export const MAX_CODES_PER_NUMBER_PER_HOUR = 3;
export const MAX_CODES_PER_NUMBER_PER_DAY = 10;
/** Codes sent by the whole server in a day, so many accounts together cannot run up the bill. */
export const MAX_CODES_PER_SERVER_PER_DAY = 50;
/** Texts a day to one person from deliveries of every kind, reminders and tests included, so a loop cannot run up the bill. */
export const MAX_TEXTS_PER_PERSON_PER_DAY = 30;
/** Texts a day to one number, however many people confirmed it. */
export const MAX_TEXTS_PER_NUMBER_PER_DAY = 30;
/** Test texts an hour from the Try it button. */
export const MAX_TEST_TEXTS_PER_HOUR = 3;

/** What the delivery limits need from the server: the secret that keys number counts, and the server's day cap. */
export interface DeliveryLimitSettings {
  number_key: string;
  max_texts_per_day: number;
}

/** The limits one delivery text counts against, all claimed together. */
export interface DeliveryTextLimits {
  person: TextSendLimit;
  number: TextSendLimit;
  server: TextSendLimit;
}

interface LimitRefusal {
  ok: false;
  limit: TextSendLimit;
  retry_in_minutes: number;
}
/** Refused, it names the limit that refused and how long until that limit has room. */
type LimitResult = { ok: true } | LimitRefusal;

/** Each family of limits, codes, delivery texts and tests, keeps its keys under its own prefix. */
type LimitFamily = 'code' | 'text' | 'test';
type LimitWindow = 'hour' | 'day';

function personKey({
  family,
  window,
  owner,
}: {
  family: LimitFamily;
  window: LimitWindow;
  owner: PersonOwner;
}): string {
  return `${family}:person-${window}:${JSON.stringify([owner.tenant_id, owner.created_by])}`;
}

/**
 * Country codes whose numbers are dialled at home with a 0 in front, which people often type after the code as well.
 * Country codes never begin one another, so a match here is the number's whole country code.
 */
// prettier-ignore
const TRUNK_ZERO_CODES = new Set([
  '20', '27', '31', '32', '33', '41', '43', '44', '46', '49', '51', '54', '55', '60', '61', '62', '63', '64', '66',
  '81', '82', '84', '86', '90', '91', '92', '93', '94', '98', '212', '213', '234', '254', '255', '256', '353', '358',
  '380', '880', '886', '966', '971', '972',
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

/** A number's key, keyed with a server secret so the count table never holds the number itself. */
function numberKey({
  family,
  window,
  secret,
  phone,
}: {
  family: LimitFamily;
  window: LimitWindow;
  secret: string;
  phone: string;
}): string {
  const number = createHmac('sha256', secret)
    .update(`number\u0000${limitNumber(phone)}`)
    .digest('hex');
  return `${family}:number-${window}:${number}`;
}

/**
 * The limits one code send counts against: the person by the hour and by the day, the number by the hour and by the
 * day, and the whole server. The number limits are kept by whoever asks, so the page cannot be used to text
 * strangers, but they and the server's day do not hold back the person who confirmed that number.
 */
export function codeTextLimits({
  secret,
  owner,
  phone,
  confirmed_by_owner,
}: {
  secret: string;
  owner: PersonOwner;
  phone: string;
  /** The person asking already confirmed this very number. */
  confirmed_by_owner: boolean;
}): TextSendLimit[] {
  const person: TextSendLimit[] = [
    { key: personKey({ family: 'code', window: 'hour', owner }), window_ms: HOUR_MS, max: MAX_CODES_PER_HOUR },
    { key: personKey({ family: 'code', window: 'day', owner }), window_ms: DAY_MS, max: MAX_CODES_PER_PERSON_PER_DAY },
  ];
  if (confirmed_by_owner) {
    return person;
  }
  return [
    ...person,
    {
      key: numberKey({ family: 'code', window: 'hour', secret, phone }),
      window_ms: HOUR_MS,
      max: MAX_CODES_PER_NUMBER_PER_HOUR,
    },
    {
      key: numberKey({ family: 'code', window: 'day', secret, phone }),
      window_ms: DAY_MS,
      max: MAX_CODES_PER_NUMBER_PER_DAY,
    },
    { key: 'code:server-day', window_ms: DAY_MS, max: MAX_CODES_PER_SERVER_PER_DAY },
  ];
}

/** The limits one delivery text counts against: the person, the number and the whole server. */
export function deliveryTextLimits({
  owner,
  phone,
  settings,
}: {
  owner: PersonOwner;
  phone: string;
  settings: DeliveryLimitSettings;
}): DeliveryTextLimits {
  return {
    person: {
      key: personKey({ family: 'text', window: 'day', owner }),
      window_ms: DAY_MS,
      max: MAX_TEXTS_PER_PERSON_PER_DAY,
    },
    number: {
      key: numberKey({ family: 'text', window: 'day', secret: settings.number_key, phone }),
      window_ms: DAY_MS,
      max: MAX_TEXTS_PER_NUMBER_PER_DAY,
    },
    server: { key: 'text:server-day', window_ms: DAY_MS, max: settings.max_texts_per_day },
  };
}

/** Why a text over a day's limit was not sent, and when texts start again. */
export function dayLimitWords({ limits, refused }: { limits: DeliveryTextLimits; refused: LimitRefusal }): string {
  const reached =
    refused.limit === limits.number
      ? `This number had ${String(MAX_TEXTS_PER_NUMBER_PER_DAY)} texts today, the most for one number, so no text was sent.`
      : refused.limit === limits.server
        ? 'This server sent the most texts it may send in one day, so no text was sent.'
        : `You had ${String(MAX_TEXTS_PER_PERSON_PER_DAY)} texts today, the most for one day, so no text was sent.`;
  return `${reached} Texts start again in ${waitWords(refused.retry_in_minutes)}.`;
}

/** Why a Try it text was not sent, when the button's own hourly limit was reached. */
export function testLimitWords(refused: LimitRefusal): string {
  return `That was ${String(MAX_TEST_TEXTS_PER_HOUR)} test texts this hour. Wait ${waitWords(refused.retry_in_minutes)}, then try again.`;
}

/** Each test is a paid text, so the Try it button has a limit of its own on top of the day's limits for every text. */
export function testTextLimit(owner: PersonOwner): TextSendLimit {
  return {
    key: personKey({ family: 'test', window: 'hour', owner }),
    window_ms: HOUR_MS,
    max: MAX_TEST_TEXTS_PER_HOUR,
  };
}

function refused({
  limit,
  window_started_at,
  at,
}: {
  limit: TextSendLimit;
  window_started_at: string;
  at: Date;
}): LimitRefusal {
  const waited = at.getTime() - new Date(window_started_at).getTime();
  return { ok: false, limit, retry_in_minutes: Math.max(1, Math.ceil((limit.window_ms - waited) / 60_000)) };
}

/**
 * Counts one send against every limit, or against none when any of them is full, before anything is sent, so neither
 * parallel requests nor a failing provider get past a limit, and a send one limit refuses spends none of the others.
 */
export async function claimTextLimits({
  store,
  limits,
  at,
}: {
  store: Pick<ITextContactStore, 'claimTextSends' | 'forgetTextSends'>;
  limits: readonly TextSendLimit[];
  at: Date;
}): Promise<LimitResult> {
  await store.forgetTextSends({ before: new Date(at.getTime() - DAY_MS) });
  const claim = await store.claimTextSends({ limits, now: at });
  if (claim.ok) {
    return { ok: true };
  }
  return refused({ limit: claim.refused, window_started_at: claim.window_started_at, at });
}

/** How long to wait, in words: minutes under two hours, whole hours after that. */
export function waitWords(minutes: number): string {
  if (minutes < 120) {
    return minutes === 1 ? '1 minute' : `${String(minutes)} minutes`;
  }
  return `about ${String(Math.round(minutes / 60))} hours`;
}
