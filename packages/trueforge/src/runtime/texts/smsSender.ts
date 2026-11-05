import type { IPersonalizationStore } from '../../db/personalizationStore';
import type { IReachSettingsStore } from '../../db/reachSettingsStore';
import type { ITextContactStore } from '../../db/textContactStore';
import type { Delivery, DeliveryAttempt, DeliveryKind } from '../../schemas/deliveries';
import type { TextMode } from '../../schemas/textMessages';
import type { DeliveryChannelSender } from '../delivery/deliveryChannel';
import { assistantNameFor } from './assistantName';
import { smsFailureWords, type SmsProvider } from './smsProvider';
import { canText, type TextNumberService } from './textNumber';

/** About two text segments. A longer message is cut at a word and ends with an ellipsis. */
const FULL_TEXT_MAX = 300;

/**
 * What a Private text says: only the kind of thing. It never carries a name, an amount or any content, because a
 * text can show on a locked screen and travels through the phone company.
 */
export function privatePhrase(kind: DeliveryKind): string {
  switch (kind) {
    case 'reminder':
      return 'a reminder is due';
    case 'note':
      return 'a note is waiting';
    case 'nudge':
      return 'something needs you';
    case 'approval_waiting':
      return 'something is waiting for your ok';
  }
}

function cut(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= FULL_TEXT_MAX) {
    return flat;
  }
  const head = flat.slice(0, FULL_TEXT_MAX - 1);
  const space = head.lastIndexOf(' ');
  return `${(space > FULL_TEXT_MAX / 2 ? head.slice(0, space) : head).trimEnd()}…`;
}

/** The text that goes out for a delivery. The assistant's name comes from the person's own settings. */
export function textBody({ name, delivery, mode }: { name: string; delivery: Delivery; mode: TextMode }): string {
  if (mode === 'full') {
    return `${name}: ${cut(delivery.text)}`;
  }
  return `${name}: ${privatePhrase(delivery.kind)}. Open Aman to see it.`;
}

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
            detail: 'Texts are not set up on this server. Add the Twilio settings and restart Aman.',
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
