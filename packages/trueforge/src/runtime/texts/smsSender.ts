import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import type { DeliveryAttempt } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';
import type { DeliveryChannelSender } from '../delivery/deliveryChannel';
import { assistantNameFor } from './assistantName';
import { smsFailureWords, type SmsProvider } from './smsProvider';
import { claimTextLimits, deliveryTextLimit, MAX_TEXTS_PER_PERSON_PER_DAY, waitWords } from './textLimits';
import { canText, type TextNumberService } from './textNumber';
import { textBody, TEXTS_NOT_SET_UP } from './textWords';

function maskedTarget(phone: string): string {
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

function sentWords({ mode, sent_as }: { mode: TextMode; sent_as: TextMode }): string {
  if (sent_as === 'full') {
    return 'Full text.';
  }
  return mode === 'full'
    ? 'Private text: the message named a link, a phone number or an address, so only the kind of thing was sent.'
    : 'Private text: only the kind of thing was sent.';
}

/**
 * Texts a nudge to the person's confirmed number, only while they have texts switched on. A new install has none of
 * that, so it texts no one. A note stays in the app. Nothing is sent to a number that was not confirmed. Every text,
 * reminders and tests included, counts toward a day's limit for the person before it is sent.
 */
export function createSmsSender({
  contacts,
  reachSettings,
  personalization,
  provider,
  textNumbers,
  now = () => new Date(),
}: {
  contacts: Pick<ITextContactStore, 'get' | 'claimTextSend' | 'forgetTextSends'>;
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  /** Undefined when this server has no text provider. */
  provider: SmsProvider | undefined;
  textNumbers: Pick<TextNumberService, 'stopNumber'>;
  now?: () => Date;
}): DeliveryChannelSender {
  return {
    channel: 'sms',
    async send({ delivery, notice_text, tenant_id, created_by }) {
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
      if (provider === undefined) {
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
      const claim = await claimTextLimits({ store: contacts, limits: [deliveryTextLimit(owner)], at });
      if (!claim.ok) {
        return [
          attempt({
            outcome: 'skipped',
            detail: `You had ${String(MAX_TEXTS_PER_PERSON_PER_DAY)} texts today, the most for one day, so no text was sent. Texts start again in ${waitWords(claim.retry_in_minutes)}. Until then, see new items in the app.`,
            target,
            at,
          }),
        ];
      }
      const name = await assistantNameFor({ personalization, owner });
      const { body, sent_as } = textBody({ name, kind: delivery.kind, notice_text, mode: contact.mode });
      const result = await provider.send({ to: contact.phone, body });
      if (result.outcome === 'sent') {
        return [attempt({ outcome: 'sent', detail: sentWords({ mode: contact.mode, sent_as }), target, at: now() })];
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
