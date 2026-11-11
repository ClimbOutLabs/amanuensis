import type { Delivery, DeliveryAttempt, DeliveryChannel } from '../../schemas/deliveries';

/** The words of every Try it test, the only words a test may send in Full. One sentence, so the dot rule never holds it back. */
export const TEST_WORDS = 'This is a test, and it works if you can read this.';

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
