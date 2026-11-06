import type { Delivery, DeliveryAttempt, DeliveryChannel } from '../../schemas/deliveries';

/**
 * One way a delivery can reach a person beyond the feed. A later part adds a sender for a new channel without
 * touching the service. A sender never throws: a failure is returned as an attempt with the outcome `failed`.
 */
export interface DeliveryChannelSender {
  /** The channel this sender delivers on, so a failure it reports is recorded under its own name. */
  readonly channel: DeliveryChannel;
  send(input: { delivery: Delivery; tenant_id: string; created_by: string }): Promise<DeliveryAttempt[]>;
}
