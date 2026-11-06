import type { Delivery, DeliveryAttempt } from '../../schemas/deliveries';

/**
 * One way a delivery can reach a person beyond the feed. A later part adds a sender for a new channel without
 * touching the service. A sender never throws: a failure is returned as an attempt with the outcome `failed`.
 */
export interface DeliveryChannelSender {
  /** `notice_text` is what a notice outside the app may say. A sender never puts the delivery's `text` there. */
  send(input: {
    delivery: Delivery;
    notice_text: string;
    tenant_id: string;
    created_by: string;
  }): Promise<DeliveryAttempt[]>;
}
