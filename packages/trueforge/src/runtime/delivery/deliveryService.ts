import type { AuditLogWriter } from '@truefoundry/trueforge-core/core';
import type { Logger } from 'winston';

import type { CreateDeliveryInput, IDeliveryStore } from '../../db/deliveryStore';
import type { PersonOwner } from '../../db/personOwner';
import type { Delivery, DeliveryAttempt, DeliveryChannel } from '../../schemas/deliveries';
import type { DeliveryChannelSender } from './deliveryChannel';

/** The one door into the feed: makes the delivery, tries each channel, and writes every step to Activity. */
export interface DeliveryService {
  /** `only_channels` limits which senders are tried, such as a test of one channel. The app itself always gets it. */
  deliver(input: CreateDeliveryInput & { only_channels?: readonly DeliveryChannel[] }): Promise<Delivery>;
  /**
   * Sends an existing delivery again, as a nudge, through only these channels: what a call that was not answered
   * falls back to. Each attempt is recorded on the delivery and in Activity.
   */
  fallBack(
    input: PersonOwner & { delivery_id: string; channels: readonly DeliveryChannel[] },
  ): Promise<DeliveryAttempt[]>;
  /** Records an attempt that finished later, such as how a call ended, on its delivery and in Activity. */
  recordAttempt(
    input: PersonOwner & {
      delivery_id: string;
      attempt: DeliveryAttempt;
      /** The chat the attempt belongs to in Activity, when it is not the delivery's own link. */
      conversation_id?: string;
    },
  ): Promise<void>;
  /** Delivers once per id: a later call with the same id sends nothing and resolves to the delivery made first. */
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
  call: 'a phone call',
};

/** What failed, when a sender broke before it could say so itself. */
const FAILED_WORDS: Record<DeliveryChannel, string> = {
  in_app: 'The notice could not be added.',
  web_push: 'The push notice could not be sent.',
  sms: 'The text could not be sent.',
  call: 'The call could not be made.',
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
    conversation_id,
  }: {
    owner: { tenant_id: string; created_by: string };
    delivery: Delivery;
    tool_name: string;
    description: string;
    conversation_id?: string | undefined;
  }): Promise<void> {
    try {
      await audit.record({
        ...owner,
        conversation_id: conversation_id ?? conversationOf(delivery),
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

  /** Runs one sender. A sender that breaks is written down as a failed attempt on its own channel. */
  async function trySender({
    sender,
    delivery,
    owner,
  }: {
    sender: DeliveryChannelSender;
    delivery: Delivery;
    owner: PersonOwner;
  }): Promise<DeliveryAttempt[]> {
    try {
      return await sender.send({ delivery, ...owner });
    } catch (error) {
      logger.warn('A delivery channel failed', {
        delivery_id: delivery.id,
        error: error instanceof Error ? error.message : String(error),
      });
      return [
        {
          channel: sender.channel,
          outcome: 'failed',
          detail: `${FAILED_WORDS[sender.channel]} It is still in your feed.`,
          target: null,
          attempted_at: now().toISOString(),
        },
      ];
    }
  }

  /** Tries each sender in turn and writes each attempt down as it happens, then any fallback it asks for. */
  async function sendThrough({
    delivery,
    owner,
    channels,
  }: {
    delivery: Delivery;
    owner: PersonOwner;
    channels: readonly DeliveryChannel[] | undefined;
  }): Promise<DeliveryAttempt[]> {
    const attempts: DeliveryAttempt[] = [];
    for (const sender of senders) {
      if (channels !== undefined && !channels.includes(sender.channel)) {
        continue;
      }
      const made = await trySender({ sender, delivery, owner });
      for (const attempt of made) {
        await keep({ owner, delivery, attempt });
      }
      attempts.push(...made);
      if (sender.fallsBackTo !== undefined && made.some(attempt => attempt.outcome !== 'sent')) {
        attempts.push(
          ...(await sendThrough({ delivery: { ...delivery, level: 'nudge' }, owner, channels: sender.fallsBackTo })),
        );
      }
    }
    return attempts;
  }

  async function keep({
    owner,
    delivery,
    attempt,
    conversation_id,
  }: {
    owner: PersonOwner;
    delivery: Delivery;
    attempt: DeliveryAttempt;
    conversation_id?: string | undefined;
  }): Promise<void> {
    await store.recordAttempt({ ...owner, delivery_id: delivery.id, attempt });
    if (attempt.channel !== 'in_app') {
      await record({
        owner,
        delivery,
        tool_name: channelToolName(attempt),
        description: outcomeWords(attempt),
        conversation_id,
      });
    }
  }

  async function send({
    owner,
    created,
    only_channels,
  }: {
    owner: PersonOwner;
    created: Delivery;
    only_channels: readonly DeliveryChannel[] | undefined;
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
    await keep({ owner, delivery: created, attempt: inApp });
    const attempts = [inApp, ...(await sendThrough({ delivery: created, owner, channels: only_channels }))];
    return (await store.get({ ...owner, id: created.id })) ?? { ...created, attempts };
  }

  return {
    async deliver({ only_channels, ...input }) {
      return await send({ owner: ownerOf(input), created: await store.create(input), only_channels });
    },
    async deliverOnce(input) {
      const { delivery, created } = await store.createOnce(input);
      return created ? await send({ owner: ownerOf(input), created: delivery, only_channels: undefined }) : delivery;
    },
    async fallBack({ delivery_id, channels, ...owner }) {
      const delivery = await store.get({ ...owner, id: delivery_id });
      if (delivery === undefined) {
        return [];
      }
      return sendThrough({ delivery: { ...delivery, level: 'nudge' }, owner, channels });
    },
    async recordAttempt({ delivery_id, attempt, conversation_id, ...owner }) {
      const delivery = await store.get({ ...owner, id: delivery_id });
      if (delivery === undefined) {
        return;
      }
      await keep({ owner, delivery, attempt, conversation_id });
    },
  };
}
