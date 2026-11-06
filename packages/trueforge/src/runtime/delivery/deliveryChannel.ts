import type { Delivery, DeliveryAttempt, DeliveryChannel } from '../../schemas/deliveries';

/**
 * One way a delivery can reach a person beyond the feed. A later part adds a sender for a new channel without
 * touching the service. A sender never throws: a failure is returned as an attempt with the outcome `failed`.
 */
export interface DeliveryChannelSender {
  /** The channel its attempts are recorded under, including when it fails before it can say so itself. */
  readonly channel: DeliveryChannel;
  /** `test` is true for a Try it test of this channel. */
  send(input: { delivery: Delivery; tenant_id: string; created_by: string; test: boolean }): Promise<DeliveryAttempt[]>;
}
