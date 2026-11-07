import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { CreateDeliveryInput, IDeliveryStore } from '../../db/deliveryStore';
import type { PersonOwner } from '../../db/personOwner';
import type { Delivery, DeliveryAttempt, DeliveryChannel } from '../../schemas/deliveries';
import type { DeliveryChannelSender } from './deliveryChannel';

/** The one door into the feed: makes the delivery, tries each channel, and writes every step to Activity. */
export interface DeliveryService {
  /**
   * `test` makes this a Try it test of one channel: only that channel's sender is tried, and it is told the delivery
   * is a test. The app itself always gets it. A text sender lets only the fixed test words through in Full.
   */
  deliver(input: CreateDeliveryInput & { test?: DeliveryChannel }): Promise<Delivery>;
  /**
   * Delivers once per id: a later call with the same id resolves to the delivery made first. It sends again only when
   * that delivery has no attempt written down, because the call that made it stopped before its sends were recorded.
   */
  deliverOnce(input: CreateDeliveryInput & { id: string }): Promise<Delivery>;
}

export const DELIVERY_CREATED_TOOL_NAME = 'delivery.created';

function channelToolName(attempt: DeliveryAttempt): string {
  return `delivery.${attempt.channel}`;
}

const CHANNEL_WORDS: Record<DeliveryChannel, string> = {
  in_app: 'the app',
  web_push: 'a push notice',
  sms: 'a text message',
};

function conversationOf(delivery: Delivery): string {
  const link = delivery.link;
  return link !== null && 'session_id' in link ? link.session_id : '';
}

function outcomeWords(attempt: DeliveryAttempt): string {
  const base = `Tried ${CHANNEL_WORDS[attempt.channel]}: ${attempt.outcome}.`;
  return attempt.detail === null ? base : `${base} ${attempt.detail}`;
}

function ownerOf(input: PersonOwner): PersonOwner {
  return { tenant_id: input.tenant_id, created_by: input.created_by };
}

export function createDeliveryService({
  store,
  senders,
  audit,
  logger,
  now = () => new Date(),
}: {
  store: IDeliveryStore;
  senders: readonly DeliveryChannelSender[];
  audit: AuditLogWriter;
  logger: Logger;
  now?: () => Date;
}): DeliveryService {
  async function record({
    owner,
    delivery,
    tool_name,
    description,
  }: {
    owner: { tenant_id: string; created_by: string };
    delivery: Delivery;
    tool_name: string;
    description: string;
  }): Promise<void> {
    try {
      await audit.record({
        ...owner,
        conversation_id: conversationOf(delivery),
        tier: 1,
        tool_name,
        description,
        outcome: 'logged',
        auto_deny_reason: null,
      });
    } catch (error) {
      // The activity log being unavailable never changes a delivery.
      logger.warn('Could not record a delivery in the activity log', {
        delivery_id: delivery.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function send({
    owner,
    created,
    test,
  }: {
    owner: PersonOwner;
    created: Delivery;
    test: DeliveryChannel | undefined;
  }): Promise<Delivery> {
    await record({
      owner,
      delivery: created,
      tool_name: DELIVERY_CREATED_TOOL_NAME,
      description: `${created.text} Why you got this: ${created.reason}`,
    });
    const inApp: DeliveryAttempt = {
      channel: 'in_app',
      outcome: 'sent',
      detail: null,
      target: null,
      attempted_at: now().toISOString(),
    };
    const attempts: DeliveryAttempt[] = [inApp];
    for (const sender of senders) {
      if (test !== undefined && test !== sender.channel) {
        continue;
      }
      try {
        attempts.push(...(await sender.send({ delivery: created, ...owner, test: test !== undefined })));
      } catch (error) {
        logger.warn('A delivery channel failed', {
          delivery_id: created.id,
          error: error instanceof Error ? error.message : String(error),
        });
        attempts.push({
          channel: sender.channel,
          outcome: 'failed',
          detail:
            sender.channel === 'sms'
              ? 'The text could not be sent. The item is still in your feed.'
              : 'The notice could not be sent. It is still in your feed.',
          target: null,
          attempted_at: now().toISOString(),
        });
      }
    }
    for (const attempt of attempts) {
      await store.recordAttempt({ ...owner, delivery_id: created.id, attempt });
      if (attempt.channel !== 'in_app') {
        await record({
          owner,
          delivery: created,
          tool_name: channelToolName(attempt),
          description: outcomeWords(attempt),
        });
      }
    }
    return (await store.get({ ...owner, id: created.id })) ?? { ...created, attempts };
  }

  return {
    async deliver({ test, ...input }) {
      return await send({ owner: ownerOf(input), created: await store.create(input), test });
    },
    async deliverOnce(input) {
      const { delivery, created } = await store.createOnce(input);
      // Sending again can repeat a notice that went out just before a crash, which is better than losing it.
      return created || delivery.attempts.length === 0
        ? await send({ owner: ownerOf(input), created: delivery, test: undefined })
        : delivery;
    },
  };
}
