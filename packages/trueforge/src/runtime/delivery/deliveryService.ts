import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { CreateDeliveryInput, IDeliveryStore } from '../../db/deliveryStore';
import type { PersonOwner } from '../../db/personOwner';
import type { Delivery, DeliveryAttempt } from '../../schemas/deliveries';
import type { DeliveryChannelSender } from './deliveryChannel';

/** The one door into the feed: makes the delivery, tries each channel, and writes every step to Activity. */
export interface DeliveryService {
  deliver(input: CreateDeliveryInput): Promise<Delivery>;
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

function conversationOf(delivery: Delivery): string {
  const link = delivery.link;
  return link !== null && 'session_id' in link ? link.session_id : '';
}

function outcomeWords(attempt: DeliveryAttempt): string {
  const tried =
    attempt.channel === 'web_push' ? 'a push notice' : attempt.channel === 'telegram' ? 'Telegram' : 'the app';
  const base = `Tried ${tried}: ${attempt.outcome}.`;
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

  async function send({ owner, created }: { owner: PersonOwner; created: Delivery }): Promise<Delivery> {
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
      try {
        attempts.push(...(await sender.send({ delivery: created, ...owner })));
      } catch (error) {
        logger.warn('A delivery channel failed', {
          delivery_id: created.id,
          error: error instanceof Error ? error.message : String(error),
        });
        attempts.push({
          channel: sender.channel,
          outcome: 'failed',
          detail: 'The notice could not be sent. It is still in your feed.',
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
    async deliver(input) {
      return await send({ owner: ownerOf(input), created: await store.create(input) });
    },
    async deliverOnce(input) {
      const { delivery, created } = await store.createOnce(input);
      // Sending again can repeat a notice that went out just before a crash, which is better than losing it.
      return created || delivery.attempts.length === 0
        ? await send({ owner: ownerOf(input), created: delivery })
        : delivery;
    },
  };
}
