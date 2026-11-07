import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import type { DeliveryAttempt } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';
import type { DeliveryChannelSender } from '../delivery/deliveryChannel';
import { assistantNameFor } from './assistantName';
import { smsFailureWords, type SmsProvider } from './smsProvider';
import {
  claimTextLimits,
  dayLimitWords,
  deliveryTextLimits,
  testLimitWords,
  testTextLimit,
  type DeliveryLimitSettings,
} from './textLimits';
import { canText, type TextNumberService } from './textNumber';
import { textBody, TEXTS_NOT_SET_UP, type FullWithheld } from './textWords';

/** How a number is named in Activity: by its last four digits only. */
export function maskedTarget(phone: string): string {
  return `number ending ${phone.slice(-4)}`;
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
  return { channel: 'sms', outcome, detail, target, attempted_at: at.toISOString() };
}

function sentWords({ mode, withheld }: { mode: TextMode; withheld: FullWithheld }): string {
  switch (withheld) {
    case 'noticed':
      return 'Private text: what your assistant noticed is shown only in the app, so only the kind of thing was sent.';
    case 'not_plain_words':
      return 'Private text: a Full text carries only words, times and dates. This message had other numbers or signs, so only the kind of thing was sent. To see it, open the app.';
    case null:
      return mode === 'full' ? 'Full text.' : 'Private text: only the kind of thing was sent.';
  }
}

/**
 * Texts a nudge to the person's confirmed number, only while they have texts switched on. A new install has none of
 * that, so it texts no one. A note stays in the app. Nothing is sent to a number that was not confirmed. Every text,
 * reminders and tests included, counts toward a day's limit for the person, the number and the server before it is sent,
 * and a test also toward the Try it button's own limit, all in one claim.
 */
export function createSmsSender({
  contacts,
  reachSettings,
  personalization,
  provider,
  limits,
  textNumbers,
  now = () => new Date(),
}: {
  contacts: Pick<ITextContactStore, 'get' | 'claimTextSends' | 'forgetTextSends'>;
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  /** Undefined when this server has no text provider. */
  provider: SmsProvider | undefined;
  /** Undefined, like the provider, when this server has no text provider. */
  limits: DeliveryLimitSettings | undefined;
  textNumbers: Pick<TextNumberService, 'stopNumber'>;
  now?: () => Date;
}): DeliveryChannelSender {
  return {
    channel: 'sms',
    async send({ delivery, tenant_id, created_by, test }) {
      if (delivery.level !== 'nudge') {
        return [];
      }
      const owner = { tenant_id, created_by };
      const settings = await reachSettings.get(owner);
      if (settings?.channels.texts !== true) {
        return [];
      }
      const contact = await contacts.get(owner);
      if (!canText(contact)) {
        return [
          attempt({
            outcome: 'skipped',
            detail: 'Your number is not confirmed, so no text was sent. Confirm it in Settings, Reach me.',
            target: null,
            at: now(),
          }),
        ];
      }
      const target = maskedTarget(contact.phone);
      if (provider === undefined || limits === undefined) {
        return [
          attempt({
            outcome: 'skipped',
            detail: TEXTS_NOT_SET_UP,
            target,
            at: now(),
          }),
        ];
      }
      const at = now();
      const day = deliveryTextLimits({ owner, phone: contact.phone, settings: limits });
      const tried = testTextLimit(owner);
      const claim = await claimTextLimits({
        store: contacts,
        limits: test ? [day.person, day.number, day.server, tried] : [day.person, day.number, day.server],
        at,
      });
      if (!claim.ok) {
        const detail =
          claim.limit === tried
            ? testLimitWords(claim)
            : test
              ? dayLimitWords({ limits: day, refused: claim })
              : `${dayLimitWords({ limits: day, refused: claim })} Until then, see new items in the app.`;
        return [attempt({ outcome: 'skipped', detail, target, at })];
      }
      const name = await assistantNameFor({ personalization, owner });
      const { body, withheld } = textBody({ name, delivery, mode: contact.mode, test });
      const result = await provider.send({ to: contact.phone, body });
      if (result.outcome === 'sent') {
        return [attempt({ outcome: 'sent', detail: sentWords({ mode: contact.mode, withheld }), target, at: now() })];
      }
      if (result.failure === 'opted_out') {
        await textNumbers.stopNumber(contact.phone);
      }
      return [
        attempt({
          outcome: 'failed',
          detail: smsFailureWords({ failure: result.failure, during: 'delivery' }),
          target,
          at: now(),
        }),
      ];
    },
  };
}
