import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import type { DeliveryAttempt } from '../../schemas/deliveries';
import type { DeliveryChannelSender } from '../delivery/deliveryChannel';
import { assistantNameFor } from './assistantName';
import { smsFailureWords, type SmsProvider } from './smsProvider';
import { canText, type TextNumberService } from './textNumber';
import { TEXTS_NOT_SET_UP, textBody } from './textWords';

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

/**
 * Texts a nudge to the person's confirmed number, only while they have texts switched on. A new install has none of
 * that, so it texts no one. A note stays in the app. Nothing is sent to a number that was not confirmed.
 */
export function createSmsSender({
  contacts,
  reachSettings,
  personalization,
  provider,
  textNumbers,
  now = () => new Date(),
}: {
  contacts: Pick<ITextContactStore, 'get'>;
  reachSettings: Pick<IReachSettingsStore, 'get'>;
  personalization: Pick<IPersonalizationStore, 'getProfile'>;
  /** Undefined when this server has no text provider. */
  provider: SmsProvider | undefined;
  textNumbers: Pick<TextNumberService, 'stopNumber'>;
  now?: () => Date;
}): DeliveryChannelSender {
  return {
    channel: 'sms',
    async send({ delivery, tenant_id, created_by }) {
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
      const name = await assistantNameFor({ personalization, owner });
      const result = await provider.send({ to: contact.phone, body: textBody({ name, delivery, mode: contact.mode }) });
      const words = contact.mode === 'full' ? 'Full text.' : 'Private text: only the kind of thing was sent.';
      if (result.outcome === 'sent') {
        return [attempt({ outcome: 'sent', detail: words, target, at: now() })];
      }
      if (result.failure === 'opted_out') {
        await textNumbers.stopNumber(contact.phone);
      }
      return [attempt({ outcome: 'failed', detail: smsFailureWords(result.failure), target, at: now() })];
    },
  };
}
