import type { ITelegramStore } from '../../db/telegramStore';
import type { Delivery, DeliveryAttempt } from '../../schemas/deliveries';
import { sendTelegramText, type TelegramSendQueue } from '../telegram/telegramSendQueue';
import type { TelegramService } from '../telegram/telegramService';
import type { DeliveryChannelSender } from './deliveryChannel';

/**
 * The Telegram channel of the delivery feed: a nudge is also sent to the paired Telegram chat,
 * as its own text. A note stays in the app, and a call reaches Telegram only as the nudge it
 * falls back to when the phone did not ring, as it does for texts and push. No
 * connection, or a bot not paired yet, means no attempt: there is nobody it could reach. The
 * full item always stays in the feed; for an approval the message says to open Aman, where the
 * card itself lives. Sends go through the queue and are attempted once, never retried blindly.
 */
export function createTelegramSender({
  store,
  service,
  queue,
  now = () => new Date(),
}: {
  store: ITelegramStore;
  service: TelegramService;
  queue: TelegramSendQueue;
  now?: () => Date;
}): DeliveryChannelSender {
  function attempt(input: {
    outcome: DeliveryAttempt['outcome'];
    detail: string | null;
    target: string | null;
  }): DeliveryAttempt {
    return { channel: 'telegram', ...input, attempted_at: now().toISOString() };
  }

  return {
    channel: 'telegram',
    async send({ delivery, tenant_id, created_by }) {
      if (delivery.level !== 'nudge') {
        return [];
      }
      const connection = await store.getConnection({ tenant_id, created_by });
      if (connection === undefined) {
        return [];
      }
      if (connection.paired_chat_id === null) {
        return [];
      }
      try {
        await sendTelegramText({
          queue,
          client: service.clientFor(connection),
          chat_id: connection.paired_chat_id,
          text: telegramDeliveryText(delivery),
        });
        return [attempt({ outcome: 'sent', detail: null, target: connection.paired_chat_id })];
      } catch {
        return [
          attempt({
            outcome: 'failed',
            detail: 'The Telegram message could not be sent. The item is still in your feed.',
            target: connection.paired_chat_id,
          }),
        ];
      }
    },
  };
}

/** The text a delivery carries to Telegram: its own words, and a pointer to the app for an approval. */
export function telegramDeliveryText(delivery: Delivery): string {
  return delivery.kind === 'approval_waiting' ? `${delivery.text}\nOpen Aman to answer it.` : delivery.text;
}
