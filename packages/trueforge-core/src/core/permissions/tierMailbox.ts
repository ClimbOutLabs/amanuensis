import { z } from '@hono/zod-openapi';

import { mailboxOf } from '../email/gmail/mailbox.js';

/** One recipient of an email: the name shown for it, or empty, and the address that mail goes to. */
export const Tier3MailboxSchema = z
  .object({
    name: z.string().describe('Display name of the recipient, or an empty string when it has none.'),
    address: z.string().describe('Email address the message is delivered to.'),
  })
  .describe('One email recipient: its name and its address.')
  .openapi('Tier3Mailbox');

export type Tier3Mailbox = z.infer<typeof Tier3MailboxSchema>;

/**
 * A recipient as an approval card may hold it: the name-and-address form, or a bare address string from before
 * names were kept. Only the first is written; the second is read as a recipient with no name.
 */
export const StoredMailboxSchema = z.union([Tier3MailboxSchema, z.string().transform(address => mailboxOf(address))]);

/** A stored recipient read in the name-and-address form, or undefined when it reads as neither shape. */
export function readStoredMailbox(value: unknown): Tier3Mailbox | undefined {
  const parsed = StoredMailboxSchema.safeParse(value);
  return parsed.success ? parsed.data : undefined;
}

/** One recipient as `Name (address)`, or the bare address when it has no name. `escape` is applied to each part. */
export function mailboxText(mailbox: Tier3Mailbox, options: { escape: (text: string) => string }): string {
  const address = options.escape(mailbox.address);
  return mailbox.name === '' ? address : `${options.escape(mailbox.name)} (${address})`;
}
